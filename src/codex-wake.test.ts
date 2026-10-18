// src/codex-wake.test.ts — when a turn is started for what Claude sent a thread, and when not
//
// The shared app-server is a stand-in client answering the three requests a
// wake makes; mailboxes live under a temp workspaces root. The host doing it
// when a message arrives, against a stand-in server, is in send.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDelivered, writeMessage } from "./claude-channel";
import { wakeThread } from "./codex-wake";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-wake-"));
const THREAD = "01a0985a-445b-7ee2-85b5-52e2b36a6ba4";
let n = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function fresh(): { root: string; ws: string } {
  const root = join(ROOT, `root-${++n}`);
  const ws = join(root, `ws-${n}`);
  mkdirSync(ws, { recursive: true, mode: 0o700 });
  return { root, ws };
}

/** A stand-in for the shared app-server: the thread's status, and what it
 *  was asked. `fail` names a method that errors. */
function server(status: string, fail?: string) {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
  let closed = false;
  const client = {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      asked.push({ method, params: params as Record<string, unknown> });
      if (method === fail) throw new Error(`${method} refused`);
      if (method === "thread/read") return { thread: { id: THREAD, status: { type: status } } } as T;
      return {} as T;
    },
    close: async () => { closed = true; },
  };
  return { client, asked, closed: () => closed };
}

describe("waking a thread", () => {
  test("idle on the shared server: a turn starts with what came, in one envelope, each message under its own line", async () => {
    const { root, ws } = fresh();
    const a = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "first" }, Date.now() - 2);
    const b = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "second" }, Date.now() - 1);
    const s = server("idle");
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root });
    expect(outcome).toEqual({ woke: true, messages: 2 });
    expect(s.asked.map((x) => x.method)).toEqual(["thread/read", "thread/resume", "turn/start"]);
    // Its turns are not read, and its settings are left as its user set them.
    expect(s.asked[0].params).toEqual({ threadId: THREAD, includeTurns: false });
    // Without its turns: on a long thread they are more than one answer holds.
    expect(s.asked[1].params).toEqual({ threadId: THREAD, excludeTurns: true });
    const start = s.asked[2].params as { threadId: string; input: Array<{ type: string; text: string }> };
    expect(Object.keys(start).sort()).toEqual(["input", "threadId"]);
    expect(start.input).toHaveLength(1);
    expect(start.input[0].text).toBe("<codex_delegation>\n  <source_thread_id></source_thread_id>\n  <input>[message from claude(a)]\n\nfirst\n\n[message from claude(a)]\n\nsecond</input>\n</codex_delegation>");
    expect(isDelivered(ws, THREAD, a.id) && isDelivered(ws, THREAD, b.id)).toBe(true);
    expect(s.closed()).toBe(true);
    // Handed over once.
    const again = server("idle");
    expect(await wakeThread(THREAD, { connect: async () => again.client, root })).toEqual({ woke: false, why: "nothing to hand over" });
    expect(again.asked.map((x) => x.method)).toEqual(["thread/read"]);
  });

  test("in a turn, or not held by the shared server, it is left alone and nothing is claimed", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    for (const [status, why] of [["active", "in a turn"], ["notLoaded", "not held by the shared app-server"], ["unknownState", "its state is unknownState"]]) {
      const s = server(status);
      expect(await wakeThread(THREAD, { connect: async () => s.client, root })).toEqual({ woke: false, why });
      expect(s.asked.map((x) => x.method)).toEqual(["thread/read"]);
    }
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
  });

  test("a thread whose last turn failed takes a turn as an idle one does, and the claims are told before the turn is asked for", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "try again" });
    const s = server("systemError");
    const told: string[][] = [];
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root, onTaken: (taken) => told.push(taken.map((t) => t.message.id)) });
    expect(outcome).toEqual({ woke: true, messages: 1 });
    // Told what it claimed, then told it is settled: a host that stops in
    // between gives the claims back.
    expect(told).toEqual([[m.id], []]);
  });

  test("a turn that cannot be started gives its messages back for the next hook or wake", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const s = server("idle", "turn/start");
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root });
    expect(outcome.woke).toBe(false);
    expect((outcome as { why: string }).why).toContain("the turn could not be started: turn/start refused");
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
    expect(s.closed()).toBe(true);
  });

  test("with no shared server to reach, nothing happens", async () => {
    const { root, ws } = fresh();
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    expect(await wakeThread(THREAD, { connect: async () => { throw new Error("ENOENT"); }, root })).toEqual({ woke: false, why: "no shared app-server" });
  });
});
