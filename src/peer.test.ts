// Tests for src/peer.ts — the pure pieces (envelope parse/wrap, naming,
// registry entry shape) plus capability gating. The live socket/registry
// behavior is exercised end to end by the contract tests, not here.

import { describe, expect, test } from "bun:test";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import {
  buildEnvelope,
  buildRegistryEntry,
  createPeer,
  parseEnvelope,
  peerCapability,
  peerNameFor,
  procStartOf,
  sessionsDir,
  type PeerHost,
} from "./peer";

/** Register a fake-but-valid sender in an isolated registry so the peer's
 *  registered-sender gate admits its messages. Uses OUR pid (alive, with a
 *  matching procStart) — the same liveness rules the real registry uses. */
function registerTestSender(sessionsDirPath: string, senderSocket: string): void {
  const entry = buildRegistryEntry({
    pid: process.pid,
    cwd: "/tmp",
    name: "test-sender",
    socketPath: senderSocket,
    version: "2.1.226",
    procStart: procStartOf(process.pid),
    sessionId: "00000000-0000-4000-8000-000000000009",
  });
  // NOT `${process.pid}.json` — the peer under test writes its own front
  // door there (same process) and would clobber this registration. The
  // sender gate reads every *.json and checks content, not filenames.
  writeFileSync(join(sessionsDirPath, "test-sender.json"), JSON.stringify(entry));
}

describe("parseEnvelope", () => {
  const wrap = (text: string, fromName = "codex-collab-bf") =>
    `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="${fromName}">\n${text}\n</cross-session-message>`;

  const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({
    msgV: 1,
    msg_id: "m-1",
    type: "user",
    message: { role: "user", content: wrap("hello codex") },
    priority: "next",
    from: "uds:/tmp/cc-socks/1.sock",
    ...over,
  });

  test("parses a wrapped user message", () => {
    const msg = parseEnvelope(envelope());
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe("hello codex");
    expect(msg!.fromName).toBe("codex-collab-bf");
    expect(msg!.replyPath).toBe("/tmp/cc-socks/1.sock");
    expect(msg!.msgId).toBe("m-1");
  });

  test("from-name is found regardless of attribute order", () => {
    const content =
      `<cross-session-message from-name="first-attr" from="uds:/x.sock">\nhi\n</cross-session-message>`;
    const msg = parseEnvelope(envelope({ message: { role: "user", content } }));
    expect(msg!.fromName).toBe("first-attr");
  });

  test("falls back to raw content when no wrapper is present", () => {
    const msg = parseEnvelope(envelope({ message: { role: "user", content: "bare text" } }));
    expect(msg!.text).toBe("bare text");
    expect(msg!.fromName).toBe("claude");
  });

  test("rejects control frames, malformed JSON, and missing from", () => {
    expect(parseEnvelope(envelope({ type: "control" }))).toBeNull();
    expect(parseEnvelope("{not json")).toBeNull();
    expect(parseEnvelope(envelope({ from: undefined }))).toBeNull();
  });

  test("rejects empty text", () => {
    const msg = parseEnvelope(envelope({ message: { role: "user", content: wrap("   ") } }));
    expect(msg).toBeNull();
  });
});

describe("buildEnvelope", () => {
  test("produces a newline-terminated envelope the parser round-trips", () => {
    const line = buildEnvelope({
      text: "reply body",
      ourSocketPath: "/state/peer.sock",
      ourName: "codex-proj",
    });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = parseEnvelope(line.trim());
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("reply body");
    expect(parsed!.fromName).toBe("codex-proj");
    expect(parsed!.replyPath).toBe("/state/peer.sock");
  });
});

describe("peerNameFor", () => {
  test("prefixes codex- and sanitizes the directory name", () => {
    expect(peerNameFor("/Users/x/my proj !")).toBe("codex-my-proj");
    expect(peerNameFor("/Users/x/visa_book")).toBe("codex-visa_book");
  });

  test("never produces an empty suffix", () => {
    expect(peerNameFor("/")).toBe("codex-workspace");
  });
});

