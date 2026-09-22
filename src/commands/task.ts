// src/commands/task.ts — task, tasks: what became of a message `send` delivered
//
// Invoked by Codex (or a person). Every `send` is a task with an id, and its
// outcome is written to a record by a receiver that outlives the command (see
// claude-tasks.ts). These commands only read that record, so they work inside
// Codex's sandbox, after `send` has timed out, and after the asking session
// has lost track of everything but the id.

import { resolve } from "node:path";
import { resolveStateDir } from "../config";
import { shellQuote } from "../approvals";
import { describeModelChoice, sessionStatusNow } from "../claude-sessions";
import { FINAL_STATUSES, listTasks, loadTask, resolveTaskId, settled, type TaskRecord, type TaskStatus } from "../claude-tasks";
import { describeTrouble, describeTurnError, turnEndedOnError, turnTrouble } from "../claude-transcript";
import { sanitizeForTerminal } from "../questions";
import { EXIT_CODES, die, formatDuration, parseOptions } from "./shared";

/** Default wait (seconds) of `send` and of `task wait`. It bounds how long the
 *  COMMAND blocks, and nothing else: the task goes on, and its reply is kept. */
export const DEFAULT_TASK_WAIT_SEC = 600;

/** What a command that reports on a task exits with, so a caller can branch
 *  without reading prose — the codes `run` uses for the same situations:
 *  0 replied · 3 no reply yet, the task goes on · 5 stopped at a prompt ·
 *  1 it will never reply (lost, failed, expired). */
export function exitCodeFor(status: TaskStatus): number {
  if (status === "replied") return EXIT_CODES.ok;
  if (status === "pending" || status === "running") return EXIT_CODES.timeout;
  if (status === "blocked") return EXIT_CODES.approvalPending;
  return EXIT_CODES.failed;
}

/** The first line of every report: the same two fields, the same way, so it
 *  can be matched without parsing the sentences under it. */
export function statusLine(record: Pick<TaskRecord, "id" | "status">): string {
  return `task: ${record.id}  status: ${record.status}`;
}

/** Whether to print the command that would do the next thing. Only for a
 *  person at a terminal: Codex reads this output as context, and it has these
 *  commands from its skill already, so a line of syntax under every send is
 *  cost with nothing in it. What a report owes Codex is what happened and the
 *  id it happened to. */
export function showsHints(): boolean {
  return process.stdout.isTTY === true;
}

/** ` -d <dir>` for the commands a report suggests, when the caller named a
 *  directory: a task id resolves only within its own workspace. */
export function dirHint(options: { dir: string; explicit: Set<string> }): string {
  return options.explicit.has("dir") ? ` -d ${shellQuote(resolve(options.dir))}` : "";
}

function since(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? formatDuration(Math.max(1000, now - t)) : "an unknown time";
}

/** Poll a task until it is final or `timeoutMs` has passed; returns it as it
 *  then stands. null when the record has disappeared. */
