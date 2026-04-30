// src/commands/peek.ts — peek command and pure formatting helpers.

import type { Turn, ThreadItem } from "../types";

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
