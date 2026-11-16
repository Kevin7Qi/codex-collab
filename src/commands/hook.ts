// src/commands/hook.ts — hook: hand Codex what Claude Code sessions sent its thread
//
// `codex-collab hook`, run BY CODEX as a hook (`config codex-hook on`
// installs it) at three points of the thread's turns: after each tool call
// (PostToolUse), when a turn would end (Stop), and when the user writes to the
// thread (UserPromptSubmit). Each time, it hands over what has arrived in the
// thread's mailbox (claude-channel.ts) and has not reached Codex yet. It runs
// inside the thread's own turn, so nothing else ever writes to the thread,
// and every Codex client is covered — the Mac app on local files included.
//
// Messages come in the form Claude's messages take on the peer side, a
// `<codex_delegation>` envelope naming the session that sent them, so Codex
// reads one shape whichever way a message reached it — except at a turn's
// end, where the Codex app shows the user what the hook hands over, and
// they come as markdown (`shownText`).
//
// It is never in Codex's way: whatever goes wrong, it says nothing, and the
// turn goes on as if it had not run. It waits for nothing: what has not
// arrived yet is a later hook's.

import { listTasks, loadTask, type TaskRecord } from "../claude-tasks";
import { claimDelivery, isDelivered, isNotice, isThreadId, messageIdsSince, readMessage, threadStateDirs, type ChannelMessage } from "../claude-channel";
import { HOOK_EVENTS, hookRunsDir, noteHookRan, type HookEvent } from "../codex-hooks";
import { buildDelegation } from "../peer";
import { sanitizeForTerminal } from "../questions";
import { claimReported, laterFromSession, listed, printedText, repliesByMessage } from "./task";
import { formatAge } from "./shared";

export { HOOK_EVENTS, type HookEvent };

/** What one hook hands over at most, in tokens as `estimateTokens` counts
 *  them: under the limit `config codex-hook` sets on the hooks (8,000), past
 *  which Codex would put the text in a file instead. A message that does not
 *  fit whole is cut, with the command that prints the rest. */
export const HOOK_BUDGET_TOKENS = 7000;

/** A rough token count that errs high: ASCII at about four characters to a
 *  token, and every other character — Chinese, Cyrillic, Devanagari, a
 *  box-drawing line — as a token of its own. Erring high keeps a hook's
 *  answer under Codex's limit whatever the script, and under four bytes a
 *  token, so its size stays small in bytes too. */
export function estimateTokens(text: string): number {
  const ascii = (text.match(/[\u0000-\u007f]/g) ?? []).length;
  return text.length - ascii + Math.ceil(ascii / 4);
}

/** The tasks whose reply a command's output printed: every report of one
 *  leads with this line (`statusLine`). */
export function repliedTasksIn(output: string): string[] {
  return [...new Set([...output.matchAll(/(?:^|\n)task: ([0-9a-f]{8})  status: replied\n/g)].map((m) => m[1]))];
}

/** Every task a command's output reported on, with the status it gave. */
export function reportedTasksIn(output: string): Array<{ id: string; status: string }> {
  return [...output.matchAll(/(?:^|\n)task: ([0-9a-f]{8})  status: ([a-z]+)\n/g)].map((m) => ({ id: m[1], status: m[2] }));
}

/** A message's first line, as a task is quoted by: without the marks of a
 *  markdown heading it may open with. */