export async function waitForTask(stateDir: string, id: string, timeoutMs: number): Promise<TaskRecord | null> {
  const pollMs = Number(process.env.CODEX_COLLAB_TASK_POLL_MS) || 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = loadTask(stateDir, id);
    if (!record) return null;
    const now = settled(record);
    if (FINAL_STATUSES.has(now.status) || Date.now() >= deadline) return now;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** Print what became of a task, status line first. `waitedMs` is how long
 *  the caller just waited, when it did. */
export function reportOutcome(record: TaskRecord, opts: { waitedMs?: number; hint?: string } = {}): void {
  const { target } = record;
  const hint = opts.hint ?? "";
  console.log(statusLine(record));
  switch (record.status) {
    case "replied": {
      const took = record.deliveredAt && record.finishedAt
        ? ` (after ${formatDuration(Math.max(1000, Date.parse(record.finishedAt) - Date.parse(record.deliveredAt)))})`
        : "";
      console.log(`REPLY FROM ${target.name}${took}:`);
      // Indented so no reply line sits at column 0, the way `ask` prints answers.
      for (const l of sanitizeForTerminal(record.reply?.text ?? "").trimEnd().split("\n")) console.log(`  ${l}`);
      return;
    }
    case "pending":
    case "running": {
      console.log(opts.waitedMs !== undefined
        ? `no reply from ${target.name} within ${formatDuration(opts.waitedMs)}`
        : `no reply from ${target.name} yet (sent ${since(record.deliveredAt ?? record.createdAt)} ago)`);
      if (showsHints()) {
        console.log(`  codex-collab task wait ${record.id}${hint}     waits for it`);
        console.log(`  codex-collab task result ${record.id}${hint}   prints it once it is there`);
      }
      printSessionFacts(record);
      return;
    }
    case "blocked":
      console.log(`${target.name} stopped at a prompt with nobody attached; it ran on ${describeModelChoice(target.spawned?.model, target.spawned?.effort)}`);
      console.log("session: stopped by codex-collab, conversation kept");
      return;
    case "lost":
      console.log(`${target.name} ended before it replied`);
      printSessionFacts(record);
      return;
    case "expired":
      console.log(`no reply from ${target.name} in ${since(record.deliveredAt ?? record.createdAt, Date.parse(record.finishedAt ?? "") || Date.now())}`);
      printSessionFacts(record);
      return;
    case "failed":
      console.log(record.error ?? "no reason recorded");
      printSessionFacts(record, { skipError: !!record.error });
      return;
  }
}

/** What the session's own transcript recorded since the message was
 *  delivered, as a field. */
function describeFailure(record: TaskRecord): string | null {
  // A task that got its answer had no trouble, whatever the session hit
  // afterwards; and a task that ended has no share of what came later.
  if (!record.deliveredAt || record.status === "replied") return null;
  if (!FINAL_STATUSES.has(record.status)) {
    // Still waiting: only a turn that ENDED on an error says anything about
    // this task. A session that hit one and carried on is working, and
    // reporting that error would read as a turn that had died.
    const e = turnEndedOnError(record.target.sessionId, record.deliveredAt);
    return e ? describeTurnError(e) : null;
  }
  const t = turnTrouble(record.target.sessionId, record.deliveredAt, record.finishedAt);
  return t ? describeTrouble(t) : null;
}

/** The facts a report has no other line for: what went wrong on the session's
 *  side, and whether its conversation is still there. What to make of either
 *  is the reader's. */
function printSessionFacts(record: TaskRecord, opts: { skipError?: boolean } = {}): void {
  // What the receiver wrote down when it happened, in preference to reading
  // the transcript again: the same task must not read differently twice.
  const failure = opts.skipError ? null : record.error ?? describeFailure(record);
  if (failure) console.log(`error: ${failure}`);
  if (record.status === "pending" || record.status === "running") {
    if (sessionStatusNow(record.target.pid) === "waiting") console.log(`session: ${record.target.name} is at a prompt in its own terminal`);
    return;
  }
  if (record.target.spawned) console.log("session: started by codex-collab, conversation kept");
}

/** The record behind an id a caller typed, or a usage error. */
function taskOrDie(stateDir: string, typed: string | undefined, usage: string): TaskRecord {
  if (!typed) die(`No task id given\nUsage: ${usage}\n\`codex-collab tasks\` lists this workspace's tasks.`);
  const { id, matches } = resolveTaskId(stateDir, typed);
  if (!id) {
    die(matches.length > 1
      ? `"${typed}" matches several tasks: ${matches.join(", ")} — give more of the id.`
      : `No task "${typed}" in this workspace. \`codex-collab tasks\` lists them; a task belongs to the workspace it was sent from (-d <dir>).`);
  }
  const record = loadTask(stateDir, id);
  if (!record) die(`Task ${id} could not be read.`);
  return settled(record);
}

function describeTarget(record: TaskRecord): string {
  const { spawned } = record.target;
  return spawned
    ? `${record.target.name} — started by codex-collab, on ${describeModelChoice(spawned.model, spawned.effort)}`
    : record.target.name;
}

function firstLine(text: string, max = 100): string {
  const line = sanitizeForTerminal(text).split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `task status`: what is known of a task right now, without waiting. */
function printStatus(record: TaskRecord, hint: string): void {
  const final = FINAL_STATUSES.has(record.status);
  console.log(statusLine(record));
  console.log(`  to        ${describeTarget(record)}`);
  console.log(`  from      ${record.threadId ? `Codex thread ${record.threadId}` : "a Codex session"}`);
  console.log(`  sent      ${since(record.deliveredAt ?? record.createdAt)} ago`);
  if (final && record.finishedAt) console.log(`  finished  ${since(record.finishedAt)} ago`);
  if (!final) {
    // One look at the registry: `busy` is a turn in progress, `shell` a turn
    // that has ended with a command of its own still running, `idle` a session
    // with nothing in hand, `waiting` one stopped at a prompt.
    console.log(`  session   ${sessionStatusNow(record.target.pid) ?? "not registered"}`);
  }
  // One line, whether it was recorded when it happened or read from the
  // transcript now — two would be the same trouble told twice, differently.
  const recorded = record.error ?? describeFailure(record);
  if (recorded) console.log(`  error     ${recorded}`);
  console.log(`  message   ${firstLine(record.message)}`);
  if (showsHints() && record.status === "replied") console.log(`Print the reply: codex-collab task result ${record.id}${hint}`);
  else if (showsHints() && !final) console.log(`Wait for the reply: codex-collab task wait ${record.id}${hint}`);
  if (final && record.target.spawned) console.log("  session   conversation kept");
}

const TASK_USAGE = "codex-collab task status|wait|result <id> [--timeout <sec>] [--json]";

export async function handleTask(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const stateDir = resolveStateDir(options.dir);
  const hint = dirHint(options);
  // `task <id>` alone is a question about the task: its status.
  const known = ["status", "wait", "result"];
  const [sub, typed] = known.includes(positional[0] ?? "") ? positional : ["status", positional[0]];
  let record = taskOrDie(stateDir, typed, TASK_USAGE);

  if (sub === "status") {
    if (options.json) console.log(JSON.stringify(record, null, 2));
    else printStatus(record, hint);
    return;
  }
  let waitedMs: number | undefined;
  if (sub === "wait" && !FINAL_STATUSES.has(record.status)) {
    const timeoutSec = options.explicit.has("timeout") ? options.timeout : DEFAULT_TASK_WAIT_SEC;
    const started = Date.now();
    record = (await waitForTask(stateDir, record.id, timeoutSec * 1000)) ?? die(`Task ${record.id} was removed while it was being waited on.`);
    waitedMs = Date.now() - started;
  }
  if (options.json) console.log(JSON.stringify(record, null, 2));
  else reportOutcome(record, { waitedMs, hint });
  process.exit(exitCodeFor(record.status));
}

/** `tasks`: this workspace's tasks, newest first. */
export async function handleTasks(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const all = listTasks(resolveStateDir(options.dir)).map((t) => settled(t));
  const shown = all.slice(0, options.limit);
  if (options.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  if (all.length === 0) {
    console.log("No task has been sent from this workspace. `codex-collab send \"…\"` hands one to a Claude Code session.");
    return;
  }
  const rows = shown.map((t) => ({ id: t.id, status: t.status, to: t.target.name, sent: `${since(t.deliveredAt ?? t.createdAt)} ago`, message: firstLine(t.message, 60) }));
  const w = (key: "status" | "to" | "sent") => Math.max(key.length, ...rows.map((r) => r[key].length));
  console.log(`  ${"ID".padEnd(8)}  ${"STATUS".padEnd(w("status"))}  ${"TO".padEnd(w("to"))}  ${"SENT".padEnd(w("sent"))}  MESSAGE`);
  for (const r of rows) console.log(`  ${r.id}  ${r.status.padEnd(w("status"))}  ${r.to.padEnd(w("to"))}  ${r.sent.padEnd(w("sent"))}  ${r.message}`);
  if (shown.length < all.length) console.log(`(${all.length - shown.length} older not shown — --all lists every task.)`);
  if (showsHints()) console.log("\ncodex-collab task status <id> says where one stands; task wait <id> waits for its reply; task result <id> prints it.");
}
