// src/claude-channel.test.ts — a Codex thread's address and mailbox
//
// The mailbox, contacts and the sweep work on a temp state dir; the client's
// side of the host is tried against a small server standing in for one. The
// host itself, with real sessions' registrations, is in commands/send.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelRefused,
  askHost,
  channelName,
  claudeEntries,
  contactAt,
  contactRunning,
  hostStateFile,
  inboxDir,
  isThreadId,
  loadContacts,
  messageIdsSince,
  messagesSince,
  openChannel,
  readMessage,
  sameContact,
  saveContacts,
  sweepChannels,
  threadTag,
  watchInbox,
  writeMessage,
  type Contact,
} from "./claude-channel";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-channel-"));
const THREAD = "01a0985a-445b-7ee2-85b5-52e2b36a6ba4";
let n = 0;
const freshState = () => {
  const dir = join(ROOT, `state-${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const describeUnix = process.platform === "win32" ? describe.skip : describe;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const contact = (over: Partial<Contact> = {}): Contact => ({ name: "claude", pid: 4242, sessionId: "s-1", procStart: "100", socketPath: "/tmp/cc.sock", ...over });

describe("names", () => {
  test("a thread id is a UUID, and nothing that could be a path", () => {
    expect(isThreadId(THREAD)).toBe(true);
    for (const bad of ["", "../etc", `${THREAD}/x`, THREAD.toUpperCase(), "01a0985a", `${THREAD}0`]) expect(isThreadId(bad)).toBe(false);
  });

  test("an address shows the thread's random tail: two threads started a minute apart share their first digits", () => {
    expect(threadTag(THREAD)).toBe("b36a6ba4");
    expect(threadTag("01a0985a-ffff-7ee2-85b5-000000000001")).not.toBe(threadTag(THREAD));
    const name = channelName(ROOT, THREAD);
    expect(name).toMatch(/^codex\(b36a6ba4-[0-9a-f]{6}\)$/);
    // Short enough to show whole wherever Claude Code lists its peers.
    expect(name.length).toBeLessThanOrEqual(40);
  });
});

describe("the mailbox", () => {
  test("messages come back in the order they arrived, from a given moment, privately kept", () => {
    const state = freshState();
    const a = writeMessage(state, THREAD, { fromName: "x", replyPath: "/a", text: "first" }, 1_000);
    const b = writeMessage(state, THREAD, { fromName: "x", replyPath: "/a", text: "second" }, 2_000);
    // Two in the same millisecond still get names of their own.
    const c = writeMessage(state, THREAD, { fromName: "y", replyPath: "/b", text: "third" }, 2_000);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(messageIdsSince(state, THREAD)).toEqual([a.id, b.id, c.id].sort());
    expect(messageIdsSince(state, THREAD, 1_500).sort()).toEqual([b.id, c.id].sort());
    expect(messagesSince(state, THREAD, 1_500).map((m) => m.text).sort()).toEqual(["second", "third"]);
    expect(readMessage(state, THREAD, a.id)).toEqual(a);
    expect(readMessage(state, THREAD, "../../x")).toBeNull();
    // Nothing half-written is left in sight, and nobody else can read them.
    const dir = inboxDir(state, THREAD);
    expect(readdirSync(dir).every((f) => f.endsWith(".json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, `${a.id}.json`)).mode & 0o077).toBe(0);
      expect(statSync(dir).mode & 0o077).toBe(0);
    }
  });

  test("a mailbox of another thread, or none, is empty", () => {
    const state = freshState();
    writeMessage(state, THREAD, { fromName: "x", replyPath: "/a", text: "hi" });
    expect(messageIdsSince(state, "01a0985a-445b-7ee2-85b5-000000000000")).toEqual([]);
    expect(messageIdsSince(freshState(), THREAD)).toEqual([]);
    expect(() => inboxDir(state, "../x")).toThrow();
  });

  test("a watch takes the first message it accepts, tells of the others once, and stops", async () => {
    const state = freshState();
    writeMessage(state, THREAD, { fromName: "early", replyPath: "/s", text: "before the watch" }, 1_000);
    const others: string[] = [];
    const watch = watchInbox(state, THREAD, 5_000, (m) => m.replyPath === "/s", { pollMs: 20, onOther: (m) => others.push(m.text) });
    writeMessage(state, THREAD, { fromName: "bystander", replyPath: "/other", text: "not the reply" }, 6_000);
    writeMessage(state, THREAD, { fromName: "asked", replyPath: "/s", text: "the reply" }, 7_000);
    writeMessage(state, THREAD, { fromName: "asked", replyPath: "/s", text: "later" }, 8_000);
    const got = await watch.message;
    expect(got.text).toBe("the reply");
    await Bun.sleep(60);
    expect(others).toEqual(["not the reply"]);
    expect(watch.lookNow()?.text).toBe("the reply");
    watch.stop();
  });

  test("lookNow finds a reply that landed since the last look", () => {
    const state = freshState();
    const watch = watchInbox(state, THREAD, 0, () => true, { pollMs: 60_000 });
    expect(watch.lookNow()).toBeNull();
    writeMessage(state, THREAD, { fromName: "asked", replyPath: "/s", text: "just now" });
    expect(watch.lookNow()?.text).toBe("just now");
    watch.stop();
  });
});

describe("contacts", () => {
  test("the same session by its id where both have one, else by its very process", () => {
    expect(sameContact(contact(), contact({ pid: 7, procStart: "9" }))).toBe(true);
    expect(sameContact(contact(), contact({ sessionId: "s-2" }))).toBe(false);
    expect(sameContact(contact({ sessionId: null }), contact({ sessionId: null }))).toBe(true);
    expect(sameContact(contact({ sessionId: null }), contact({ sessionId: null, procStart: "101" }))).toBe(false);
  });

  test("a contact runs while an entry of its session, or of its process, is not verifiably gone", () => {
    const live = () => "live" as const;
    const dead = () => "dead" as const;
    expect(contactRunning(contact(), [{ pid: 99, sessionId: "s-1" }], live)).toBe(true);
    // Claude Code gives a session a new id on /clear: its process is still it.
    expect(contactRunning(contact(), [{ pid: 4242, sessionId: "s-new", procStart: "100" }], live)).toBe(true);
    expect(contactRunning(contact(), [{ pid: 4242, sessionId: "s-new", procStart: "200" }], live)).toBe(false);
    expect(contactRunning(contact(), [{ pid: 99, sessionId: "s-1" }], dead)).toBe(false);
    expect(contactRunning(contact(), [], live)).toBe(false);
    // Unverifiable from here is no evidence it went.
    expect(contactRunning(contact(), [{ pid: 99, sessionId: "s-1" }], () => "unverifiable")).toBe(true);
  });

  test("the contact behind a reply address is the entry whose socket it is", () => {
    const entries = [{ pid: 5, sessionId: "s-5", procStart: "1", name: "five", messagingSocketPath: "/five.sock" }];
    expect(contactAt("/five.sock", entries)).toEqual({ name: "five", pid: 5, sessionId: "s-5", procStart: "1", socketPath: "/five.sock" });
    expect(contactAt("/nobody.sock", entries)).toBeNull();
  });

  test("contacts are kept on disk, and only well-formed ones are read back", () => {
    const state = freshState();
    expect(loadContacts(state, THREAD)).toEqual([]);
    saveContacts(state, THREAD, [contact()]);
    expect(loadContacts(state, THREAD)).toEqual([contact()]);
    writeFileSync(join(state, "channels", THREAD, "contacts.json"), JSON.stringify([contact(), { pid: "x" }, null]));
    expect(loadContacts(state, THREAD)).toEqual([contact()]);
  });

  test("Claude Code's entries are read without codex-collab's own", () => {
    const registry = join(ROOT, `registry-${++n}`);
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "11.json"), JSON.stringify({ pid: 11, messagingSocketPath: "/claude.sock" }));
    writeFileSync(join(registry, "12.json"), JSON.stringify({ pid: 12, messagingSocketPath: join(tmpdir(), `codex-collab-${process.getuid?.() ?? "u"}`, "thread-x.sock") }));
    writeFileSync(join(registry, "13.json"), JSON.stringify({ pid: 99, messagingSocketPath: "/mismatched.sock" }));
    writeFileSync(join(registry, "14.json"), "{ half");
    const saved = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = registry;
    try {
      expect(claudeEntries().map((e) => e.pid)).toEqual([11]);
    } finally {
      if (saved === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = saved;
    }
  });
});

describe("the sweep", () => {
  test("old messages go; a thread with none left and nobody to talk to goes; one with contacts, or open, stays", () => {
    const state = freshState();
    const other = "01a0985a-445b-7ee2-85b5-00000000000a";
    const open = "01a0985a-445b-7ee2-85b5-00000000000b";
    const day = 24 * 3600_000;
    const now = 100 * day;
    writeMessage(state, THREAD, { fromName: "x", replyPath: "/a", text: "old" }, now - 8 * day);
    const recent = writeMessage(state, THREAD, { fromName: "x", replyPath: "/a", text: "recent" }, now - day);
    writeMessage(state, other, { fromName: "x", replyPath: "/a", text: "old" }, now - 8 * day);
    writeMessage(state, open, { fromName: "x", replyPath: "/a", text: "old" }, now - 8 * day);
    saveContacts(state, open, []);
    const contacted = "01a0985a-445b-7ee2-85b5-00000000000c";
    saveContacts(state, contacted, [contact()]);
    expect(sweepChannels(state, 7 * day, now, new Set([open]))).toBe(3);
    expect(messageIdsSince(state, THREAD)).toEqual([recent.id]);
    expect(existsSync(join(state, "channels", other))).toBe(false);
    expect(existsSync(join(state, "channels", open))).toBe(true);
    expect(existsSync(join(state, "channels", contacted))).toBe(true);
  });
});

describeUnix("reaching the host", () => {
  /** A stand-in host: answers each request with `answer(request)`. */
  function standIn(path: string, answer: (req: Record<string, unknown>) => Record<string, unknown> | null): Server {
    const server = createServer((sock) => {
      sock.setEncoding("utf8");
      let buffer = "";
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        const idx = buffer.indexOf("\n");
        if (idx === -1) return;
        const out = answer(JSON.parse(buffer.slice(0, idx)));
        if (out) sock.end(JSON.stringify(out) + "\n");
      });
      sock.on("error", () => {});
    });
    server.listen(path);
    return server;
  }

  test("askHost: a line out, a line back; silence is a timeout, not a hang", async () => {
    const path = join(ROOT, `h-${++n}.sock`);
    const server = standIn(path, (req) => (req.op === "ping" ? { ok: true } : null));
    await Bun.sleep(50);
    try {
      expect(await askHost(path, { op: "ping" })).toEqual({ ok: true });
      await expect(askHost(path, { op: "never" }, 200)).rejects.toThrow("did not answer within");
      await expect(askHost(join(ROOT, "nobody.sock"), { op: "ping" }, 200)).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  test("openChannel starts a host when none answers, and asks it for the address", async () => {
    const state = freshState();
    const path = join(ROOT, `h-${++n}.sock`);
    let server: Server | null = null;
    let started = 0;
    const seen: Array<Record<string, unknown>> = [];
    try {
      const got = await openChannel(state, ROOT, THREAD, contact(), {
        start: () => {
          started++;
          server = standIn(path, (req) => { seen.push(req); return { ok: true, name: "codex(b36a6ba4-x)", socketPath: "/thread.sock" }; });
          writeFileSync(hostStateFile(state), JSON.stringify({ pid: process.pid, procStart: null, pidDomain: null, control: path, startedAt: new Date().toISOString() }));
        },
      });
      expect(got).toEqual({ name: "codex(b36a6ba4-x)", socketPath: "/thread.sock" });
      expect(started).toBe(1);
      expect(seen).toEqual([{ op: "open", threadId: THREAD, contact: contact() }]);
      // Running, it is asked again without starting another.
      await openChannel(state, ROOT, THREAD, contact(), { start: () => { started++; } });
      expect(started).toBe(1);
    } finally {
      (server as Server | null)?.close();
    }
  });

  test("a host's refusal is reported as one, and no other host is started for it", async () => {
    const state = freshState();
    const path = join(ROOT, `h-${++n}.sock`);
    mkdirSync(join(state, "channels"), { recursive: true });
    const server = standIn(path, () => ({ ok: false, error: "no Claude Code session named" }));
    writeFileSync(hostStateFile(state), JSON.stringify({ pid: process.pid, procStart: null, pidDomain: null, control: path, startedAt: "" }));
    await Bun.sleep(50);
    let started = 0;
    try {
      await expect(openChannel(state, ROOT, THREAD, contact(), { start: () => { started++; } })).rejects.toBeInstanceOf(ChannelRefused);
      expect(started).toBe(0);
      await expect(openChannel(state, ROOT, "not-a-thread", contact())).rejects.toBeInstanceOf(ChannelRefused);
    } finally {
      server.close();
    }
  });
});
