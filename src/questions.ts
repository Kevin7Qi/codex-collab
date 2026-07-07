// src/questions.ts — Ask-channel question mailbox (Codex asks, anyone answers)
//
// The channel duality that shapes everything here: approvals carry
// PERMISSION (blocking, fail-closed — an unapproved action must not run);
// questions carry JUDGMENT (non-blocking, fail-open — an unanswered question
// expires and the asker proceeds on its own). `codex-collab ask` runs INSIDE
// Codex's sandbox as a child of its exec tool, so the mailbox lives in temp
// space (config.resolveMailboxDir), not the workspace state dir.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { isPathInside, mailboxRoot } from "./config";
import type { QuestionRecord } from "./types";

/** Default answer deadline for `ask` (seconds). Kept an order of magnitude
 *  below the default turn timeout so a question can expire gracefully well
 *  before it endangers the turn budget. */
export const DEFAULT_ASK_TIMEOUT_SEC = 600;

/** Poll cadence for both the asker's answer wait and `next`'s event watch —
 *  same 1s rhythm as the approvals decision poll. */
export const QUESTION_POLL_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Marker lines
// ---------------------------------------------------------------------------
// `ask` prints these to stdout. The host-side turn owner sees every byte the
// command prints via item/commandExecution/outputDelta, so the markers are
// how a question gets bound to its thread and run — attribution rides the
// output stream, no host-side dir watching. Durations are integer seconds so
// the host can parse them back; human-friendly text goes on separate lines.

const MARKER_PREFIX = "[codex-collab] question ";

export const QUESTION_MARKER_RE =
  /^\[codex-collab\] question (q[0-9a-f]{7}) (posted \(deadline (\d+)s\)|answered \(after (\d+)s\)|expired \(after (\d+)s\))$/;

export interface QuestionMarker {
  id: string;
  kind: "posted" | "answered" | "expired";
  seconds: number;
}

export function markerPosted(id: string, deadlineSec: number): string {
  return `${MARKER_PREFIX}${id} posted (deadline ${deadlineSec}s)`;
}

export function markerAnswered(id: string, latencySec: number): string {
  return `${MARKER_PREFIX}${id} answered (after ${latencySec}s)`;
}

export function markerExpired(id: string, deadlineSec: number): string {
  return `${MARKER_PREFIX}${id} expired (after ${deadlineSec}s)`;
}

/** Parse a single output line; null when it isn't a question marker. */
export function parseQuestionMarker(line: string): QuestionMarker | null {
  const m = QUESTION_MARKER_RE.exec(line.trimEnd());
  if (!m) return null;
  const kind = m[2].startsWith("posted") ? "posted" : m[2].startsWith("answered") ? "answered" : "expired";
  const seconds = Number(m[3] ?? m[4] ?? m[5]);
  return { id: m[1], kind, seconds };
}

/** True iff a command line looks like it INVOKES `codex-collab ask`, as
 *  opposed to merely mentioning it (grep over docs, echo, a path segment).
 *  `codex-collab` must sit at a command position: start of string, or after
 *  a shell separator (`;`, `&`, `|`, `(`, newline) that is OUTSIDE quotes —
 *  a separator inside a quoted argument (`printf '; codex-collab ask …'`)
 *  is data, and treating it as a command position would let arbitrary
 *  command output feed marker parsing. `sh -c` / `zsh -lc` wrapper payloads
 *  are scanned as command lines in their own right. Bare whitespace is
 *  deliberately NOT a command position — `grep -rh codex-collab ask logs/`
 *  is a mention, and prefix forms like `timeout 600 codex-collab ask` are
 *  accepted false negatives: a miss only degrades run-record enrichment
 *  (the mailbox watchers and `next` see the question file regardless),
 *  while a false positive feeds marker parsing from untrusted output. */
export function looksLikeAskInvocation(command: string): boolean {
  // Wrapper payloads (`-c`/`-lc` string arguments) queue up for their own
  // scan; one level of nesting per payload, no recursion depth to blow.
  const commandLines = [command];
  while (commandLines.length > 0) {
    if (scanCommandLineForAsk(commandLines.pop()!, commandLines)) return true;
  }
  return false;
}

