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
import { ownThread, wakeThread, type OwnThread } from "./codex-wake";
import { createRun, registerThread } from "./threads";
import type { RunRecord } from "./types";

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
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: true });
    expect(outcome).toEqual({ woke: true, messages: 2 });
    expect(s.asked.map((x) => x.method)).toEqual(["thread/read", "thread/resume", "turn/start"]);
    // Its turns are not read, and its settings are left as its user set them.
    expect(s.asked[0].params).toEqual({ threadId: THREAD, includeTurns: false });
    // Without its turns: on a long thread they are more than one answer holds.
    expect(s.asked[1].params).toEqual({ threadId: THREAD, excludeTurns: true });
    const start = s.asked[2].params as { threadId: string; input: Array<{ type: string; text: string }> };
    expect(Object.keys(start).sort()).toEqual(["input", "threadId"]);
    expect(start.input).toHaveLength(1);
    expect(start.input[0].text).toBe(`<codex_delegation>\n  <source_thread_id>${THREAD}</source_thread_id>\n  <input>[message from claude(a)]\n\nfirst\n\n[message from claude(a)]\n\nsecond</input>\n</codex_delegation>`);
    expect(isDelivered(ws, THREAD, a.id) && isDelivered(ws, THREAD, b.id)).toBe(true);
    expect(s.closed()).toBe(true);
    // Handed over once.
    const again = server("idle");
    expect(await wakeThread(THREAD, { connect: async () => again.client, root, hooksRun: true })).toEqual({ woke: false, why: "nothing to hand over" });
    expect(again.asked.map((x) => x.method)).toEqual(["thread/read"]);
  });

  test("in a turn, or not held by the shared server, it is left alone and nothing is claimed", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    for (const [status, why] of [["active", "in a turn"], ["notLoaded", "not held by the shared app-server"], ["unknownState", "its state is unknownState"]]) {
      const s = server(status);
      expect(await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: true })).toEqual({ woke: false, why });
      expect(s.asked.map((x) => x.method)).toEqual(["thread/read"]);
    }
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
  });

  test("a thread whose last turn failed takes a turn as an idle one does, and the claims are told before the turn is asked for", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "try again" });
    const s = server("systemError");
    const told: string[][] = [];
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: true, onTaken: (taken) => told.push(taken.map((t) => t.message.id)) });
    expect(outcome).toEqual({ woke: true, messages: 1 });
    // Told what it claimed, then told it is settled: a host that stops in
    // between gives the claims back.
    expect(told).toEqual([[m.id], []]);
  });

  test("a turn that cannot be started gives its messages back for the next hook or wake", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const s = server("idle", "turn/start");
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: true });
    expect(outcome.woke).toBe(false);
    expect((outcome as { why: string }).why).toContain("the turn could not be started: turn/start refused");
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
    expect(s.closed()).toBe(true);
  });

  test("a thread Codex does not run the hooks in is not woken: nothing would mark what it printed for itself, and old replies would come again", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const s = server("idle");
    const outcome = await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: false });
    expect(outcome.woke).toBe(false);
    expect(s.asked).toEqual([]);
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
  });

  test("with no shared server to reach, nothing happens", async () => {
    const { root, ws } = fresh();
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    expect(await wakeThread(THREAD, { connect: async () => { throw new Error("ENOENT"); }, root, hooksRun: true })).toEqual({ woke: false, why: "no shared app-server" });
  });
});