function firstLine(text: string, max: number): string {
  const line = (sanitizeForTerminal(text).split("\n").find((l) => l.trim())?.trim() ?? "").replace(/^#{1,6}\s+/, "");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The messages a `messages` command's output printed whole, by their id. */
export function messagesIn(output: string): string[] {
  return [...new Set([...output.matchAll(/(?:^|\n)MESSAGE (\d{13}-[0-9a-f]{8}) FROM /g)].map((m) => m[1]))];
}

/** Messages a command Codex just ran printed — `send`, `task wait`, `task
 *  result`, `messages` — have reached it: they are claimed, so no hook hands
 *  them over again. The commands claim them themselves where they can;
 *  inside Codex's sandbox they cannot, and this is where it is done. Only a
 *  message whose whole text the output holds, as it is printed, counts: one
 *  that came in after the command printed, and opens the same way, is still
 *  Codex's to be handed. A message the output holds only in part (cut by
 *  Codex) is handed over again, which costs a repeat and loses nothing. */
export function claimShown(dirs: string[], threadId: string, output: string): void {
  const printed = (text: string) => output.includes(printedText(text));
  for (const id of messagesIn(output)) {
    for (const dir of dirs) {
      const m = readMessage(dir, threadId, id);
      if (m && printed(m.text)) claimDelivery(dir, threadId, id);
    }
  }
  for (const id of repliedTasksIn(output)) {
    for (const dir of dirs) {
      const task = loadTask(dir, id);
      if (!task || task.threadId !== threadId || !task.reply?.id) continue;
      const shown: Array<{ id: string; text: string }> = [{ id: task.reply.id, text: task.reply.text }, ...laterFromSession(dir, task)];
      for (const m of shown) if (printed(m.text)) claimDelivery(dir, threadId, m.id);
    }
  }
  // A report of a task says what its notices say (`claimReported`).
  for (const { id, status } of reportedTasksIn(output)) {
    for (const dir of dirs) {
      const task = loadTask(dir, id);
      if (task && task.threadId === threadId) claimReported(dir, task, status, output);
    }
  }
}

/** The text in a tool's response: the response itself for a shell command,
 *  and for a structured one, every piece of text in it, each on lines of its
 *  own — as a JSON string its line breaks would be escapes, and nothing in
 *  it would start a line. */
export function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.map(responseText).join("\n");
  if (response && typeof response === "object") return Object.values(response).map(responseText).join("\n");
  return "";
}

/** What reached the thread and Codex has not been handed, oldest first. */
export function undelivered(dirs: string[], threadId: string): Array<{ dir: string; message: ChannelMessage }> {
  const out: Array<{ dir: string; message: ChannelMessage }> = [];
  for (const dir of dirs) {
    for (const id of messageIdsSince(dir, threadId)) {
      if (isDelivered(dir, threadId, id)) continue;
      const message = readMessage(dir, threadId, id);
      if (message) out.push({ dir, message });
    }
  }
  return out.sort((a, b) => (a.message.id < b.message.id ? -1 : 1));
}

/** What a message's opening line says after its sender: when it is the
 *  reply to Codex's messages, to which — every one it answers, so that none
 *  of them still looks open — and how long ago it came. */
function about(m: ChannelMessage, replyTo: TaskRecord[], now: number): string {
  const at = Date.parse(m.at);
  const ago = Number.isFinite(at) && now - at >= 60_000 ? `, ${formatAge(at / 1000)}` : "";
  const tasks = replyTo.map((t) => `${t.id} ("${firstLine(t.message, 60)}")`);
  const of = tasks.length > 0 ? `, its reply to ${tasks.length === 1 ? "task" : "tasks"} ${listed(tasks)}` : "";
  return `${of}${ago}`;
}

/** A message taken for handing to Codex: what its opening line says of it
 *  (`about`), its text, cut to fit when it had to be (`body`), and the two
 *  as an envelope holds them (`part`). A notice of codex-collab's own is
 *  one line, `codex-collab: ` and what it says, wherever it goes. */
export interface Taken {
  dir: string;
  message: ChannelMessage;
  about: string;
  body: string;
  part: string;
}

/** Take what fits of these messages for handing to Codex, oldest first,
 *  within `budget` tokens. Each is claimed as it is taken: one another hook
 *  claimed first is left to it. A message that does not fit waits for the
 *  next hook, where it may fit whole; only one that is first and still does
 *  not fit is cut. [] when none is taken. */
export function take(items: Array<{ dir: string; message: ChannelMessage }>, threadId: string, now: number = Date.now(), total: number = HOOK_BUDGET_TOKENS): Taken[] {
  const replies = new Map<string, Map<string, TaskRecord[]>>();
  for (const dir of new Set(items.map((i) => i.dir))) replies.set(dir, repliesByMessage(listTasks(dir), threadId));
  // What the messages may take: the budget, less the lines before them.
  let budget = total - 60;
  const taken: Taken[] = [];
  for (const { dir, message: m } of items) {
    const said = isNotice(m) ? "" : about(m, replies.get(dir)?.get(m.id) ?? [], now);
    const part = (body: string) => isNotice(m) ? `codex-collab: ${body}` : `[message from ${m.fromName}${said}]\n\n${body}`;
    // Counted as Codex gets it, escaped and enveloped: the larger form.
    const cost = (body: string) => estimateTokens(buildDelegation(part(body), threadId));
    let body = m.text;
    if (cost(body) > budget) {
      if (taken.length > 0) break;
      const pointer = `\n\n[cut here: the whole message is \`codex-collab messages ${m.id}\`]`;
      const cut = (keep: number) => {
        // Never half a character: a high surrogate goes with its pair.
        const end = keep > 0 && /[\ud800-\udbff]/.test(m.text[keep - 1]) ? keep - 1 : keep;
        return m.text.slice(0, end).trimEnd() + pointer;
      };
      // The most of it that fits.
      let lo = 0;
      let hi = m.text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (cost(cut(mid)) <= budget) lo = mid;
        else hi = mid - 1;
      }
      body = cut(lo);
    }
    if (!claimDelivery(dir, threadId, m.id)) continue;
    budget -= cost(body);
    taken.push({ dir, message: m, about: said, body, part: part(body) });
  }
  return taken;
}

