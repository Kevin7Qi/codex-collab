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
// reads one shape whichever way a message reached it.
//
// It is never in Codex's way: whatever goes wrong, it says nothing, and the
// turn goes on as if it had not run. It waits for nothing: what has not
// arrived yet is a later hook's.

import { listTasks, loadTask, type TaskRecord } from "../claude-tasks";
import { claimDelivery, isDelivered, isThreadId, messageIdsSince, readMessage, threadStateDirs, type ChannelMessage } from "../claude-channel";
import { buildDelegation } from "../peer";
import { sanitizeForTerminal } from "../questions";
import { laterFromSession } from "./task";
import { formatAge } from "./shared";

/** The events the hook answers, and how each hands a message over. */
export const HOOK_EVENTS = ["PostToolUse", "Stop", "UserPromptSubmit"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/** What one hook hands over at most, in tokens as `estimateTokens` counts
 *  them: under the limit `config codex-hook` sets on the hooks (8,000), past
 *  which Codex would put the text in a file instead. A message that does not
 *  fit whole is cut, with the command that prints the rest. */
export const HOOK_BUDGET_TOKENS = 7000;

/** A rough token count: a character of Chinese, Japanese or Korean is about
 *  one, other text about four characters to one. Rough is enough for a
 *  budget that leaves room. */
export function estimateTokens(text: string): number {
  const wide = (text.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g) ?? []).length;
  return wide + Math.ceil((text.length - wide) / 4);
}

/** The tasks whose reply a command's output printed: every report of one
 *  leads with this line (`statusLine`). */
export function repliedTasksIn(output: string): string[] {
  return [...new Set([...output.matchAll(/(?:^|\n)task: ([0-9a-f]{8})  status: replied\n/g)].map((m) => m[1]))];
}

function firstLine(text: string, max: number): string {
  const line = sanitizeForTerminal(text).split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Messages a command Codex just ran printed — `send`, `task wait`, `task
 *  result` — have reached it: they are claimed, so no hook hands them over
 *  again. Only a message whose text the output does hold counts. */
export function claimShown(dirs: string[], threadId: string, output: string): void {
  for (const id of repliedTasksIn(output)) {
    for (const dir of dirs) {
      const task = loadTask(dir, id);
      if (!task || task.threadId !== threadId || !task.reply?.id) continue;
      const shown: Array<{ id: string; text: string }> = [{ id: task.reply.id, text: task.reply.text }, ...laterFromSession(dir, task)];
      for (const m of shown) {
        const line = firstLine(m.text, 80).replace(/…$/, "");
        if (!line || output.includes(line)) claimDelivery(dir, threadId, m.id);
      }
    }
  }
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

/** The line a message opens with inside its envelope: who sent it, and when
 *  it is the reply to one of Codex's messages, which. */
function header(m: ChannelMessage, replyTo: TaskRecord | undefined, now: number): string {
  const at = Date.parse(m.at);
  const ago = Number.isFinite(at) && now - at >= 60_000 ? `, ${formatAge(at / 1000)}` : "";
  const of = replyTo ? `, its reply to task ${replyTo.id} ("${firstLine(replyTo.message, 60)}")` : "";
  return `[message from ${m.fromName}${of}${ago}]`;
}

/** The text a hook hands Codex for these messages, or null when there are
 *  none to hand over. Each message is claimed as it is taken: one that
 *  another hook claimed first is left to it, and one that does not fit is
 *  left for the next. */
export function compose(items: Array<{ dir: string; message: ChannelMessage }>, threadId: string, now: number = Date.now()): string | null {
  const replies = new Map<string, TaskRecord>();
  for (const dir of new Set(items.map((i) => i.dir))) {
    for (const t of listTasks(dir)) if (t.reply?.id && t.threadId === threadId) replies.set(t.reply.id, t);
  }
  // What the envelopes may take: the budget, less the line before them.
  let budget = HOOK_BUDGET_TOKENS - 30;
  const envelopes: string[] = [];
  for (const { dir, message: m } of items) {
    const head = header(m, replies.get(m.id), now);
    // Counted as Codex gets it, escaped and enveloped.
    const build = (body: string) => buildDelegation(`${head}\n\n${body}`);
    let envelope = build(m.text);
    let cost = estimateTokens(envelope);
    if (cost > budget) {
      // Room for a useful part of it, or it waits for the next hook.
      if (budget < 400) break;
      const pointer = `\n\n[cut here: the whole message is \`codex-collab messages ${m.id}\`]`;
      const cut = (keep: number) => {
        // Never half a character: a high surrogate goes with its pair.
        const end = keep > 0 && /[\ud800-\udbff]/.test(m.text[keep - 1]) ? keep - 1 : keep;
        return build(m.text.slice(0, end).trimEnd() + pointer);
      };
      // The most of it that fits.
      let lo = 0;
      let hi = m.text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (estimateTokens(cut(mid)) <= budget) lo = mid;
        else hi = mid - 1;
      }
      envelope = cut(lo);
      cost = estimateTokens(envelope);
    }
    if (!claimDelivery(dir, threadId, m.id)) continue;
    budget -= cost;
    envelopes.push(envelope);
  }
  if (envelopes.length === 0) return null;
  const count = envelopes.length === 1 ? "A message" : `${envelopes.length} messages`;
  return `codex-collab: ${count} from Claude Code reached this thread.\n${envelopes.join("\n")}`;
}

/** The hook's answer to Codex for one event, or null for none. */
export function hookAnswer(input: Record<string, unknown>, root?: string): string | null {
  const event = input.hook_event_name;
  if (!HOOK_EVENTS.includes(event as HookEvent)) return null;
  const threadId = input.session_id;
  if (!isThreadId(threadId)) return null;
  const dirs = threadStateDirs(threadId, root);
  if (dirs.length === 0) return null;
  if (event === "PostToolUse") {
    const response = input.tool_response;
    claimShown(dirs, threadId, typeof response === "string" ? response : JSON.stringify(response ?? ""));
  }
  const text = compose(undelivered(dirs, threadId), threadId);
  if (!text) return null;
  // A turn that would end goes on to read what came; the others take it in.
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
  if (answer) process.stdout.write(answer + "\n");
  process.exit(0);
}