describe("waking a thread of codex-collab's own that no server holds", () => {
  /** A stand-in for `run --resume --detach`: what it was asked, and its answer. */
  function runner(answer: { ok: true } | { ok: false; why: string } = { ok: true }) {
    const asked: Array<{ own: OwnThread; text: string }> = [];
    return { asked, resume: async (own: OwnThread, text: string) => { asked.push({ own, text }); return answer; } };
  }

  /** The thread as `run` leaves it: in the index, with a run on record. */
  function ran(ws: string, patch: Partial<RunRecord> = {}): string {
    const shortId = registerThread(ws, THREAD, { cwd: "/work/project" });
    createRun(ws, {
      runId: "run-1", threadId: THREAD, shortId, kind: "task", phase: null, status: "completed", pid: null,
      sessionId: null, logFile: "logs/x.log", logOffset: 0, prompt: "p", model: null,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), elapsed: null,
      output: null, filesChanged: null, commandsRun: null, error: null, ...patch,
    } as RunRecord);
    return shortId;
  }

  test("a thread `run` has had a turn on is resumed as `run` would, with no shared server and with one that has unloaded it", async () => {
    for (const reach of ["none", "notLoaded"]) {
      const { root, ws } = fresh();
      const shortId = ran(ws);
      const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
      const s = server("notLoaded");
      const r = runner();
      const told: string[][] = [];
      const outcome = await wakeThread(THREAD, {
        connect: reach === "none" ? async () => { throw new Error("ENOENT"); } : async () => s.client,
        root, hooksRun: true, resume: r.resume, onTaken: (t) => told.push(t.map((x) => x.message.id)),
      });
      expect(outcome).toEqual({ woke: true, messages: 1 });
      expect(r.asked).toEqual([{
        own: { dir: "/work/project", shortId, running: false },
        text: `<codex_delegation>\n  <source_thread_id>${THREAD}</source_thread_id>\n  <input>[message from claude(a)]\n\nhello</input>\n</codex_delegation>`,
      }]);
      // The shared server is only asked what it holds: the broker resumes.
      expect(s.asked.map((x) => x.method)).toEqual(reach === "none" ? [] : ["thread/read"]);
      expect(isDelivered(ws, THREAD, m.id)).toBe(true);
      expect(told).toEqual([[m.id], []]);
    }
  });

  test("a thread codex-collab has not run is never resumed, listed by `threads` or not: it may be open in a server of its own", async () => {
    const { root, ws } = fresh();
    registerThread(ws, THREAD, { cwd: "/work/project" });
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const r = runner();
    expect(await wakeThread(THREAD, { connect: async () => server("notLoaded").client, root, hooksRun: true, resume: r.resume }))
      .toEqual({ woke: false, why: "not held by the shared app-server" });
    expect(await wakeThread(THREAD, { connect: async () => { throw new Error("ENOENT"); }, root, hooksRun: true, resume: r.resume }))
      .toEqual({ woke: false, why: "no shared app-server" });
    expect(r.asked).toEqual([]);
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
  });

  test("one the shared server holds is woken there, ours or not", async () => {
    const { root, ws } = fresh();
    ran(ws);
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const s = server("idle");
    const r = runner();
    expect(await wakeThread(THREAD, { connect: async () => s.client, root, hooksRun: true, resume: r.resume })).toEqual({ woke: true, messages: 1 });
    expect(s.asked.map((x) => x.method)).toEqual(["thread/read", "thread/resume", "turn/start"]);
    expect(r.asked).toEqual([]);
  });

  test("a run of ours on it is a turn: the hooks hand over, and nothing is claimed", async () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const r = runner();
    const outcome = await wakeThread(THREAD, {
      connect: async () => { throw new Error("ENOENT"); }, root, hooksRun: true, resume: r.resume,
      own: () => ({ dir: "/work/project", shortId: "abcd1234", running: true }),
    });
    expect(outcome).toEqual({ woke: false, why: "in a turn" });
    expect(r.asked).toEqual([]);
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
  });

  test("a resume that is refused (the thread is open elsewhere) gives its messages back", async () => {
    const { root, ws } = fresh();
    ran(ws);
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const r = runner({ ok: false, why: "Thread is held by another process" });
    const told: string[][] = [];
    const outcome = await wakeThread(THREAD, {
      connect: async () => { throw new Error("ENOENT"); }, root, hooksRun: true, resume: r.resume,
      onTaken: (t) => told.push(t.map((x) => x.message.id)),
    });
    expect(outcome).toEqual({ woke: false, why: "the turn could not be started: Thread is held by another process" });
    expect(isDelivered(ws, THREAD, m.id)).toBe(false);
    expect(told).toEqual([[m.id], []]);
  });

  test("two replies close together: each is handed over once — the second waits for the hooks once the run is going", async () => {
    const { root, ws } = fresh();
    const shortId = ran(ws);
    const first = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "first" });
    // The first wake's run is still starting when the second is tried.
    let started!: (v: { ok: true }) => void;
    const asked: string[] = [];
    const resume = (_own: OwnThread, text: string) => { asked.push(text); return new Promise<{ ok: true }>((r) => { started = r; }); };
    const none = async () => { throw new Error("ENOENT"); };
    const one = wakeThread(THREAD, { connect: none, root, hooksRun: true, resume });
    await new Promise((r) => setTimeout(r, 5));
    expect(await wakeThread(THREAD, { connect: none, root, hooksRun: true, resume })).toEqual({ woke: false, why: "nothing to hand over" });
    // The second reply lands once the run is on record as going.
    const second = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "second" });
    const going = () => ({ dir: "/work/project", shortId, running: true });
    expect(await wakeThread(THREAD, { connect: none, root, hooksRun: true, resume, own: going })).toEqual({ woke: false, why: "in a turn" });
    started({ ok: true });
    expect(await one).toEqual({ woke: true, messages: 1 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("first");
    expect(asked[0]).not.toContain("second");
    expect(isDelivered(ws, THREAD, first.id)).toBe(true);
    expect(isDelivered(ws, THREAD, second.id)).toBe(false);
  });

  test("ownThread: a thread with a run on record, and whether that run is still going", () => {
    const { root, ws } = fresh();
    expect(ownThread(THREAD, root)).toBeNull();
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    expect(ownThread(THREAD, root)).toBeNull();
    const shortId = ran(ws, { status: "running", pid: process.pid });
    expect(ownThread(THREAD, root)).toEqual({ dir: "/work/project", shortId, running: true });
  });

  test("ownThread: a run whose process is gone is not a turn", () => {
    const { root, ws } = fresh();
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "hello" });
    const shortId = ran(ws, { status: "running", pid: 2 ** 22 + 12345 });
    expect(ownThread(THREAD, root)).toEqual({ dir: "/work/project", shortId, running: false });
  });
});