const WORD_BREAK_CHARS = " \t\n\r;&|()<>";

function scanCommandLineForAsk(cmd: string, wrapperPayloads: string[]): boolean {
  let i = 0;
  let atCommandPos = true;   // next word starts a simple command
  let expectAsk = false;     // previous word was command-position `codex-collab`
  let expectPayload = false; // previous word was a `-c`/`-lc` wrapper flag
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === "\n" || ch === "\r") {
      atCommandPos = true;
      expectAsk = false;
      expectPayload = false;
      i++;
      continue;
    }
    if (ch === ")" || ch === "<" || ch === ">") {
      expectAsk = false;
      expectPayload = false;
      i++;
      continue;
    }
    // Read one word, resolving quotes and backslash escapes so quoted
    // separators stay inside the word instead of opening a command position.
    let word = "";
    while (i < cmd.length && !WORD_BREAK_CHARS.includes(cmd[i])) {
      const c = cmd[i];
      if (c === "'") {
        const end = cmd.indexOf("'", i + 1);
        word += end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
        i = end === -1 ? cmd.length : end + 1;
      } else if (c === '"') {
        let j = i + 1;
        while (j < cmd.length && cmd[j] !== '"') {
          if (cmd[j] === "\\" && j + 1 < cmd.length) {
            word += cmd[j + 1];
            j += 2;
          } else {
            word += cmd[j];
            j++;
          }
        }
        i = j < cmd.length ? j + 1 : cmd.length;
      } else if (c === "\\" && i + 1 < cmd.length) {
        word += cmd[i + 1];
        i += 2;
      } else {
        word += c;
        i++;
      }
    }
    if (expectAsk && word === "ask") return true;
    if (expectPayload) wrapperPayloads.push(word);
    expectAsk = atCommandPos && word === "codex-collab";
    expectPayload = /^-l?c$/.test(word);
    atCommandPos = false;
  }
  return false;
}

/** True iff the ask invocation reads its question from stdin (`ask -`) —
 *  the one form whose question text cannot be matched against the command
 *  line. Quote/whitespace-normalized before testing. The dash may follow
 *  options (`ask --timeout 60 -`), so skip leading option/value pairs and
 *  decide on the first positional token: `-` means stdin, anything else is
 *  the question text (quote-stripping merges it into the token stream, so
 *  a dash *inside* the question must not count). Tokens are cut at the
 *  first shell operator so a `-` in a downstream pipe segment can't match.
 *  A boolean flag directly before the dash reads it as the flag's value —
 *  an accepted false negative (enrichment-only cost, like the prefix
 *  wrappers above). */
