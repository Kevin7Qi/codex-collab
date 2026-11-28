// src/channel-delivery.ts — handing a thread's mailbox to Codex
//
// What reached a Codex thread's mailbox (claude-channel.ts) and Codex has not
// been handed is taken here, oldest first and within a token budget, each
// message claimed as it is taken. Two callers hand it over: Codex's hooks
// (commands/hook.ts), inside a turn, and a wake (codex-wake.ts), as the
// input of a new one.

import { listTasks, repliesByMessage, type TaskRecord } from "./claude-tasks";
import { claimDelivery, isDelivered, isNotice, messageIdsSince, readMessage, type ChannelMessage } from "./claude-channel";
import { buildDelegation } from "./codex-session";
import { formatAge, listed } from "./format";
import { sanitizeForTerminal } from "./questions";


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

/** A message's first line, as a task is quoted by: without the marks of a
 *  markdown heading it may open with. */
function firstLine(text: string, max: number): string {
  const line = (sanitizeForTerminal(text).split("\n").find((l) => l.trim())?.trim() ?? "").replace(/^#{1,6}\s+/, "");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
