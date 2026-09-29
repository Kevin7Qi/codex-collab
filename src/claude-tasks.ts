// src/claude-tasks.ts — tasks: what a Codex session handed to a Claude Code session
//
// `codex-collab send` used to own the reply socket itself, so a reply that
// came after its timeout had nowhere to land: the deadline was a cliff, for
// Codex (which lost the answer) and for Claude (which was told the number and
// had reason to cut work to fit it). A task record takes the cliff away. Every
// message sent is a task with an id; a detached receiver (see `recv-task` in
// commands/send.ts) owns the socket and writes the outcome here, and `send`
// and `task status|wait|result` only read it — so a reply is kept however long
// it took, and survives the command that asked, a dropped connection, and a
// compaction of the asking session's context.
//
// One file per task, one writer at a time: `send` creates the record, and from
// then on only that task's receiver writes it. Writes are tmp + rename, so a
// reader never sees half a record; no lock is needed. Readers work inside
// Codex's sandbox, where this directory is read-only.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { procIdentity } from "./peer";
import type { SpawnedSession } from "./claude-sessions";

/** `pending`: recorded, the receiver has not delivered yet. `running`:
 *  delivered, and the receiver is listening for the reply. The rest are
 *  final: `replied`; `blocked` — a session codex-collab started stopped at a
 *  prompt nobody could answer; `lost` — the session went away without
 *  replying; `failed` — the message never got there, or the receiver died;
 *  `expired` — the receiver gave up after its longest wait. */
export type TaskStatus = "pending" | "running" | "replied" | "blocked" | "lost" | "failed" | "expired";

export const FINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["replied", "blocked", "lost", "failed", "expired"]);

export interface TaskRecord {
  /** 8 hex characters, like a thread's short id; a unique prefix resolves. */
  id: string;
  status: TaskStatus;
  /** The workspace root the task was sent from. */
  cwd: string;
  /** The Codex thread that sent it, when Codex said. */
  threadId: string | null;
  message: string;
  target: {
    name: string;
    pid: number;
    socketPath: string;
    sessionId: string | null;
    procStart: string | null;
    /** Registry kind (`bg` for a background session) and, for one, its job:
     *  what Claude Code keeps when it brings a session back as a new process. */
    kind?: string;
    jobId?: string | null;
    /** Set when codex-collab started the session: what `blocked` stops. */
    spawned: SpawnedSession | null;
  };
  /** When Claude Code last brought the session back as a new process while
   *  the task waited — `target` is the process it is now. */
  restartedAt?: string;
  createdAt: string;
  /** When the receiver began delivering: from then on the message may have
   *  reached the session, whatever becomes of the receiver. */
  deliveryStartedAt?: string;
  /** Whether the message found the session in a turn already running, where
   *  it found it idle otherwise: what tells one task's error from another's. */
  joinedTurn?: boolean;
  deliveredAt?: string;
  /** When the turn this message is in was first seen running. */
  busySeenAt?: string;
  finishedAt?: string;
  /** When the receiver stops listening, reply or none. */
  expiresAt: string;
  /** The process collecting the reply, with what identifies it (see
   *  `procIdentity`): a reader can tell a receiver that died from one at work. */
  receiver?: { pid: number; procStart: string | null; pidDomain: string | null };
  /** The address the session replies to. */
  senderName?: string;
  reply?: { text: string; fromName: string };
  error?: string;
}

/** How long a receiver listens before it gives up (seconds): the longest a
 *  session codex-collab starts is allowed to live (SPAWN_MAX_LIFETIME_SEC). A
 *  `send --timeout` beyond it extends it for that task. */
export const TASK_MAX_WAIT_SEC = 4 * 3600;

/** TASK_MAX_WAIT_SEC, or what CODEX_COLLAB_TASK_MAX_WAIT_SEC says — a test
 *  seam, as the poll intervals are: four hours is no length for a test. */
export function taskMaxWaitSec(): number {
  const v = Number(process.env.CODEX_COLLAB_TASK_MAX_WAIT_SEC);
  return Number.isFinite(v) && v > 0 ? v : TASK_MAX_WAIT_SEC;
}

/** Finished tasks older than this are removed by `clean`. */
export const TASK_KEEP_MS = 7 * 24 * 3600 * 1000;

