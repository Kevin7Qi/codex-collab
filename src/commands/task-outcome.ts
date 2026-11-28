// src/commands/task-outcome.ts — what a command says about a task's outcome
//
// A task (claude-tasks.ts) is reported by more than one command: `send`
// prints the reply it waited for, `task` reads it back later, and the channel
// host and Codex's hooks pass on what came after. They share the wording, the
// exit code and the claim that a reply was shown, all of which live here.
// Nothing here parses a command line.

import { resolve } from "node:path";
import { describeModelChoice, promptNow, remoteControlReaches } from "../claude-sessions";
import { FINAL_STATUSES, loadTask, nextTurnAfter, settled, type TaskRecord, type TaskStatus } from "../claude-tasks";
import { describeTrouble, describeTurnError, turnEndedOnError, turnTrouble } from "../claude-transcript";
import { sanitizeForTerminal } from "../questions";
import { channelName, claimDelivery, isThreadId, messagesSince, noticesAbout, type ChannelMessage } from "../claude-channel";
import { RECENT_HOOK_RUN_MS, hooksRunIn } from "../codex-hooks";
import { shellQuote } from "../approvals";
import { EXIT_CODES } from "./shared";
import { formatDuration } from "../format";


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

export function since(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? formatDuration(Math.max(1000, now - t)) : "an unknown time";
}

/** A message's text as every report prints it: made safe for a terminal,
 *  and indented so no line of it sits at column 0, the way `ask` prints
 *  answers. The hook finds what a command printed by this same text. */
export function printedText(text: string): string {
  return sanitizeForTerminal(text).trimEnd().split("\n").map((l) => `  ${l}`).join("\n");
}

/** What a report says of a task still waiting for its reply, when that
 *  reply will come into the thread by itself. */
export const COMES_BY_ITSELF = "its reply comes to this thread by itself when it arrives, so there is no need to check on it";

/** Whether a task's reply comes by itself into the Codex thread asking
 *  about it: the task went from this very thread, through the thread's
 *  address (whose mailbox the hooks hand over from), and Codex runs the
 *  hooks there as things stand (`hooksRunIn`), lately enough to say so of
 *  this turn (`RECENT_HOOK_RUN_MS`). Codex cannot see whether the user
 *  turned the hooks on, or trusted them, so without this it checks. */
export function replyComesByItself(record: TaskRecord, env: NodeJS.ProcessEnv = process.env, hooks: Parameters<typeof hooksRunIn>[1] = {}): boolean {
  const threadId = record.threadId;
  if (!isThreadId(threadId) || env.CODEX_THREAD_ID !== threadId) return false;
  if (record.senderName !== channelName(record.cwd, threadId)) return false;
  return hooksRunIn(threadId, { within: RECENT_HOOK_RUN_MS, ...hooks });
}

/** Said of a task sent through its thread's address whose collecting
 *  process went: the address is the channel host's, so the session's
 *  answer still reaches the thread. */
export const LATE_ANSWER = "an answer that still comes reaches this thread as a message";

/** What a thread is told of its task when no reply will tell it: how the
 *  task ended without one, or, while it stays open, the error its session's
 *  turn ended on. Codex may have been told the reply comes by itself, and
 *  then nothing else would ever say so. */
