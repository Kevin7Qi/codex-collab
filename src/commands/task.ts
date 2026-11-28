// src/commands/task.ts — task, tasks: what became of a message `send` delivered
//
// Invoked by Codex (or a person). Every `send` is a task with an id, and its
// outcome is written to a record by a receiver that outlives the command (see
// claude-tasks.ts). These commands only read that record, so they work inside
// Codex's sandbox, after `send` has timed out, and after the asking session
// has lost track of everything but the id.

import { resolveStateDir } from "../config";
import { describeModelChoice, sessionStatusNow } from "../claude-sessions";
import { FINAL_STATUSES, listTasks, loadTask, resolveTaskId, settled, type TaskRecord, repliesByMessage } from "../claude-tasks";
import { claimDelivery, isNotice, isThreadId, messagesSince, threadStateDirs, type ChannelMessage } from "../claude-channel";
import { die, parseOptions } from "./shared";
import { listed } from "../format";
import { DEFAULT_TASK_WAIT_SEC, exitCodeFor, statusLine, showsHints, dirHint, since, printedText, COMES_BY_ITSELF, replyComesByItself, claimsWhatItPrints, claimReported, waitForTask, reportOutcome, describeFailure, describePrompt, firstLine } from "./task-outcome";

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

/** `task status`: what is known of a task right now, without waiting. */
function printStatus(record: TaskRecord, hint: string, stateDir: string): void {
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
    const prompt = describePrompt(record.target);
    console.log(`  session   ${prompt ? `waiting, ${prompt}` : sessionStatusNow(record.target.pid) ?? "not registered"}`);
  }
  if (record.restartedAt) console.log(`  restarted ${since(record.restartedAt)} ago, by Claude Code after its process exited`);
  // One line, whether it was recorded when it happened or read from the
  // transcript now — two would be the same trouble told twice, differently.
  const recorded = record.error ?? describeFailure(record, stateDir);
  if (recorded) console.log(`  error     ${recorded}`);
  console.log(`  message   ${firstLine(record.message)}`);
  if (!final && replyComesByItself(record)) console.log(`  reply     ${COMES_BY_ITSELF.replace(/^its reply /, "")}`);
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
    else {
      printStatus(record, hint, stateDir);
      if (claimsWhatItPrints(record.threadId)) claimReported(stateDir, record, record.status, record.error ?? "");
    }
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
  else reportOutcome(record, { waitedMs, hint, stateDir });
  process.exit(exitCodeFor(record.status));
}

/** `messages [<id>]`: what Claude Code sessions sent the Codex thread this
 *  command runs in, oldest first — the latest `--limit` of them (`--all`
 *  for every one kept), or one in full. Read from the thread's mailboxes, so
 *  it works inside Codex's sandbox. */
export async function handleMessages(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const threadId = process.env.CODEX_THREAD_ID;
  if (!isThreadId(threadId)) {
    die("`codex-collab messages` prints what Claude Code sessions sent the Codex thread it runs in, and no Codex thread ran it (CODEX_THREAD_ID is not set).");
  }
  const all = threadStateDirs(threadId)
    .flatMap((dir) => messagesSince(dir, threadId).map((message) => ({ dir, message })))
    .sort((a, b) => (a.message.id < b.message.id ? -1 : 1));
  const replies = new Map<string, Map<string, TaskRecord[]>>();
  const repliesIn = (dir: string) => {
    if (!replies.has(dir)) replies.set(dir, repliesByMessage(listTasks(dir), threadId));
    return replies.get(dir)!;
  };
  const print = ({ dir, message: m }: { dir: string; message: ChannelMessage }) => {
    const tasks = (repliesIn(dir).get(m.id) ?? []).map((t) => t.id);
    const of = isNotice(m)
      ? `, about task ${m.about}`
      : tasks.length > 0 ? `, its reply to ${tasks.length === 1 ? "task" : "tasks"} ${listed(tasks)}` : "";
    console.log(`MESSAGE ${m.id} FROM ${m.fromName} (${since(m.at)} ago)${of}:`);
    console.log(printedText(m.text));
    // Printed whole, it has reached the thread (see reportOutcome).
    if (claimsWhatItPrints(threadId)) claimDelivery(dir, threadId, m.id);
  };
  const wanted = positional[0];
  if (wanted) {
    const found = all.filter((x) => x.message.id.startsWith(wanted));
    if (found.length !== 1) {
      die(found.length > 1 ? `"${wanted}" matches several messages: ${found.map((x) => x.message.id).join(", ")}` : `No message "${wanted}" to this thread. \`codex-collab messages\` lists them.`);
    }
    print(found[0]);
    return;
  }
  if (all.length === 0) {
    console.log("No Claude Code session has sent this thread anything.");
    return;
  }
  const shown = all.slice(-options.limit);
  if (shown.length < all.length) console.log(`(${all.length - shown.length} older not shown — --all prints every one kept.)`);
  for (const x of shown) print(x);
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