/** How long a new task may go without a receiver before it is taken as never
 *  started: `send` waits 30 s for its receiver to deliver, and a receiver
 *  notes itself on the record the moment it starts. */
export const RECEIVER_START_GRACE_MS = 2 * 60 * 1000;

export function tasksDir(stateDir: string): string {
  return join(stateDir, "tasks");
}

/** The shape of a task id. Every path built from one goes through this:
 *  an id comes from a command line, and must never be a path. */
export function isTaskId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}$/.test(id);
}

function taskFile(stateDir: string, id: string): string {
  if (!isTaskId(id)) throw new Error(`Not a task id: ${id}`);
  return join(tasksDir(stateDir), `${id}.json`);
}

/** Where a task's receiver writes what it would have printed — for a
 *  post-mortem when a task fails before its record can say why. */
export function taskLogFile(stateDir: string, id: string): string {
  if (!isTaskId(id)) throw new Error(`Not a task id: ${id}`);
  return join(tasksDir(stateDir), `${id}.log`);
}

function isRecord(v: unknown): v is TaskRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const t = r.target as Record<string, unknown> | undefined;
  return typeof r.id === "string" && typeof r.status === "string" && typeof r.message === "string"
    && typeof r.createdAt === "string" && !!t && typeof t === "object"
    && typeof t.name === "string" && typeof t.pid === "number" && typeof t.socketPath === "string";
}

export function writeTask(stateDir: string, record: TaskRecord): void {
  const file = taskFile(stateDir, record.id);
  const tmp = `${file}.tmp-${process.pid}`;
  // The message and the reply are the user's work: theirs alone to read.
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  // rename is atomic on POSIX; a reader never sees a half-written record.
  renameSync(tmp, file);
}

/** Record a new task as `pending` and return it. */
export function createTask(
  stateDir: string,
  fields: Pick<TaskRecord, "cwd" | "threadId" | "message" | "target"> & { maxWaitSec: number },
  now: Date = new Date(),
): TaskRecord {
  mkdirSync(tasksDir(stateDir), { recursive: true, mode: 0o700 });
  let id = randomBytes(4).toString("hex");
  while (existsSync(taskFile(stateDir, id))) id = randomBytes(4).toString("hex");
  const { maxWaitSec, ...rest } = fields;
  const record: TaskRecord = {
    id,
    status: "pending",
    ...rest,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + maxWaitSec * 1000).toISOString(),
  };
  writeTask(stateDir, record);
  return record;
}

