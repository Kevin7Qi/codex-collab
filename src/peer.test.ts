// Tests for src/peer.ts — the pure pieces (envelope parse/wrap, naming,
// registry entry shape) plus capability gating. The live socket/registry
// behavior is exercised end to end by the contract tests, not here.

import { describe, expect, test } from "bun:test";
import net from "node:net";
import { spawn } from "node:child_process";
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
  peerModeFor,
  peerNameFor,
  procStartOf,
  sessionsDir,
  extractTopic,
  parseHeaders,
  threadPeerLabel,
  topicPeerLabel,
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

  test("emits from-mode LAST — the receiver re-serializes and compares byte-for-byte", () => {
    const content = JSON.parse(buildEnvelope({
      text: "body",
      ourSocketPath: "/state/peer.sock",
      ourName: "codex-proj",
      mode: "prompting",
    })).message.content as string;
    // Canonical order: from, from-session, hop-chain, from-name, from-mode.
    expect(content).toStartWith(
      '<cross-session-message from="uds:/state/peer.sock" from-name="codex-proj" from-mode="prompting">\n',
    );
    expect(content).toEndWith("\n</cross-session-message>");
  });

  test("mode is omitted when not supplied", () => {
    const content = JSON.parse(buildEnvelope({
      text: "body", ourSocketPath: "/s.sock", ourName: "n",
    })).message.content as string;
    expect(content).not.toContain("from-mode");
  });
});

describe("peerModeFor", () => {
  test("only an unsandboxed peer attests bypass", () => {
    expect(peerModeFor("danger-full-access")).toBe("bypass");
    expect(peerModeFor("workspace-write")).toBe("prompting");
    expect(peerModeFor("read-only")).toBe("prompting");
    expect(peerModeFor(undefined)).toBe("prompting");
  });
});

describe("peerNameFor", () => {
  test("prefixes codex- and sanitizes the directory name", () => {
    expect(peerNameFor("/Users/x/my proj !")).toBe("codex-my-proj");
    expect(peerNameFor("/Users/x/visa_book")).toBe("codex-visa_book");
  });

  test("a directory already leading with codex does not stutter", () => {
    expect(peerNameFor("/Users/x/codex-collab")).toBe("codex-collab");
    expect(peerNameFor("/Users/x/codex_tools")).toBe("codex-tools");
  });

  test("never produces an empty suffix", () => {
    expect(peerNameFor("/")).toBe("codex-workspace");
    expect(peerNameFor("/Users/x/codex")).toBe("codex-workspace");
  });
});

describe("extractTopic / topicPeerLabel", () => {
  test("a topic first line names the conversation and is stripped from the body", () => {
    const { topic, body } = extractTopic("topic: auth refactor\nPlease review the login flow.");
    expect(topic).toBe("auth refactor");
    expect(body).toBe("Please review the login flow.");
    expect(topicPeerLabel("auth refactor")).toBe("codex-auth-refactor");
  });

  test("subject: works too, case-insensitive", () => {
    expect(extractTopic("Subject: Fix CI\nbody").topic).toBe("Fix CI");
  });

  test("a topic-only message keeps the topic as its body", () => {
    const { topic, body } = extractTopic("topic: quick sanity check");
    expect(topic).toBe("quick sanity check");
    expect(body).toBe("quick sanity check");
  });

  test("ordinary messages pass through untouched", () => {
    const { topic, body } = extractTopic("Just do the thing.\ntopic: not a header here");
    expect(topic).toBeNull();
    expect(body).toBe("Just do the thing.\ntopic: not a header here");
  });

  test("unsluggable topics produce no label (falls back to text slug)", () => {
    expect(topicPeerLabel("！！！")).toBe("");
  });
});

