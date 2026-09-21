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
        ? `NO REPLY from ${target.name} within ${formatDuration(opts.waitedMs)}. The task goes on, and its reply is kept when it comes:`
        : `No reply from ${target.name} yet (sent ${since(record.deliveredAt ?? record.createdAt)} ago). Its reply is kept when it comes:`);
      console.log(`  codex-collab task wait ${record.id}${hint}     waits for it`);
      console.log(`  codex-collab task result ${record.id}${hint}   prints it once it is there`);
      if (sessionStatusNow(target.pid) === "waiting") {
        console.log(`${target.name} is waiting at a prompt in its own terminal — a permission request or a question only its user can answer there.`);
      }
      if (opts.waitedMs !== undefined) {
        console.log("(A Claude Code session running with bypassPermissions holds peer messages for its user to approve unless its crossSessionInbound setting is accept.)");
      }
      return;
    }
    case "blocked": {
      const ranOn = describeModelChoice(target.spawned?.model, target.spawned?.effort);
      console.log(`NO REPLY from ${target.name}: it stopped at a prompt (a permission request, most likely), and nobody is attached to answer it.`);
      console.log(`It was started in \`auto\` permission mode, where nothing prompts; Claude Code asks like this when that mode is not available to the session, which depends on the model. This one ran on ${ranOn}.`);
      console.log("It has been stopped. Send again with a model that has auto mode (`codex-collab models --claude` lists the choices; `--model sonnet` or above): the conversation resumes on it.");
      return;
    }
    case "lost":
      console.log(`NO REPLY from ${target.name}: the session is gone — it ended, or was stopped, before it replied.`);
      if (target.spawned) console.log("codex-collab started it, so its conversation is kept: send again, and it resumes with what it had done so far.");
      return;
    case "expired":
      console.log(`NO REPLY from ${target.name} in ${since(record.deliveredAt ?? record.createdAt, Date.parse(record.finishedAt ?? "") || Date.now())}, the longest a task is waited on. A reply can no longer reach it.`);
      return;
    case "failed":
      console.log(`Task ${record.id} to ${target.name} failed: ${record.error ?? "no reason recorded"}.`);
      return;
  }
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
    // One look at the registry: `busy` is a turn in progress, `idle` a session
    // that has ended its turn, `waiting` one stopped at a prompt.
    console.log(`  session   ${sessionStatusNow(record.target.pid) ?? "not registered"}`);
  }
  if (record.error) console.log(`  error     ${record.error}`);
  console.log(`  message   ${firstLine(record.message)}`);
  if (record.status === "replied") console.log(`Print the reply: codex-collab task result ${record.id}${hint}`);
  else if (!final) console.log(`Wait for the reply: codex-collab task wait ${record.id}${hint}`);
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
  console.log("");
  console.log("codex-collab task status <id> says where one stands; task wait <id> waits for its reply; task result <id> prints it.");
}
