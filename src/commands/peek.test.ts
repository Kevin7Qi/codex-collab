import { describe, expect, test } from "bun:test";
import { selectPeekItems } from "./peek";
import type { Turn, ThreadItem } from "../types";

function userItem(text: string, id: string = "u1"): ThreadItem {
  return {
    type: "userMessage",
    id,
    content: [{ type: "text", text }],
  } as ThreadItem;
}

function agentItem(text: string, id: string = "a1"): ThreadItem {
  return { type: "agentMessage", id, text } as ThreadItem;
}

function reasoningItem(id: string = "r1"): ThreadItem {
  return { type: "reasoning", id, summary: ["..."], content: ["..."] } as ThreadItem;
}

function turn(items: ThreadItem[], status: Turn["status"] = "completed"): Turn {
  return { id: "t1", items, status, error: null };
}

describe("selectPeekItems", () => {
  test("default mode returns last N message items only", () => {
    const turns = [turn([userItem("hi"), reasoningItem(), agentItem("hello")])];
    const result = selectPeekItems(turns, 2, false);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.type)).toEqual(["userMessage", "agentMessage"]);
    expect(result.totalItems).toBe(2);
  });

  test("default mode trims to last N when more messages exist", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")]),
      turn([userItem("q2", "u2"), agentItem("a2", "a2")]),
    ];
    const result = selectPeekItems(turns, 2, false);
    expect(result.items).toHaveLength(2);
    expect((result.items[0] as any).id).toBe("u2");
    expect((result.items[1] as any).id).toBe("a2");
  });

  test("--full includes all item types", () => {
    const turns = [turn([userItem("hi"), reasoningItem(), agentItem("hello")])];
    const result = selectPeekItems(turns, 10, true);
    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => i.type)).toEqual(["userMessage", "reasoning", "agentMessage"]);
    expect(result.totalItems).toBe(3);
  });

  test("truncated=true when limit < eligible items", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")]),
      turn([userItem("q2", "u2"), agentItem("a2", "a2")]),
    ];
    const result = selectPeekItems(turns, 2, false);
    expect(result.truncated).toBe(true);
    expect(result.totalItems).toBe(4);
  });

  test("truncated=false when fewer items than limit", () => {
    const turns = [turn([userItem("only")])];
    const result = selectPeekItems(turns, 10, false);
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  test("preserves item order across turns", () => {
    const turns = [
      turn([userItem("first", "u1"), agentItem("ans1", "a1")]),
      turn([userItem("second", "u2"), agentItem("ans2", "a2")]),
    ];
    const result = selectPeekItems(turns, 4, false);
    expect(result.items.map((i: any) => i.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("empty turns returns empty selection", () => {
    const result = selectPeekItems([], 2, false);
    expect(result.items).toHaveLength(0);
    expect(result.totalItems).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