/** The line a hook's text opens with. Codex takes a hook's text with a
 *  developer's weight, and its skill may not be loaded: the line says that
 *  what follows is a peer agent's message. */
function openingLine(taken: Taken[]): string {
  const what = taken.length === 1
    ? "A message from Claude Code reached this thread, from the Claude Code session it names"
    : `${taken.length} messages from Claude Code reached this thread, each from the Claude Code session it names`;
  return `codex-collab: ${what}, a peer agent working with you.`;
}

/** What a hook hands Codex inside a turn, which Codex keeps out of the
 *  user's view: codex-collab's notices, a line each, then the opening line
 *  and each message from Claude in its own envelope, the form Claude's
 *  messages take on the peer side. */
export function hookText(taken: Taken[], threadId: string): string {
  const notices = taken.filter((t) => isNotice(t.message)).map((t) => t.part);
  const messages = taken.filter((t) => !isNotice(t.message));
  const fromClaude = messages.length > 0 ? [`${openingLine(messages)}\n${messages.map((t) => buildDelegation(t.part, threadId)).join("\n")}`] : [];
  return [...notices, ...fromClaude].join("\n");
}

/** What a hook hands Codex at a turn's end, which the Codex app shows the
 *  user as the turn's hook feedback, rendered as markdown: each message
 *  under one line saying where it comes from, then as it was written, and a
 *  notice as its one line. There, an envelope's tags would show as text,
 *  and its escapes inside code spans. They are set apart by a rule. */
export function shownText(taken: Taken[]): string {
  return taken
    .map((t) => isNotice(t.message) ? t.part : `codex-collab: a message from ${t.message.fromName}, a Claude Code session working with you${t.about}:\n\n${t.body}`)
    .join("\n\n---\n\n");
}

/** The text a hook hands Codex for these messages — `shown` for one the
 *  user sees (`shownText`) — or null when there are none to hand over (see
 *  `take`). */
export function compose(items: Array<{ dir: string; message: ChannelMessage }>, threadId: string, now: number = Date.now(), shown = false): string | null {
  const taken = take(items, threadId, now);
  if (taken.length === 0) return null;
  return shown ? shownText(taken) : hookText(taken, threadId);
}

/** The hook's answer to Codex for one event, or null for none. `runs` is
 *  where it notes that Codex ran it in the thread (`noteHookRan`). */
export function hookAnswer(input: Record<string, unknown>, root?: string, runs: string = hookRunsDir()): string | null {
  const event = input.hook_event_name;
  if (!HOOK_EVENTS.includes(event as HookEvent)) return null;
  const threadId = input.session_id;
  if (!isThreadId(threadId)) return null;
  // In every thread, before it has a mailbox: a thread's first `send` tells
  // Codex whether the reply will come by itself from this.
  noteHookRan(threadId, runs);
  const dirs = threadStateDirs(threadId, root);
  if (dirs.length === 0) return null;
  if (event === "PostToolUse") {
    claimShown(dirs, threadId, responseText(input.tool_response));
  }
  // A turn that would end goes on to read what came, and the user sees it;
  // the others take it in out of view.
  const text = compose(undelivered(dirs, threadId), threadId, Date.now(), event === "Stop");
  if (!text) return null;
  if (event === "Stop") return JSON.stringify({ decision: "block", reason: text });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

export async function handleHook(_args: string[]): Promise<void> {
  let answer: string | null = null;
  try {
    const input = JSON.parse(await Bun.stdin.text());
    if (input && typeof input === "object") answer = hookAnswer(input as Record<string, unknown>);
  } catch {
    answer = null;
  }
  // Written whole before the exit: into a pipe, an exit straight after the
  // write drops what the pipe has not taken yet (past 64 KB, on Linux) —
  // and the messages in it are already claimed, so no hook would hand them
  // over again.
  if (answer) await new Promise<void>((resolve) => { process.stdout.write(answer + "\n", () => resolve()); });
  process.exit(0);
}