export function outcomeNotice(record: TaskRecord): string {
  const name = record.target.name;
  const quoted = firstLine(record.message, 60).replace(/^#{1,6}\s+/, "");
  const task = `task ${record.id} ("${quoted}") to ${name}`;
  const why = record.error ? ` (${record.error})` : "";
  switch (record.status) {
    case "failed":
      return `${task} failed${why}.`;
    case "lost":
      return `${task} is lost: ${name} ended before it replied${why}.`;
    case "blocked":
      return `${task} is blocked: ${name} stopped at a prompt nobody answered${why}.`;
    case "expired":
      return `${task} expired with no reply${why}.`;
    default:
      return `${task} is still open${why}. ${name} is a session the user works in, who can set it going again; its reply would still come to this thread.`;
  }
}

/** Whether a command that prints what reached a thread is the one to mark
 *  it handed to Codex: only one the thread itself runs, and only where Codex
 *  does not run the hooks there. Where it does, the hook after each tool
 *  call marks what that call's output showed Codex (claimShown) — which
 *  holds too for a command Codex left running in the background and read
 *  later, or never: marked as it printed, a reply Codex never read would be
 *  lost to it. A person running the command is not Codex. */
export function claimsWhatItPrints(threadId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return isThreadId(threadId) && env.CODEX_THREAD_ID === threadId && !hooksRunIn(threadId);
}

/** Mark the thread's notices about a task as handed to Codex, once a
 *  report of the task has told it what they say: every one when the report
 *  gave the task's end (a receiver writes its notice before the end), and
 *  while the task is open, one whose error the report printed. `printed` is
 *  the report's text, or the part of it that matters. */
export function claimReported(stateDir: string, record: TaskRecord, printedStatus: string, printed: string): void {
  if (!isThreadId(record.threadId)) return;
  const ended = FINAL_STATUSES.has(printedStatus as TaskStatus);
  for (const n of noticesAbout(stateDir, record.threadId, record.id)) {
    const told = ended || (!!record.error && printed.includes(record.error) && n.text.includes(record.error));
    if (told) claimDelivery(stateDir, record.threadId, n.id);
  }
}

/** What the session a task went to wrote to the thread after its reply, oldest
 *  first: none for a reply that did not come through the thread's mailbox. */
export function laterFromSession(stateDir: string, record: TaskRecord): ChannelMessage[] {
  const reply = record.reply;
  if (!reply?.id || !reply.at || !isThreadId(record.threadId)) return [];
  const replyId = reply.id;
  return messagesSince(stateDir, record.threadId, Date.parse(reply.at))
    .filter((m) => m.id > replyId && (m.replyPath === record.target.socketPath || m.fromName === reply.fromName));
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
export function reportOutcome(record: TaskRecord, opts: { waitedMs?: number; hint?: string; stateDir?: string } = {}): void {
  printOutcome(record, opts);
  // What the report said, the thread's notices about the task have said too
  // (`claimReported`); the error, where there is one, is printed with it.
  if (opts.stateDir && claimsWhatItPrints(record.threadId)) claimReported(opts.stateDir, record, record.status, record.error ?? "");
}

function printOutcome(record: TaskRecord, opts: { waitedMs?: number; hint?: string; stateDir?: string }): void {
  const { target } = record;
  const hint = opts.hint ?? "";
  const facts = { stateDir: opts.stateDir };
  console.log(statusLine(record));
  switch (record.status) {
    case "replied": {
      const took = record.deliveredAt && record.finishedAt
        ? ` (after ${formatDuration(Math.max(1000, Date.parse(record.finishedAt) - Date.parse(record.deliveredAt)))})`
        : "";
      console.log(`REPLY FROM ${target.name}${took}:`);
      // Indented so no reply line sits at column 0, the way `ask` prints answers.
      console.log(printedText(record.reply?.text ?? ""));
      // What the session wrote to the thread after it, kept in the mailbox
      // the reply came from.
      const later = opts.stateDir ? laterFromSession(opts.stateDir, record) : [];
      for (const m of later) {
        console.log(`LATER FROM ${m.fromName} (${since(m.at)} ago):`);
        console.log(printedText(m.text));
      }
      // Printed, it has reached the thread that ran this, and no hook or
      // woken turn is to hand it over again (`claimsWhatItPrints` says when
      // this command is the one to say so).
      if (opts.stateDir && isThreadId(record.threadId) && record.reply?.id && claimsWhatItPrints(record.threadId)) {
        for (const id of [record.reply.id, ...later.map((m) => m.id)]) claimDelivery(opts.stateDir, record.threadId, id);
      }
      return;
    }
    case "pending":
    case "running": {
      const comes = replyComesByItself(record) ? `; ${COMES_BY_ITSELF}` : "";
      console.log(opts.waitedMs !== undefined
        ? `no reply from ${target.name} within ${formatDuration(opts.waitedMs)}${comes}`
        : `no reply from ${target.name} yet (sent ${since(record.deliveredAt ?? record.createdAt)} ago)${comes}`);
      if (showsHints()) {
        console.log(`  codex-collab task wait ${record.id}${hint}     waits for it`);
        console.log(`  codex-collab task result ${record.id}${hint}   prints it once it is there`);
      }
      printSessionFacts(record, facts);
      return;
    }
    case "blocked":
      console.log(record.unansweredSec !== undefined
        ? `${target.name} stopped at a prompt the user could answer through Remote Control, and nobody had for ${formatDuration(record.unansweredSec * 1000)}; it ran on ${describeModelChoice(target.spawned?.model, target.spawned?.effort)}`
        : `${target.name} stopped at a prompt with nobody attached; it ran on ${describeModelChoice(target.spawned?.model, target.spawned?.effort)}`);
      // Recorded only when it did not stop: what the line below would claim.
      if (record.error) console.log(`error: ${record.error}`);
      else console.log("session: stopped by codex-collab, conversation kept");
      return;
    case "lost":
      console.log(`${target.name} ended before it replied`);
      printSessionFacts(record, facts);
      return;
    case "expired":
      console.log(`no reply from ${target.name} in ${since(record.deliveredAt ?? record.createdAt, Date.parse(record.finishedAt ?? "") || Date.now())}`);
      printSessionFacts(record, facts);
      return;
    case "failed":
      console.log(record.error ?? "no reason recorded");
      printSessionFacts(record, { ...facts, skipError: !!record.error });
      return;
  }
}

/** What the session's own transcript recorded since the message was
 *  delivered, as a field. */
export function describeFailure(record: TaskRecord, stateDir: string | undefined): string | null {
  // A task that got its answer had no trouble, whatever the session hit
  // afterwards; and a task that ended has no share of what came later — nor
  // of a turn another task's message started after it.
  if (!record.deliveredAt || record.status === "replied") return null;
  const next = stateDir ? nextTurnAfter(stateDir, record.id) : undefined;
  if (!FINAL_STATUSES.has(record.status)) {
    // Still waiting: only a turn that ENDED on an error says anything about
    // this task. A session that hit one and carried on is working, and
    // reporting that error would read as a turn that had died.
    const e = turnEndedOnError(record.target.sessionId, record.deliveredAt, next);
    return e ? describeTurnError(e) : null;
  }
  const until = [record.finishedAt, next].filter((t): t is string => !!t).sort()[0];
  const t = turnTrouble(record.target.sessionId, record.deliveredAt, until);
  return t ? describeTrouble(t) : null;
}

/** The facts a report has no other line for: what went wrong on the session's
 *  side, and whether its conversation is still there. What to make of either
 *  is the reader's. */
function printSessionFacts(record: TaskRecord, opts: { skipError?: boolean; stateDir?: string } = {}): void {
  // What the receiver wrote down when it happened, in preference to reading
  // the transcript again: the same task must not read differently twice.
  const failure = opts.skipError ? null : record.error ?? describeFailure(record, opts.stateDir);
  if (failure) console.log(`error: ${failure}`);
  if (record.restartedAt) console.log(`restarted: by Claude Code ${since(record.restartedAt)} ago, after its process exited`);
  if (record.status === "pending" || record.status === "running") {
    const prompt = describePrompt(record.target);
    if (prompt) console.log(`session: ${record.target.name} is ${prompt}`);
    return;
  }
  if (record.target.spawned) console.log("session: started by codex-collab, conversation kept");
}

/** Where a session at a prompt stands, or null when it is at none: what the
 *  prompt is for, in Claude Code's words, and who can answer it. */
export function describePrompt(target: TaskRecord["target"]): string | null {
  const prompt = promptNow(target.pid);
  if (!prompt) return null;
  const what = prompt.waitingFor ? ` (${prompt.waitingFor})` : "";
  if (!target.spawned) return `at a prompt${what} in its own terminal`;
  if (remoteControlReaches(target.spawned.id)) {
    return `at a prompt${what} the user can answer through Remote Control; codex-collab stops it once it has gone unanswered for ${formatDuration(target.spawned.lingerSec * 1000)}`;
  }
  return `at a prompt${what} with nobody attached`;
}

export function firstLine(text: string, max = 100): string {
  const line = sanitizeForTerminal(text).split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