describe("parseHeaders", () => {
  test("reads a full header block and strips it from the body", () => {
    const { headers, body } = parseHeaders(
      "topic: auth refactor\nmodel: gpt-5.6-sol\neffort: xhigh\nsandbox: read-only\napproval: auto\n\nReview the login flow.",
    );
    expect(headers).toEqual({
      topic: "auth refactor",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      sandbox: "read-only",
      approval: "auto",
    });
    expect(body).toBe("Review the login flow.");
  });

  test("stops at the first line that is not a recognized header", () => {
    const { headers, body } = parseHeaders("topic: x\nNote: this is prose, not a header\nmore");
    expect(headers.topic).toBe("x");
    expect(body).toBe("Note: this is prose, not a header\nmore");
  });

  test("prose containing a colon is never eaten", () => {
    const text = "Fix this: the parser drops values\nsecond line";
    expect(parseHeaders(text).body).toBe(text);
    expect(parseHeaders(text).headers.topic).toBeNull();
  });

  test("an invalid value ends the block instead of vanishing", () => {
    // "ludicrous" is not a valid effort — the line must survive as text so a
    // typo is visible to Codex rather than silently ignored.
    const { headers, body } = parseHeaders("effort: ludicrous\ndo the thing");
    expect(headers.effort).toBeUndefined();
    expect(body).toContain("effort: ludicrous");
  });

  test("only `auto` is accepted for approval", () => {
    expect(parseHeaders("approval: auto\nx").headers.approval).toBe("auto");
    expect(parseHeaders("approval: on-request\nx").headers.approval).toBeUndefined();
  });

  test("model values must be slug-shaped — prose is never eaten as a model", () => {
    expect(parseHeaders("model: gpt-5.6-luna\nx").headers.model).toBe("gpt-5.6-luna");
    const prose = "model: the new one is broken\nplease investigate";
    expect(parseHeaders(prose).headers.model).toBeUndefined();
    expect(parseHeaders(prose).body).toBe(prose);
  });

  test("a header-only message keeps its topic as the body", () => {
    const { headers, body } = parseHeaders("topic: quick check\nmodel: gpt-5.5");
    expect(headers.topic).toBe("quick check");
    expect(body).toBe("quick check");
  });
});

