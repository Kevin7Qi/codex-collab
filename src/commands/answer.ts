// src/commands/answer.ts — answer + questions command handlers
//
// The responder side of the ask channel. `answer` writes the answer file the
// waiting `ask` polls for; `questions` lists what's pending. Anyone can
// answer — the Claude session that launched the run, or a human at a
// terminal — the mechanism doesn't care.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { mailboxRoot, resolveMailboxDir } from "../config";
import {
  answerPath,
  isAskerAlive,
  listPendingQuestions,
  listQuestions,
  questionSummary,
  writeAnswerExclusive,
} from "../questions";
import { die, formatAge, parseOptions, validateIdOrDie } from "./shared";
import type { QuestionRecord } from "../types";

interface FoundQuestion {
  mailboxDir: string;
  record: QuestionRecord;
}

/** Resolve an ID or unambiguous prefix against the current workspace's
 *  mailbox first, then across all mailboxes — mirroring approvals'
 *  findApprovalRequest, because the answer hint is printed by the run and
 *  the responder may act on it from a different cwd. */
function findQuestion(cwd: string, idOrPrefix: string): FoundQuestion | null {
  const matchesIn = (mailboxDir: string): FoundQuestion[] =>
    listQuestions(mailboxDir)
      .filter((r) => r.id === idOrPrefix || r.id.startsWith(idOrPrefix))
      .map((record) => ({ mailboxDir, record }));

  const localDir = resolveMailboxDir(cwd);
  const local = matchesIn(localDir);
  if (local.length === 1) return local[0];
  if (local.length > 1) die(`Question ID prefix "${idOrPrefix}" is ambiguous. Use more characters.`);

  const root = mailboxRoot();
  if (!existsSync(root)) return null;
  const matches: FoundQuestion[] = [];
  for (const workspaceName of readdirSync(root)) {
    const candidateDir = join(root, workspaceName, "questions");
    if (candidateDir === localDir) continue;
    try {
      matches.push(...matchesIn(candidateDir));
    } catch (e) {
      // A sibling workspace's mailbox failing its safety checks must not
      // block answering in a healthy one.
      console.error(`[codex] Warning: skipping mailbox ${candidateDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (matches.length > 1) {
    die(`Question ${idOrPrefix} matches in multiple workspaces. Re-run from the workspace directory or pass -d <workspace>.`);
  }
  return matches[0] ?? null;
}

export async function handleAnswer(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const idArg = positional[0];
  if (!idArg) die('Usage: codex-collab answer <question-id> "<text>"  (or: answer <id> - for stdin)');
  validateIdOrDie(idArg);

  let text = positional.slice(1).join(" ");
  if (text === "-") {
    if (process.stdin.isTTY) console.error("[codex] Reading answer from stdin — end with Ctrl-D.");
    text = readFileSync(0, "utf-8");
  }
  if (!text.trim()) {
    die('Empty answer\nUsage: codex-collab answer <question-id> "<text>"');
  }

  const found = findQuestion(options.dir, idArg);
  if (!found) die(`No pending question: ${idArg} (list them with: codex-collab questions)`);
  const { mailboxDir, record } = found;

  // An answer is a small act of trust — the responder deserves to know
  // whether it landed. Never silently swallow a late answer.
  const expiresAtMs = Date.parse(record.expiresAt);
  if (record.expired || (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now())) {
    die(
      `Question ${record.id} expired${Number.isFinite(expiresAtMs) ? ` ${formatAge(expiresAtMs / 1000)}` : ""} — Codex proceeded on its own judgment.\n` +
      `To steer now, wait for the run to finish and resume the thread: codex-collab run --resume <id> "..."`,
    );
  }
  // A run killed or timed out mid-ask leaves the question file behind with
  // no process waiting on the answer — delivering into the void would be a
  // false "Codex picks it up" promise.
  if (!isAskerAlive(record)) {
    die(
      `Question ${record.id} is orphaned — the asking process is gone (its run was killed, timed out, or crashed), so the answer cannot be delivered.\n` +
      `To steer instead, resume the thread: codex-collab run --resume <id> "..."`,
    );
  }
  if (existsSync(answerPath(mailboxDir, record.id))) {
    die(`Question ${record.id} was already answered.`);
  }

  let claimed: boolean;
  try {
    claimed = writeAnswerExclusive(mailboxDir, record.id, text);
  } catch (e) {
    die(`Failed to write answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!claimed) {
    die(`Question ${record.id} was already answered.`);
  }
  // The pre-claim checks are a snapshot; an answer landing in the final
  // second (or after the asker died mid-wait) is written but may never be
  // read. Re-check after the claim and be honest about uncertain delivery.
  const deliveredLate = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
  if (deliveredLate || !isAskerAlive(record)) {
    console.log(
      `Answered ${record.id}, but ${deliveredLate ? "the deadline passed while writing" : "the asking process is gone"} — ` +
      `Codex may have already proceeded on its own judgment. Check the run output; to steer instead, resume the thread once the run ends.`,
    );
    return;
  }
  console.log(`Answered ${record.id} — Codex picks it up within a second.`);
}

export async function handleQuestions(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const mailboxDir = resolveMailboxDir(options.dir);
  const pending = listPendingQuestions(mailboxDir);

  if (pending.length === 0) {
    console.log("No pending questions.");
    return;
  }
  console.log("Pending questions:");
  for (const record of pending) {
    const askedAtMs = Date.parse(record.askedAt);
    const expiresAtMs = Date.parse(record.expiresAt);
    const asked = Number.isFinite(askedAtMs) ? formatAge(askedAtMs / 1000).replace(" ago", "") : "?";
    const remainingSec = Number.isFinite(expiresAtMs)
      ? Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000))
      : null;
    const remaining = remainingSec === null ? ""
      : remainingSec >= 60 ? `  expires in ${Math.round(remainingSec / 60)}m`
      : `  expires in ${remainingSec}s`;
    console.log(
      `  ${record.id}  asked ${asked} ago${remaining}  ${questionSummary(record.question, 100)}`,
    );
  }
  console.log('\nAnswer with: codex-collab answer <id> "<text>"');
}
