// src/commands/peek.ts — peek command and pure formatting helpers.

import type { Turn, ThreadItem, Thread, UserMessageItem, AgentMessageItem } from "../types";
import {
  legacyResolveThreadId as resolveThreadId,
  legacyFindShortId as findShortId,
} from "../threads";
import {
  die,
  parseOptions,
  validateIdOrDie,
  withClient,
  getWorkspacePaths,
} from "./shared";

const DEFAULT_PEEK_LIMIT = 2;

const MESSAGE_TYPES = new Set(["userMessage", "agentMessage"]);

export interface PeekSelection {
  items: ThreadItem[];
  totalItems: number;
  truncated: boolean;
}

/**
 * Flatten turns into a chronological item stream, optionally filter to message
 * types only, then take the last `limit` items.
 *
 * If the latest turn is incomplete (still running, interrupted, or failed
 * before the agent could reply), scope to that turn alone — otherwise the
 * default slice would backfill the previous turn's agent reply, making it
 * appear as a response to the current user prompt.
 */
export function selectPeekItems(
  turns: Turn[],
  limit: number,
  full: boolean,
): PeekSelection {
  const latestTurn = turns[turns.length - 1];
  const latestIncomplete = latestTurn !== undefined && latestTurn.status !== "completed";
  const sourceTurns = latestIncomplete ? [latestTurn] : turns;
  const allItems: ThreadItem[] = sourceTurns.flatMap((t) => t.items);
  const eligible = full ? allItems : allItems.filter((i) => MESSAGE_TYPES.has(i.type));
  const items = eligible.slice(-limit);
  return {
    items,
    totalItems: eligible.length,
    truncated: items.length < eligible.length,
  };
}

interface PeekSimpleItem {
  type: string;
  id: string;
  text: string;
}

export interface PeekJsonOutput {
  shortId: string | null;
  threadId: string;
  name: string | null;
  cwd: string;
  items: PeekSimpleItem[] | ThreadItem[];
  totalItemsInThread: number;
  truncated: boolean;
}

function userText(item: UserMessageItem): string {
  return item.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export function formatPeekJson(
  thread: Thread,
  shortId: string | null,
  items: ThreadItem[],
  totalItems: number,
  truncated: boolean,
  full: boolean,
): PeekJsonOutput {
  const renderedItems: PeekSimpleItem[] | ThreadItem[] = full
    ? items
    : items.map((i) => {
        if (i.type === "userMessage") {
          return { type: "userMessage", id: i.id, text: userText(i as UserMessageItem) };
        }
        if (i.type === "agentMessage") {
          return { type: "agentMessage", id: i.id, text: (i as AgentMessageItem).text };
        }
        return { type: i.type, id: i.id, text: "" };
      });

  return {
    shortId,
    threadId: thread.id,
    name: thread.name ?? null,
    cwd: thread.cwd,
    items: renderedItems,
    totalItemsInThread: totalItems,
    truncated,
  };
}

export function formatPeekHuman(
  thread: Thread,
  shortId: string | null,
  items: ThreadItem[],
  totalItems: number,
  truncated: boolean,
  full: boolean,
): string {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case "userMessage":
        lines.push(`User: ${userText(item as UserMessageItem)}`);
        break;
      case "agentMessage":
        lines.push(`Codex: ${(item as AgentMessageItem).text}`);
        break;
      case "reasoning":
        lines.push(`[reasoning]: ${(item as any).summary?.join(" ") ?? ""}`);
        break;
      case "commandExecution":
        lines.push(`[command]: ${(item as any).command ?? ""}`);
        break;
      case "fileChange": {
        const changes = (item as any).changes ?? [];
        for (const c of changes) {
          lines.push(`[fileChange] ${c.path} (${c.kind?.type ?? "?"})`);
        }
        break;
      }
      default:
        lines.push(`[${item.type}]`);
    }
  }
  if (truncated) {
    const flagHint = full ? "--limit" : "--limit or --full";
    lines.push("");
    lines.push(`(showing ${items.length} of ${totalItems} items — use ${flagHint} for more)`);
  }
  void shortId;
  void thread;
  return lines.join("\n");
}

export async function handlePeek(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const id = positional[0];
  if (!id) die("Usage: codex-collab peek <id> [--limit N] [--full] [--json]");
  validateIdOrDie(id);

  const ws = getWorkspacePaths(options.dir);

  // Try local index first; if not found, treat the input as a raw thread ID
  // and let the server validate it. Surface ambiguous-prefix errors immediately
  // — only "Thread not found" should fall through to the server.
  let threadId: string;
  let shortId: string | null;
  try {
    threadId = resolveThreadId(ws.threadsFile, id);
    shortId = findShortId(ws.threadsFile, threadId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith("Thread not found")) die(msg);
    threadId = id;
    shortId = null;
  }

  const limit = options.explicit.has("limit") ? options.limit : DEFAULT_PEEK_LIMIT;

  // Fetch the thread inside withClient; do all rendering / die() calls outside
  // so withClient's finally can close the broker socket cleanly.
  let thread: Thread;
  try {
    thread = await withClient(async (client) => {
      const response = await client.request<{ thread: Thread }>("thread/read", {
        threadId,
        includeTurns: true,
      });
      return response.thread;
    }, options.dir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    die(`Could not read thread "${id}": ${msg}`);
  }

  const turns = thread.turns ?? [];
  const selection = selectPeekItems(turns, limit, options.full);

  if (options.json) {
    const out = formatPeekJson(
      thread,
      shortId,
      selection.items,
      selection.totalItems,
      selection.truncated,
      options.full,
    );
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const out = formatPeekHuman(
    thread,
    shortId,
    selection.items,
    selection.totalItems,
    selection.truncated,
    options.full,
  );
  const header = `Thread: ${shortId ?? threadId}${thread.name ? ` (${thread.name})` : ""}`;
  console.log(header);
  console.log(out);

  // Note in-progress threads where the last item is a user prompt with no agent reply yet.
  const lastItem = selection.items[selection.items.length - 1];
  if (thread.status?.type === "active" && lastItem?.type === "userMessage") {
    console.log("");
    console.log("(thread is currently active — no agent reply yet for the last user message)");
  }
}