export function isStdinAskInvocation(command: string): boolean {
  const normalized = command.replace(/[\\'"]/g, "").replace(/\s+/g, " ");
  const match = normalized.match(/codex-collab ask (.*)$/);
  if (!match) return false;
  const tokens = match[1].split(/[;&|()<>]/, 1)[0].trim().split(" ");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length > 1 && token.startsWith("-")) {
      // Option: also skip its value when the next token isn't dash-led.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i++;
      continue;
    }
    return token === "-";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mailbox I/O
// ---------------------------------------------------------------------------

/** `q` + 7 hex chars — visually distinct from 8-hex thread short IDs, and
 *  matches validateId's character set. */
export function generateQuestionId(): string {
  return `q${randomBytes(4).toString("hex").slice(0, 7)}`;
}

export function questionPath(mailboxDir: string, id: string): string {
  return join(mailboxDir, `${id}.json`);
}

export function answerPath(mailboxDir: string, id: string): string {
  return join(mailboxDir, `${id}.answer`);
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/** A directory is trustworthy iff it is a real directory (not a symlink),
 *  owned by this uid, and not group/world-writable. */
function assertPrivateDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${path} is not a real directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return;
  if (st.uid !== uid) {
    throw new Error(`${path} is owned by uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(`${path} is group/world-writable (mode ${(st.mode & 0o777).toString(8)})`);
  }
}

/** Refuse to use a mailbox whose directory chain isn't privately ours. The
 *  root lives at a predictable path in shared temp space, so another local
 *  user could pre-create it before our first use — recursive mkdir accepts
 *  existing ancestors silently, and write access to the directory would let
 *  them forge answer files (a steering channel into Codex). For mailboxes
 *  under the standard root, every level from the root down is verified;
 *  other paths (tests, explicit overrides) verify the mailbox dir itself. */
export function verifyMailboxDir(mailboxDir: string): void {
  if (process.platform === "win32") return; // per-user %TEMP%; POSIX modes don't apply
  const root = mailboxRoot();
  const levels = isPathInside(mailboxDir, root) && mailboxDir !== root
    ? [...new Set([root, dirname(mailboxDir), mailboxDir])]
    : [mailboxDir];
  for (const level of levels) {
    try {
      assertPrivateDir(level);
    } catch (e) {
      throw new Error(
        `ask-channel mailbox is not private — refusing to use it: ${e instanceof Error ? e.message : String(e)}\n` +
        `Remove or fix the directory and retry.`,
      );
    }
  }
}

export function writeQuestion(mailboxDir: string, record: QuestionRecord): void {
  if (!existsSync(mailboxDir)) mkdirSync(mailboxDir, { recursive: true, mode: 0o700 });
  verifyMailboxDir(mailboxDir);
  atomicWrite(questionPath(mailboxDir, record.id), JSON.stringify(record, null, 2));
}

export function loadQuestion(mailboxDir: string, id: string): QuestionRecord | null {
  const filePath = questionPath(mailboxDir, id);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.id !== "string" ||
      typeof parsed.question !== "string" ||
      typeof parsed.askedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    return parsed as QuestionRecord;
  } catch {
    return null;
  }
}

/** Rewrite a question record in place (e.g. to stamp `expired`). */
export function updateQuestion(mailboxDir: string, record: QuestionRecord): void {
  atomicWrite(questionPath(mailboxDir, record.id), JSON.stringify(record, null, 2));
}

/** All question records in a mailbox, oldest first. Corrupt files skipped.
 *  Throws when the mailbox directory chain isn't privately ours — reading
 *  an attacker-controlled mailbox would surface forged questions. */
export function listQuestions(mailboxDir: string): QuestionRecord[] {
  if (!existsSync(mailboxDir)) return [];
  verifyMailboxDir(mailboxDir);
  const records: QuestionRecord[] = [];
  for (const file of readdirSync(mailboxDir)) {
    if (!file.endsWith(".json")) continue;
    const record = loadQuestion(mailboxDir, file.slice(0, -".json".length));
    if (record) records.push(record);
  }
  records.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  return records;
}

/** True iff the asking process is still alive (EPERM counts as alive; a
 *  missing/invalid pid — legacy records — counts as alive so nothing is
 *  wrongly suppressed). PID reuse can produce a false positive, but the
 *  question's own expiry deadline bounds how long that can matter. */
export function isAskerAlive(record: QuestionRecord): boolean {
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return true;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** True iff the question is still awaiting an answer: not stamped expired,
 *  deadline in the future, no answer file yet, and the asking process is
 *  still alive — a run killed or timed out mid-ask leaves an orphaned
 *  question file that nobody can receive an answer to, and advertising it
 *  as pending would invite answers into the void. */
export function isQuestionPending(mailboxDir: string, record: QuestionRecord, now = Date.now()): boolean {
  if (record.expired) return false;
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (existsSync(answerPath(mailboxDir, record.id))) return false;
  return isAskerAlive(record);
}

export function listPendingQuestions(mailboxDir: string, now = Date.now()): QuestionRecord[] {
  return listQuestions(mailboxDir).filter((r) => isQuestionPending(mailboxDir, r, now));
}

export function writeAnswer(mailboxDir: string, id: string, text: string): void {
  atomicWrite(answerPath(mailboxDir, id), text);
}

function answerClaimPath(mailboxDir: string, id: string): string {
  return answerPath(mailboxDir, id) + ".claim";
}

/** Claim and write the answer; returns false when another responder already
 *  claimed it. The claim file is created with O_EXCL so exactly one writer
 *  wins the race (a bare existsSync check is TOCTOU — two responders can
 *  both pass it, and atomicWrite's shared temp name would let the LAST
 *  rename win silently). Content is still published via tmp+rename so the
 *  polling asker never reads a torn file. */
export function writeAnswerExclusive(mailboxDir: string, id: string, text: string): boolean {
  verifyMailboxDir(mailboxDir);
  try {
    writeFileSync(answerClaimPath(mailboxDir, id), String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  atomicWrite(answerPath(mailboxDir, id), text);
  return true;
}

export function readAnswer(mailboxDir: string, id: string): string | null {
  try {
    return readFileSync(answerPath(mailboxDir, id), "utf-8");
  } catch {
    return null;
  }
}

/** Remove a question, its answer file, and the answer claim. ENOENT-tolerant. */
export function removeQuestion(mailboxDir: string, id: string): void {
  for (const filePath of [questionPath(mailboxDir, id), answerPath(mailboxDir, id), answerClaimPath(mailboxDir, id)]) {
    try {
      unlinkSync(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not remove ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** Wait for an answer file, polling at the approvals cadence. Resolves with
 *  the answer text, or null when the deadline lapses — the fail-open path. */
export async function pollForAnswer(
  mailboxDir: string,
  id: string,
  deadlineMs: number,
  pollIntervalMs = QUESTION_POLL_INTERVAL_MS,
): Promise<string | null> {
  while (Date.now() < deadlineMs) {
    const answer = readAnswer(mailboxDir, id);
    if (answer !== null) return answer;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return readAnswer(mailboxDir, id);
}

/** Filenames the mailbox legitimately contains — the sweep must never
 *  delete anything else, even inside a directory that passed verification. */
const MAILBOX_FILE_RE = /^q[0-9a-f]{7}\.(json|answer|answer\.claim)(\.tmp)?$/;

/** Delete mailbox files older than maxAgeMs (mtime). Expired questions are
 *  kept until this sweep so `questions`/post-mortems can still show them.
 *  Returns the number of files deleted. Refuses (with a warning, not an
 *  error — `clean` is best-effort) to sweep a mailbox that fails the
 *  privacy checks: deletion is the one operation where following a planted
 *  symlink does real damage to files outside the mailbox. */
export function sweepQuestions(mailboxDir: string, maxAgeMs: number, now = Date.now()): number {
  if (!existsSync(mailboxDir)) return 0;
  try {
    verifyMailboxDir(mailboxDir);
  } catch (e) {
    console.error(`[codex] Warning: skipping question sweep: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  let deleted = 0;
  for (const file of readdirSync(mailboxDir)) {
    if (!MAILBOX_FILE_RE.test(file)) continue;
    const filePath = join(mailboxDir, file);
    // Never sweep a question that is still pending with a live asker —
    // `ask --timeout` can legitimately outlast the sweep age, and deleting
    // the file mid-wait would make the run's resolution watcher read the
    // absence as "answered".
    if (file.endsWith(".json")) {
      const record = loadQuestion(mailboxDir, file.slice(0, -".json".length));
      if (record && isQuestionPending(mailboxDir, record, now)) continue;
    }
    try {
      if (now - statSync(filePath).mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        deleted++;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not sweep ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return deleted;
}

/** First line of a question, clipped — the summary used in progress lines,
 *  run records, and `next` events. */
export function questionSummary(question: string, maxLen = 160): string {
  const firstLine = question.split("\n", 1)[0].trim();
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + "…" : firstLine;
}

/** Strip control characters (keep \n and \t) from text that untrusted model
 *  output will render into terminals and logs. */
export function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
