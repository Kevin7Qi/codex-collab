// src/commands/peek.ts — peek command and pure formatting helpers.

import type { Turn, ThreadItem, Thread, UserMessageItem, AgentMessageItem } from "../types";

const MESSAGE_TYPES = new Set(["userMessage", "agentMessage"]);

export interface PeekSelection {
  items: ThreadItem[];
  totalItems: number;
  truncated: boolean;
}

/**
 * Flatten turns into a chronological item stream, optionally filter to message
 * types only, then take the last `limit` items.
 */
export function selectPeekItems(
  turns: Turn[],
  limit: number,
  full: boolean,
): PeekSelection {
  const allItems: ThreadItem[] = turns.flatMap((t) => t.items);
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
