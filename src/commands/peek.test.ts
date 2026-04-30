import { describe, expect, test } from "bun:test";
import { selectPeekItems, formatPeekJson, formatPeekHuman } from "./peek";
import type { Turn, ThreadItem, Thread } from "../types";

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

  test("incomplete latest turn does not backfill previous turn's agent reply", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")], "completed"),
      turn([userItem("q2", "u2")], "inProgress"),
    ];
    const result = selectPeekItems(turns, 2, false);
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as any).id).toBe("u2");
    expect(result.totalItems).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test("interrupted latest turn restricts pool to that turn", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")], "completed"),
      turn([userItem("q2", "u2")], "interrupted"),
    ];
    const result = selectPeekItems(turns, 10, false);
    expect(result.items.map((i: any) => i.id)).toEqual(["u2"]);
  });

  test("failed latest turn restricts pool to that turn", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")], "completed"),
      turn([userItem("q2", "u2")], "failed"),
    ];
    const result = selectPeekItems(turns, 10, false);
    expect(result.items.map((i: any) => i.id)).toEqual(["u2"]);
  });

  test("completed latest turn allows cross-turn slicing as before", () => {
    const turns = [
      turn([userItem("q1", "u1"), agentItem("a1", "a1")], "completed"),
      turn([userItem("q2", "u2"), agentItem("a2", "a2")], "completed"),
    ];
    const result = selectPeekItems(turns, 4, false);
    expect(result.items.map((i: any) => i.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thr_abc",
    preview: "auth refactor",
    modelProvider: "gpt-5",
    createdAt: 1700000000,
    updatedAt: 1700000100,
    path: null,
    cwd: "/repo",
    cliVersion: "1.0",
    source: "cli",
    name: "auth refactor",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    turns: [],
    ...overrides,
  };
}

describe("formatPeekJson", () => {
  test("flattens userMessage content into a top-level text string", () => {
    const thread = makeThread();
    const items: ThreadItem[] = [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } as ThreadItem,
      { type: "agentMessage", id: "a1", text: "hello" } as ThreadItem,
    ];
    const out = formatPeekJson(thread, "abc12345", items, 2, false, false);
    expect(out.items).toEqual([
      { type: "userMessage", id: "u1", text: "hi" },
      { type: "agentMessage", id: "a1", text: "hello" },
    ]);
  });

  test("includes thread metadata (shortId, threadId, name, cwd)", () => {
    const thread = makeThread({ id: "thr_xyz", cwd: "/proj", name: "feat" });
    const out = formatPeekJson(thread, "deadbeef", [], 0, false, false);
    expect(out.shortId).toBe("deadbeef");
    expect(out.threadId).toBe("thr_xyz");
    expect(out.cwd).toBe("/proj");
    expect(out.name).toBe("feat");
  });

  test("totalItemsInThread and truncated propagate", () => {
    const thread = makeThread();
    const out = formatPeekJson(thread, "abc12345", [], 47, true, false);
    expect(out.totalItemsInThread).toBe(47);
    expect(out.truncated).toBe(true);
  });

  test("--full passes raw items through unchanged", () => {
    const thread = makeThread();
    const items: ThreadItem[] = [
      { type: "reasoning", id: "r1", summary: ["s"], content: ["c"] } as ThreadItem,
    ];
    const out = formatPeekJson(thread, "abc12345", items, 1, false, true);
    expect(out.items).toEqual([
      { type: "reasoning", id: "r1", summary: ["s"], content: ["c"] },
    ]);
  });

  test("null name when thread has no name", () => {
    const thread = makeThread({ name: null });
    const out = formatPeekJson(thread, null, [], 0, false, false);
    expect(out.name).toBeNull();
    expect(out.shortId).toBeNull();
  });
});

describe("formatPeekHuman", () => {
  test("renders user/agent transcript", () => {
    const thread = makeThread();
    const items: ThreadItem[] = [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "what does this do?" }] } as ThreadItem,
      { type: "agentMessage", id: "a1", text: "It does X." } as ThreadItem,
    ];
    const out = formatPeekHuman(thread, "abc12345", items, 2, false, false);
    expect(out).toContain("User: what does this do?");
    expect(out).toContain("Codex: It does X.");
  });

  test("includes truncation footer when truncated", () => {
    const thread = makeThread();
    const out = formatPeekHuman(thread, "abc12345", [], 47, true, false);
    expect(out).toContain("47");
    expect(out).toMatch(/--limit|--full/);
  });

  test("omits truncation footer when not truncated", () => {
    const thread = makeThread();
    const out = formatPeekHuman(thread, "abc12345", [], 5, false, false);
    expect(out).not.toMatch(/showing.*of/);
  });

  test("--full mode footer mentions only --limit (not --full)", () => {
    const thread = makeThread();
    const items: ThreadItem[] = [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] } as ThreadItem,
    ];
    const out = formatPeekHuman(thread, "abc12345", items, 47, true, true);
    expect(out).toContain("--limit");
    expect(out).not.toContain("--full");
  });
});