/** The record as written, or null when there is none (or it is unreadable). */
export function loadTask(stateDir: string, id: string): TaskRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(taskFile(stateDir, id), "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge `patch` into a task's record. For the task's one writer. */
export function updateTask(stateDir: string, id: string, patch: Partial<TaskRecord>): TaskRecord | null {
  const current = loadTask(stateDir, id);
  if (!current) return null;
  const next = { ...current, ...patch };
  writeTask(stateDir, next);
  return next;
}

/** A record as a reader should take it. An unfinished task whose receiver is
 *  verifiably gone — killed, or the machine restarted — will never finish by
 *  itself: it reads as `failed`, with the reason. A receiver that cannot be
 *  checked from here (inside Codex's sandbox every host pid looks dead, which
 *  is why `procIdentity` looks at the pid domain first) is taken at its word. */
export function settled(record: TaskRecord, identify: typeof procIdentity = procIdentity, now: number = Date.now()): TaskRecord {
  if (FINAL_STATUSES.has(record.status)) return record;
  if (!record.receiver) {
    // A receiver notes itself before it does anything else, so a task this
    // old without one never got one: `send` was killed before it started it,
    // or starting it failed. Nothing will ever write this record, and it
    // must not hold the session it names from the reaper for ever.
    const age = now - Date.parse(record.createdAt);
    if (record.status !== "pending" || !(age > RECEIVER_START_GRACE_MS)) return record;
    return { ...record, status: "failed", error: "the process that was to deliver it never started, so the message was not delivered" };
  }
  const { pid, procStart, pidDomain } = record.receiver;
  const entry: Record<string, unknown> = { pid, ...(procStart ? { procStart } : {}), ...(pidDomain ? { pidDomain } : {}) };
  if (identify(entry) !== "dead") return record;
  return {
    ...record,
    status: "failed",
    error: record.status === "running"
      ? "the process collecting the reply is gone (it was killed, or the machine restarted), so a reply can no longer reach this task"
      : record.deliveryStartedAt
        ? "the process delivering it is gone, and went while delivering it, so the message may have reached the session"
        : "the process that was to deliver it is gone, and went before delivering it, so the message was not delivered",
  };
}

/** Every task of this workspace, newest first. */
export function listTasks(stateDir: string): TaskRecord[] {
  let files: string[];
  try {
    files = readdirSync(tasksDir(stateDir));
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const file of files) {
    if (!/^[0-9a-f]{8}\.json$/.test(file)) continue;
    const record = loadTask(stateDir, file.slice(0, 8));
    if (record) records.push(record);
  }
  return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Resolve the id a caller typed: exact, else a unique prefix. `matches`
 *  lists the candidates when a prefix fits several. */
export function resolveTaskId(stateDir: string, typed: string): { id: string | null; matches: string[] } {
  const needle = typed.toLowerCase();
  if (!/^[0-9a-f]{1,8}$/.test(needle)) return { id: null, matches: [] };
  const matches = listTasks(stateDir).map((t) => t.id).filter((id) => id.startsWith(needle));
  if (matches.includes(needle)) return { id: needle, matches: [needle] };
  return { id: matches.length === 1 ? matches[0] : null, matches };
}

/** The tasks of this workspace still waiting on a session — its pid, and its
 *  session id where the record carries one. A session somebody is waiting on
 *  is doing that work whatever the registry says it is doing: Claude Code
 *  reports a session `idle` the moment it ends a turn, including a turn that
 *  left a command running in the background and will report when it finishes.
 *  Reaping such a session throws the work away and loses the reply. */
export function outstandingTasksFor(
  stateDir: string,
  target: { pid: number; sessionId?: string | null },
): TaskRecord[] {
  return listTasks(stateDir)
    .map((t) => settled(t))
    .filter((t) => !FINAL_STATUSES.has(t.status) && sameSession(t.target, target));
}

/** Whether a task's target is this session. The session id decides where
 *  both carry one — Claude Code can bring a session back under a new pid —
 *  and the pid where either does not. */
function sameSession(a: { pid: number; sessionId?: string | null }, b: { pid: number; sessionId?: string | null }): boolean {
  return a.sessionId && b.sessionId ? a.sessionId === b.sessionId : a.pid === b.pid;
}

/** When the next turn of the session a task went to began, as far as this
 *  workspace's own tasks show it: the first message delivered after this
 *  task's turn was seen running that found the session idle. The session
 *  was at work on this task's turn and then was not, so that message started
 *  a turn of its own, and an error after it belongs to that turn. Before this
 *  task's turn has been seen running nothing is known: two messages that
 *  reach an idle session a moment apart land in the same turn, and its end
 *  is both of theirs. Undefined when no later task has started a turn. */
export function nextTurnAfter(stateDir: string, id: string): string | undefined {
  const task = loadTask(stateDir, id);
  const running = task?.busySeenAt ? Date.parse(task.busySeenAt) : NaN;
  if (!task || !Number.isFinite(running)) return undefined;
  let next: number | undefined;
  for (const other of listTasks(stateDir)) {
    if (other.id === id || !other.deliveredAt || other.joinedTurn === true || !sameSession(other.target, task.target)) continue;
    const at = Date.parse(other.deliveredAt);
    if (Number.isFinite(at) && at > running && (next === undefined || at < next)) next = at;
  }
  return next === undefined ? undefined : new Date(next).toISOString();
}

/** Remove finished tasks (and any task's leftovers) older than `maxAgeMs`.
 *  A task still being waited on is never old: its receiver ends it first. */
export function sweepTasks(stateDir: string, maxAgeMs: number = TASK_KEEP_MS, now: number = Date.now()): number {
  let files: string[];
  try {
    files = readdirSync(tasksDir(stateDir));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const file of files) {
    const path = join(tasksDir(stateDir), file);
    try {
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      if (file.endsWith(".json")) {
        const record = loadTask(stateDir, file.slice(0, -".json".length));
        if (record && !FINAL_STATUSES.has(settled(record).status)) continue;
      }
      unlinkSync(path);
      if (file.endsWith(".json")) removed++;
    } catch { /* gone meanwhile, or not ours to remove */ }
  }
  return removed;
}