describe("buildRegistryEntry", () => {
  test("carries the fields the registry validator binds", () => {
    const entry = buildRegistryEntry({
      pid: 1234,
      cwd: "/w",
      name: "codex-w",
      socketPath: "/state/peer.sock",
      version: "2.1.226",
      procStart: "Sat Aug  8 10:47:21 2026",
      sessionId: "s-1",
    });
    expect(entry.pid).toBe(1234);
    expect(entry.procStart).toBe("Sat Aug  8 10:47:21 2026"); // padding preserved
    expect(entry.messagingSocketPath).toBe("/state/peer.sock");
    expect(entry.peerProtocol).toBe(1);
    expect(entry.nameSource).toBe("explicit");
  });
});

describe("claim release on turn-start failure", () => {
  test("a failed turn/start releases the thread claim instead of leaking it", async () => {
    // Isolated registry + state dir: the peer must never touch the real one.
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true }); // capability gate requires it
    registerTestSender(join(dir, "sessions"), join(dir, "sender.sock"));

    const released: string[] = [];
    const claimed = new Set<string>();
    const requests: string[] = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        requests.push(method);
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") throw new Error("simulated turn/start failure");
        return {};
      },
      claimThread: (threadId) => { claimed.add(threadId); return true; },
      releaseThread: (threadId) => { released.push(threadId); },
      threadHasTurn: () => false,
      log: () => {},
    };

    const peer = createPeer(host);
    try {
      expect(peer.active).toBe(true);
      // Deliver a message through the real front-door socket.
      const line = buildEnvelope({
        text: "hello",
        ourSocketPath: join(dir, "sender.sock"),
        ourName: "test-sender",
      });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => {
          sock.write(line);
          sock.end();
          resolve();
        });
        sock.on("error", reject);
      });
      // The failed turn/start must have released the claim it took.
      await new Promise((r) => setTimeout(r, 300));
      expect(requests).toContain("turn/start");
      expect(claimed.has("thread-X")).toBe(true);
      expect(released).toContain("thread-X");
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("inbound serialization", () => {
  test("two back-to-back messages from a new sender create ONE thread, not two", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    registerTestSender(join(dir, "sessions"), join(dir, "sender.sock"));

    const requests: string[] = [];
    let started = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        requests.push(method);
        if (method === "thread/start") {
          // A real thread/start takes a moment — the suspension window in
          // which the second message used to sneak past the map lookup.
          await new Promise((r) => setTimeout(r, 50));
          return { thread: { id: `thread-${++started}` } };
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };

    const peer = createPeer(host);
    try {
      expect(peer.active).toBe(true);
      const envelope = (n: number) => buildEnvelope({
        text: `message ${n}`,
        ourSocketPath: join(dir, "sender.sock"),
        ourName: "test-sender",
      });
      // Both lines in ONE write: the exact burst shape Claude Code produces
      // when draining queued sends.
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => {
          sock.write(envelope(1) + envelope(2));
          sock.end();
          resolve();
        });
        sock.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(requests.filter((m) => m === "thread/start").length).toBe(1);
      // Both messages were delivered to the one thread.
      expect(requests.filter((m) => m === "thread/inject_items").length).toBe(2);
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("peerCapability", () => {
  test("CODEX_COLLAB_PEER=off disables", () => {
    const prev = process.env.CODEX_COLLAB_PEER;
    process.env.CODEX_COLLAB_PEER = "off";
    try {
      expect(peerCapability().ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODEX_COLLAB_PEER;
      else process.env.CODEX_COLLAB_PEER = prev;
    }
  });

  test("sessionsDir honors the test override", () => {
    const prev = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = "/tmp/fake-sessions";
    try {
      expect(sessionsDir()).toBe("/tmp/fake-sessions");
    } finally {
      if (prev === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prev;
    }
  });
});