describe("threadPeerLabel", () => {
  test("derives a topic slug from the first message plus a short-id suffix", () => {
    expect(threadPeerLabel("Investigate the flaky broker test", "a1b2c3d4"))
      .toBe("codex-investigate-the-flaky-a1b2");
    expect(threadPeerLabel("Fix bug", "a1b2c3d4")).toBe("codex-fix-bug-a1b2");
  });

  test("bounds the slug and survives punctuation", () => {
    const label = threadPeerLabel("Re: [urgent!!] please, PLEASE review the enormous refactoring branch", "deadbeef");
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.startsWith("codex-re-urgent-please-")).toBe(true);
    expect(label.endsWith("-dead")).toBe(true);
  });

  test("non-ASCII text falls back to the bare suffix", () => {
    expect(threadPeerLabel("调查一下这个测试为什么不稳定", "a1b2c3d4")).toBe("codex-a1b2");
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

describe("topic routing", () => {
  test("a topic starts a SECOND conversation for the same sender, and reusing it continues that one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    registerTestSender(join(dir, "sessions"), join(dir, "sender.sock"));

    const started: string[] = [];
    const injected: string[] = [];
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") { started.push("x"); return { thread: { id: `thread-${++n}` } }; }
        if (method === "thread/inject_items") {
          const items = params!.items as Array<{ content: Array<{ text: string }> }>;
          injected.push(`${params!.threadId}:${items[0].content[0].text}`);
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true, // stay mid-turn: no turn/start, just injection
      log: () => {},
    };

    const peer = createPeer(host);
    const send = async (text: string) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, "sender.sock"), ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 250));
    };

    try {
      await send("topic: alpha work\nfirst");
      await send("topic: beta work\nsecond");
      await send("topic: alpha work\nthird");
      await send("fourth");

      // Two topics → two threads (the fourth message names none, so it
      // continues the sender's most recent conversation: beta).
      expect(started.length).toBe(2);
      // The topic line never reaches Codex.
      expect(injected.some((i) => i.includes("topic:"))).toBe(false);
      expect(injected).toEqual([
        "thread-1:[test-sender] first",
        "thread-2:[test-sender] second",
        "thread-1:[test-sender] third",   // reopened alpha
        "thread-2:[test-sender] fourth",  // no topic → most recent (beta)
      ]);
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("delivery honesty", () => {
  /** Bind a listening socket at `path` collecting delivered envelope lines. */
  function listenForDeliveries(path: string): { lines: string[]; close: () => void } {
    const lines: string[] = [];
    const server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l) lines.push(l);
        }
      });
    });
    server.listen(path);
    return { lines, close: () => server.close() };
  }

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  test("an interrupted turn's partial text carries a note, and from-mode reflects the conversation's sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const senderSock = join(dir, "sender.sock");
    registerTestSender(join(dir, "sessions"), senderSock);
    const inbox = listenForDeliveries(senderSock);

    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    const requests: string[] = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        requests.push(method);
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      threadHasTurn: () => false, // idle → the peer starts (and owns) a turn
      log: () => {},
    };

    const peer = createPeer(host);
    try {
      const line = buildEnvelope({
        text: "sandbox: danger-full-access\nplease do the thing",
        ourSocketPath: senderSock,
        ourName: "test-sender",
      });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      await until(() => owners.has("thread-X"));
      const owner = owners.get("thread-X")!;
      owner.onNotification("item/completed", {
        threadId: "thread-X",
        item: { type: "agentMessage", text: "partial thoughts" },
      });
      owner.onNotification("turn/completed", {
        threadId: "thread-X",
        turn: { status: "interrupted", error: null },
      });
      await until(() => inbox.lines.length > 0);
      const delivered = parseEnvelope(inbox.lines[0])!;
      // The partial text arrives — but never disguised as a finished reply.
      expect(delivered.text).toContain("partial thoughts");
      expect(delivered.text).toContain("the turn interrupted");
      // The conversation runs danger-full-access (header override), so its
      // outbound messages attest "bypass" — not the workspace default's mode.
      const content = (JSON.parse(inbox.lines[0]) as { message: { content: string } }).message.content;
      expect(content).toContain('from-mode="bypass"');
    } finally {
      peer.stop();
      inbox.close();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a continuation's model:/effort: headers apply from the next turn; sandbox: draws a notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const senderSock = join(dir, "sender.sock");
    registerTestSender(join(dir, "sessions"), senderSock);
    const inbox = listenForDeliveries(senderSock);

    const turnStarts: Array<Record<string, unknown>> = [];
    let threadsStarted = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") { threadsStarted++; return { thread: { id: "thread-X" } }; }
        if (method === "turn/start") turnStarts.push(params!);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };

    const peer = createPeer(host);
    const send = async (text: string) => {
      const line = buildEnvelope({ text, ourSocketPath: senderSock, ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
    };

    try {
      await send("topic: t\nmodel: gpt-5.6-luna\ndo it");
      await until(() => turnStarts.length === 1);
      expect(turnStarts[0].model).toBe("gpt-5.6-luna");

      // The recovery path: a later message corrects the model.
      await send("topic: t\nmodel: gpt-5.4-mini\neffort: low\ncontinue");
      await until(() => turnStarts.length === 2);
      expect(threadsStarted).toBe(1); // same conversation, not a new thread
      expect(turnStarts[1].model).toBe("gpt-5.4-mini");
      expect(turnStarts[1].effort).toBe("low");

      // sandbox on a continuation cannot apply — the sender must hear that.
      await send("topic: t\nsandbox: read-only\nand this");
      await until(() => inbox.lines.some((l) => parseEnvelope(l)?.text.includes("fixed when a conversation starts")));
    } finally {
      peer.stop();
      inbox.close();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a processing failure notifies the sender instead of silently dropping the message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const senderSock = join(dir, "sender.sock");
    registerTestSender(join(dir, "sessions"), senderSock);
    const inbox = listenForDeliveries(senderSock);

    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") throw new Error("model rejected: no-such-model");
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };

    const peer = createPeer(host);
    try {
      const line = buildEnvelope({
        text: "model: no-such-model\ndo the thing",
        ourSocketPath: senderSock,
        ourName: "test-sender",
      });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      await until(() => inbox.lines.length > 0);
      const delivered = parseEnvelope(inbox.lines[0])!;
      expect(delivered.text).toContain("could not be processed");
      expect(delivered.text).toContain("no-such-model");
    } finally {
      peer.stop();
      inbox.close();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("peerCapability fallback gating", () => {
  /** Run `fn` against an isolated registry containing `entries`. */
  function withRegistry(entries: Array<Record<string, unknown>>, fn: () => void): void {
    const dir = mkdtempSync(join(tmpdir(), "peer-cap-"));
    const prev = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = dir;
    try {
      entries.forEach((e, i) => writeFileSync(join(dir, `s${i}.json`), JSON.stringify(e)));
      fn();
    } finally {
      if (prev === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an older Claude Code — live sessions, none binding a messaging socket — is unsupported", () => {
    const child = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      expect(child.pid).toBeGreaterThan(0);
      withRegistry([{ pid: child.pid, name: "old-session" }], () => {
        const cap = peerCapability();
        expect(cap.ok).toBe(false);
        expect(cap.reason).toContain("no messaging sockets");
      });
    } finally {
      child.kill();
    }
  });

  test("a messaging-capable session enables the peer", () => {
    const child = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      withRegistry(
        [{ pid: child.pid, name: "new-session", messagingSocketPath: "/tmp/cc-socks/x.sock" }],
        () => expect(peerCapability().ok).toBe(true),
      );
    } finally {
      child.kill();
    }
  });

  test("no live sessions is inconclusive, not negative — one may start later", () => {
    withRegistry([{ pid: 4900777, name: "dead-session" }], () => {
      expect(peerCapability().ok).toBe(true);
    });
  });
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
