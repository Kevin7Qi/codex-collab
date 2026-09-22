// src/claude-transcript.ts — what a Claude Code session's own transcript says went wrong
//
// A task that gets no reply looks the same whatever the cause: the session is
// still thinking, or its turn died. The difference is recorded, in the
// session's transcript — Claude Code writes an entry there for every API
// error it hits (`isApiErrorMessage`, with a status and a reason) — and a
// Codex session that knows a 529 hit the other end knows to send the work
// again rather than rewrite it.
//
// Nothing here is a contract. The file is Claude Code's own, its shape is
// undocumented, and every reader fails open: a transcript that cannot be
// found, read or understood yields null, and the task is reported exactly as
// it was before.

import { readFileSync, statSync } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

/** Where Claude Code keeps session transcripts, one directory per working
 *  directory. Overridable for tests, as the session registry is. */
export function projectsDir(): string {
  return process.env.CODEX_COLLAB_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** The transcript of `sessionId`, wherever it lives. A session id is unique
 *  across working directories, so it is searched for rather than derived from
 *  a path: the directory name is a slug of the cwd whose escaping is Claude
 *  Code's own business. */
export function transcriptPath(sessionId: string): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return null;
  try {
    for (const dir of readdirSync(projectsDir())) {
      const file = join(projectsDir(), dir, `${sessionId}.jsonl`);
      try {
        statSync(file);
        return file;
      } catch { /* not this one */ }
    }
  } catch { /* no transcripts here */ }
  return null;
}

/** How much of the tail to read. A long session's transcript runs to
 *  megabytes, and what went wrong in the last minutes is at the end of it. */
const TAIL_BYTES = 256 * 1024;

function tail(file: string, bytes = TAIL_BYTES): string {
  const size = statSync(file).size;
  if (size <= bytes) return readFileSync(file, "utf-8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    // Only what was actually read: the rest of the buffer is zeroes, and
    // decoding those would corrupt the newest line, which is the one that matters.
    const got = readSync(fd, buf, 0, bytes, size - bytes);
    // The first line is half of one; every reader here drops what it cannot parse.
    return buf.subarray(0, got).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export interface TurnError {
  /** HTTP status Claude Code recorded, when it recorded one. */
  status: number | null;
  /** Its own word for it: `server_error`, `rate_limit`, `invalid_request`… */
  reason: string | null;
  at: string;
}

/** The errors since a moment, and the last of them. */
export interface TurnTrouble {
  count: number;
  last: TurnError;
}

export function turnTrouble(sessionId: string | null | undefined, sinceIso?: string, untilIso?: string): TurnTrouble | null {
  const errors = turnErrorsSince(sessionId, sinceIso, untilIso);
  return errors.length ? { count: errors.length, last: errors[errors.length - 1] } : null;
}

/** The last API error in a session's transcript, if one came at or after
 *  `sinceIso` — the moment the task was delivered, so that errors from
 *  earlier work are not reported as this task's. null whenever the transcript
 *  is missing, unreadable, or says nothing of the kind. */
/** Entry types that are the conversation itself. Claude Code writes plenty
 *  besides — `system`, `cost-state`, `last-prompt`, `bridge-session`,
 *  `file-history-snapshot`, `queue-operation` — and those keep being written
 *  after a turn is over. */
const CONVERSATION_TYPES = new Set(["assistant", "user"]);

/** The error a turn ended on: the last thing said in the conversation is an
 *  API error, and it came after `sinceIso`. A session that hit an error and
 *  carried on has something of its own after it, so this tells a turn that
 *  died from one that stumbled. (Bookkeeping entries are written after a dead
 *  turn too, which is why they are not counted as something said.) */
export function turnEndedOnError(sessionId: string | null | undefined, sinceIso?: string): TurnError | null {
  const last = lastConversationEntry(sessionId);
  if (!last || last.d.isApiErrorMessage !== true) return null;
  const at = typeof last.d.timestamp === "string" ? last.d.timestamp : "";
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  if (Number.isFinite(since) && (!at || Date.parse(at) < since)) return null;
  return {
    status: typeof last.d.apiErrorStatus === "number" ? last.d.apiErrorStatus : null,
    reason: typeof last.d.error === "string" ? last.d.error : null,
    at,
  };
}

function lastConversationEntry(sessionId: string | null | undefined): { d: Record<string, unknown> } | null {
  if (!sessionId) return null;
  const file = transcriptPath(sessionId);
  if (!file) return null;
  let text: string;
  try {
    text = tail(file);
  } catch {
    return null;
  }
  let found: { d: Record<string, unknown> } | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d && typeof d === "object" && typeof d.type === "string" && CONVERSATION_TYPES.has(d.type)) found = { d };
  }
  return found;
}

export function turnErrorsSince(sessionId: string | null | undefined, sinceIso?: string, untilIso?: string): TurnError[] {
  if (!sessionId) return [];
  const file = transcriptPath(sessionId);
  if (!file) return [];
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const until = untilIso ? Date.parse(untilIso) : NaN;
  let text: string;
  try {
    text = tail(file);
  } catch {
    return [];
  }
  const found: TurnError[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("isApiErrorMessage")) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isApiErrorMessage !== true) continue;
    const at = typeof d.timestamp === "string" ? d.timestamp : "";
    if (Number.isFinite(since) && (!at || Date.parse(at) < since)) continue;
    // Trouble after the task was over is some other task's.
    if (Number.isFinite(until) && (!at || Date.parse(at) > until)) continue;
    found.push({
      status: typeof d.apiErrorStatus === "number" ? d.apiErrorStatus : null,
      reason: typeof d.error === "string" ? d.error : null,
      at,
    });
  }
  return found;
}

export function lastTurnError(sessionId: string | null | undefined, sinceIso?: string): TurnError | null {
  const errors = turnErrorsSince(sessionId, sinceIso);
  return errors.length ? errors[errors.length - 1] : null;
}

/** One error, as a field: what Claude Code recorded and when. */
export function describeTurnError(e: TurnError): string {
  const what = [e.status, e.reason].filter((x) => x !== null && x !== undefined).join(" ") || "error";
  return e.at ? `${what} at ${e.at}` : what;
}

/** The same, with how many there have been when there has been more than one. */
export function describeTrouble(t: TurnTrouble): string {
  return t.count > 1 ? `${describeTurnError(t.last)} (${t.count} since delivery)` : describeTurnError(t.last);
}
