// Tests for src/peer.ts — the pure pieces (envelope parse/wrap, naming,
// registry entry shape) plus capability gating. The live socket/registry
// behavior is exercised end to end by the contract tests, not here.

import { describe, expect, test } from "bun:test";
import { config } from "./config";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  isCodexCollabSocket,
  procStartOf,
  sessionsDir,
  extractTopic,
  parseHeaders,
  threadPeerLabel,
  topicPeerLabel,
  type PeerHost,
} from "./peer";

/** The peer never activates on Windows — peerCapability gates win32 before
 *  anything else runs — so the socket/registry integration behavior under
 *  test does not exist there: procStartOf shells out to POSIX `ps`, sockets
 *  bind Unix paths, and capability's registry scan is unreachable. Skipping
 *  mirrors production's own gate. */
const onWindows = process.platform === "win32";

/** Register a fake-but-valid sender in an isolated registry so the peer's
 *  registered-sender gate admits its messages. Uses OUR pid (alive, with a
 *  matching procStart) — the same liveness rules the real registry uses. */
function registerTestSender(sessionsDirPath: string, senderSocket: string, who = "test-sender"): void {
  const entry = buildRegistryEntry({
    pid: process.pid,
    cwd: "/tmp",
    name: who,
    socketPath: senderSocket,
    version: "2.1.226",
    procStart: procStartOf(process.pid),
    sessionId: "00000000-0000-4000-8000-000000000009",
  });
  // NOT `${process.pid}.json` — the peer under test writes its own front
  // door there (same process) and would clobber this registration. The
  // sender gate reads every *.json and checks content, not filenames.
  // One file per sender, so registering several does not overwrite them.
  writeFileSync(join(sessionsDirPath, `${who}.json`), JSON.stringify(entry));
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
  /** The workspace portion: what sits inside codex(...) minus the hash. */
  const workspace = (name: string) =>
    name.replace(/^codex\(/, "").replace(/-[0-9a-f]{6}\)$/, "");

  test("names the agent first and carries the workspace in parentheses", () => {
    expect(peerNameFor("/Users/x/visa_book")).toMatch(/^codex\(visa_book-[0-9a-f]{6}\)$/);
  });

  test("sanitizes the directory name", () => {
    expect(workspace(peerNameFor("/Users/x/my proj !"))).toBe("my-proj");
    expect(workspace(peerNameFor("/Users/x/visa_book"))).toBe("visa_book");
  });

  // "codex" is the AGENT, not a token to deduplicate. Stripping it from a
  // codex-named directory made the address indistinguishable from Claude
  // Code's own session name for the same folder (codex-collab-96).
  test("a codex-named directory keeps its full name", () => {
    expect(workspace(peerNameFor("/Users/x/codex-collab"))).toBe("codex-collab");
    expect(workspace(peerNameFor("/Users/x/codex_tools"))).toBe("codex_tools");
  });

  test("never produces an empty workspace", () => {
    expect(workspace(peerNameFor("/"))).toBe("workspace");
    expect(workspace(peerNameFor("/Users/x/codex"))).toBe("codex");
  });

  test("carries no character that collides with an addressing syntax", () => {
    const name = peerNameFor("/Users/x/my proj !");
    // [] is Claude Code's ref suffix, @ its mention syntax, and whitespace
    // breaks selection and shell use. <>&" would need XML escaping in the
    // from-name attribute the receiver compares byte-for-byte.
    expect(name).not.toMatch(/[\[\]@\/\s<>&"]/);
  });

  // The address lives in a registry shared by every workspace on the
  // machine, so a name collision routes SendMessage to the wrong broker.
  test("checkouts sharing a directory name get DIFFERENT addresses", () => {
    const a = peerNameFor("/Users/x/work/api/codex-collab");
    const b = peerNameFor("/Users/x/other/codex-collab");
    expect(workspace(a)).toBe(workspace(b)); // same readable workspace
    expect(a).not.toBe(b);                   // but distinct addresses
  });

  test("names that sanitize to the same workspace still differ", () => {
    expect(peerNameFor("/Users/x/my.proj")).not.toBe(peerNameFor("/Users/x/my-proj"));
  });

  test("a very long directory name is truncated without clipping the hash", () => {
    const name = peerNameFor(`/Users/x/${"a".repeat(120)}`);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toMatch(/^codex\(a+-[0-9a-f]{6}\)$/);
  });
});

describe("isCodexCollabSocket", () => {
  test("recognizes our own broker sockets and not Claude's", () => {
    expect(isCodexCollabSocket(`${config.dataDir}/workspaces/foo-abc/peer.sock`)).toBe(true);
    expect(isCodexCollabSocket("/tmp/cc-socks/68002.sock")).toBe(false);
  });

  test("a path that merely starts with the same characters is not ours", () => {
    expect(isCodexCollabSocket(`${config.dataDir}-evil/peer.sock`)).toBe(false);
  });

  test("missing or malformed values are not ours", () => {
    expect(isCodexCollabSocket(undefined)).toBe(false);
    expect(isCodexCollabSocket("")).toBe(false);
    expect(isCodexCollabSocket(42)).toBe(false);
  });
});

describe("extractTopic / topicPeerLabel", () => {
  test("a topic first line names the conversation and is stripped from the body", () => {
    const { topic, body } = extractTopic("topic: auth refactor\nPlease review the login flow.");
    expect(topic).toBe("auth refactor");
    expect(body).toBe("Please review the login flow.");
    expect(topicPeerLabel("auth refactor")).toBe("codex(auth-refactor)");
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
      .toBe("codex(investigate-the-flaky-a1b2)");
    expect(threadPeerLabel("Fix bug", "a1b2c3d4")).toBe("codex(fix-bug-a1b2)");
  });

  test("bounds the slug and survives punctuation", () => {
    const label = threadPeerLabel("Re: [urgent!!] please, PLEASE review the enormous refactoring branch", "deadbeef");
    expect(label.length).toBeLessThanOrEqual(40);
    expect(label.startsWith("codex(re-urgent-please-")).toBe(true);
    expect(label.endsWith("-dead)")).toBe(true);
  });

  test("non-ASCII text falls back to the bare suffix", () => {
    expect(threadPeerLabel("调查一下这个测试为什么不稳定", "a1b2c3d4")).toBe("codex(a1b2)");
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

describe.skipIf(onWindows)("claim release on turn-start failure", () => {
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

describe.skipIf(onWindows)("liveness scan", () => {
  // The broker stays resident while any live Claude session is registered.
  // Every codex-collab broker also registers itself, so without excluding
  // siblings each of two workspaces counts the other as an external Claude
  // session: after the last real session exits, both idle timers reset
  // forever and both brokers plus their app-server children never retire.
  test("a sibling codex-collab broker does not count as a live Claude session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-live-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });

    // A holder process stands in for the other broker: a live pid that is
    // not this process, so `ours` cannot filter it out by pid alone.
    const holder = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    await new Promise((r) => setTimeout(r, 300));
    if (!holder.pid) throw new Error("holder spawn failed");

    const registerAs = (name: string, socketPath: string) => {
      writeFileSync(
        join(dir, "sessions", `${holder.pid}.json`),
        JSON.stringify(buildRegistryEntry({
          pid: holder.pid!,
          cwd: "/tmp",
          name,
          socketPath,
          version: "2.1.226",
          procStart: procStartOf(holder.pid!),
          sessionId: "00000000-0000-4000-8000-00000000000b",
        })),
      );
    };

    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async () => ({}),
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };

    const peer = createPeer(host);
    try {
      // Another workspace's broker — socket under ~/.codex-collab.
      registerAs("codex-other", join(config.dataDir, "workspaces", "other-abc123", "peer.sock"));
      expect(peer.hasLiveSessions()).toBe(false);

      // A real Claude session at the same live pid — socket under /tmp/cc-socks.
      registerAs("real-claude-session", "/tmp/cc-socks/9999.sock");
      expect(peer.hasLiveSessions()).toBe(true);
    } finally {
      peer.stop();
      holder.kill();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(onWindows)("inbound serialization", () => {
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

describe.skipIf(onWindows)("topic routing", () => {
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
      // continues whichever conversation the sender spoke to LAST — alpha,
      // reopened by the third message).
      expect(started.length).toBe(2);
      // The topic line never reaches Codex.
      expect(injected.some((i) => i.includes("topic:"))).toBe(false);
      expect(injected).toEqual([
        "thread-1:[test-sender] first",
        "thread-2:[test-sender] second",
        "thread-1:[test-sender] third",   // reopened alpha
        "thread-1:[test-sender] fourth",  // no topic → alpha (spoken to last)
      ]);
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe.skipIf(onWindows)("delivery honesty", () => {
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

describe.skipIf(onWindows)("conversation resilience", () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const senderSock = join(dir, "sender.sock");
    registerTestSender(join(dir, "sessions"), senderSock);
    const send = async (text: string) => {
      const line = buildEnvelope({ text, ourSocketPath: senderSock, ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 250));
    };
    const cleanup = () => {
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, send, cleanup };
  }

  test("an unrecoverable thread is recreated with the conversation's own settings, not this message's", async () => {
    const { dir, send, cleanup } = harness();
    const threadStarts: Array<Record<string, unknown>> = [];
    const injectFailFor = new Set<string>();
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") { threadStarts.push(params!); return { thread: { id: `thread-${++n}` } }; }
        if (method === "thread/inject_items" && injectFailFor.has(params!.threadId as string)) {
          throw new Error("thread not found");
        }
        if (method === "thread/resume") throw new Error("thread not found");
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true, // injection only — turns are not the subject here
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: t\nsandbox: read-only\napproval: auto\nmodel: gpt-5.4-mini\nhi");
      expect(threadStarts.length).toBe(1);
      expect(threadStarts[0].sandbox).toBe("read-only");

      injectFailFor.add("thread-1"); // thread dies; resume fails too → recovery
      await send("continue"); // a plain continuation: NO headers
      expect(threadStarts.length).toBe(2);
      // The recreated thread keeps what the conversation was created with —
      // sandbox must not escalate to the workspace default, and the Guardian
      // approval and model must survive.
      expect(threadStarts[1].sandbox).toBe("read-only");
      expect(threadStarts[1].approvalsReviewer).toBe("auto_review");
      expect(threadStarts[1].model).toBe("gpt-5.4-mini");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a message the running turn never sampled wakes the thread when the turn ends", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst");
      expect(turnStarts.length).toBe(1);

      hasTurn = true; // a turn is running: the follow-up is injected only
      await send("second");
      expect(turnStarts.length).toBe(1);

      // A command starting late is NOT proof the model sampled after the
      // injection — it may have been chosen by an earlier sample.
      owners.get("thread-X")!.onNotification("item/started", { threadId: "thread-X", item: { type: "commandExecution" } });

      hasTurn = false; // the turn ended without ever sampling the injection
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 250));
      expect(turnStarts.length).toBe(2);
      const input = turnStarts[1].input as Array<{ text: string }>;
      expect(input[0].text).toContain("while the previous turn was running");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("items produced after the injection are NOT taken as proof the turn read it", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst");
      hasTurn = true;
      await send("second");
      // Even reasoning/agentMessage can come from a request whose context
      // was fixed BEFORE the injection, so none of it proves the message was
      // read. The wake happens regardless — a redundant confirmation turn is
      // the acceptable cost; a dropped message is not.
      const owner = owners.get("thread-X")!;
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "reasoning" } });
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "agentMessage" } });
      hasTurn = false;
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 250));
      expect(turnStarts.length).toBe(2);
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a wake waits for a turn that is still running instead of dropping the debt", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst");
      hasTurn = true;
      await send("second");

      // A turn is STILL running when this fires (a CLI run claimed the
      // thread in the gap). Its reply goes to its own client, so the debt
      // must survive rather than be marked settled.
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 150));
      expect(turnStarts.length).toBe(1);

      hasTurn = false;
      peer.onThreadTurnEnded("thread-X"); // now it really is over
      await new Promise((r) => setTimeout(r, 250));
      expect(turnStarts.length).toBe(2);
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a failed turn/start does not tear down the replacement turn it triggers", async () => {
    const { dir, send, cleanup } = harness();
    const senderSock = join(dir, "sender.sock");
    const inboxLines: string[] = [];
    const inboxServer = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l) inboxLines.push(l);
        }
      });
    });
    inboxServer.listen(senderSock);

    const turnStarts: string[] = [];
    const owners: Array<{ onNotification(m: string, p?: Record<string, unknown>): void }> = [];
    let claimed = false;
    let failNext = true;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") {
          if (failNext) {
            failNext = false;
            turnStarts.push("failing");
            // Stay in flight long enough for a second message to arrive and
            // record a wake debt — the precondition for the re-entrancy.
            await new Promise((r) => setTimeout(r, 400));
            throw new Error("simulated turn/start failure");
          }
          turnStarts.push("replacement");
        }
        return {};
      },
      claimThread: (_t, owner) => { if (claimed) return false; claimed = true; owners.push(owner); return true; },
      // The worst case for the peer's failure path: the broker releases and
      // re-enters the peer synchronously, from inside that path's own call.
      releaseThread: (threadId) => { claimed = false; peer.onThreadTurnEnded(threadId); },
      threadHasTurn: () => claimed,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      const first = send("topic: r\nkick it off"); // claims, turn/start in flight
      await new Promise((r) => setTimeout(r, 200));
      // Second message arrives on the conversation's OWN socket — a
      // different inbound queue, so it interleaves with the first.
      const tpSock = readdirSync(dir).find((f) => f.startsWith("peer-") && f.endsWith(".sock"));
      expect(tpSock).toBeDefined();
      const line = buildEnvelope({ text: "and also this", ourSocketPath: senderSock, ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const s = net.connect({ path: join(dir, tpSock!) }, () => { s.write(line); s.end(); resolve(); });
        s.on("error", reject);
      });
      await first;
      await new Promise((r) => setTimeout(r, 400));

      // The failure released the claim, the wake started a replacement.
      expect(turnStarts).toEqual(["failing", "replacement"]);
      // The replacement's reply buffer must have survived the failure path's
      // cleanup — completing it now must deliver its output to the sender.
      owners[owners.length - 1].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "replacement answer" },
      });
      owners[owners.length - 1].onNotification("turn/completed", {
        threadId: "thread-X", turn: { status: "completed", error: null },
      });
      await new Promise((r) => setTimeout(r, 250));
      expect(inboxLines.some((l) => parseEnvelope(l)?.text.includes("replacement answer"))).toBe(true);
    } finally {
      peer.stop();
      inboxServer.close();
      cleanup();
    }
  }, 20_000);

  test("the sender's default follows the conversations still addressed to them", async () => {
    const { dir, send, cleanup } = harness();
    const injected: string[] = [];
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: `thread-${++n}` } };
        if (method === "thread/inject_items") injected.push(params!.threadId as string);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: alpha\none");
      await send("topic: beta\ntwo");

      // The default is whichever was spoken to last — beta.
      await send("no topic here");
      expect(injected[injected.length - 1]).toBe("thread-2");

      // Reopening the older topic makes IT the default again, and a turn
      // completing on beta afterwards must not steal the default back:
      // completion is activity, not the sender speaking.
      await send("topic: alpha\nback to alpha");
      await send("no topic again");
      expect(injected[injected.length - 1]).toBe("thread-1");
      expect(n).toBe(2); // never started a third thread
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("no participant in a shared conversation is left without an answer", async () => {
    const { dir, cleanup } = harness();
    // Two registered senders, each with its own inbox.
    const inboxes = new Map<string, string[]>();
    const servers: net.Server[] = [];
    for (const who of ["a", "b"]) {
      const sock = join(dir, `${who}.sock`);
      const lines: string[] = [];
      inboxes.set(who, lines);
      const srv = net.createServer((c) => {
        c.setEncoding("utf8");
        let buf = "";
        c.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            const l = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (l) lines.push(l);
          }
        });
      });
      srv.listen(sock);
      servers.push(srv);
      registerTestSender(join(dir, "sessions"), sock, `session-${who}`);
    }
    const sendAs = async (who: string, text: string, target = join(dir, "peer.sock")) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, `${who}.sock`), ourName: `session-${who}` });
      await new Promise<void>((resolve, reject) => {
        const s = net.connect({ path: target }, () => { s.write(line); s.end(); resolve(); });
        s.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 250));
    };

    const owners: Array<{ onNotification(m: string, p?: Record<string, unknown>): void }> = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: (_t, owner) => { owners.push(owner); hasTurn = true; return true; },
      releaseThread: () => { hasTurn = false; },
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await sendAs("a", "topic: shared\nA's question");   // A's turn starts
      const tpSock = readdirSync(dir).find((f) => f.startsWith("peer-") && f.endsWith(".sock"));
      await sendAs("b", "B butting in", join(dir, tpSock!)); // B joins mid-turn

      // A's turn finishes. Its answer belongs to A alone.
      owners[0].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "answer for A" },
      });
      hasTurn = false;
      owners[0].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await new Promise((r) => setTimeout(r, 250));

      const aTexts = inboxes.get("a")!.map((l) => parseEnvelope(l)!.text);
      const bTexts = inboxes.get("b")!.map((l) => parseEnvelope(l)!.text);
      // A asked, so A must get the answer — the bug guarded against here is
      // A getting nothing because B spoke last. B joined before the turn
      // ended, so the turn is answering B as well and B receives it too:
      // the conversation is shared, not stolen.
      expect(aTexts.some((t) => t.includes("answer for A"))).toBe(true);
      expect(bTexts.some((t) => t.includes("answer for A"))).toBe(true);

      // B is not forgotten either: B's message earned a wake, and that
      // turn's answer goes to B.
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 250));
      expect(owners.length).toBe(2);
      owners[1].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "answer for B" },
      });
      owners[1].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await new Promise((r) => setTimeout(r, 250));
      expect(inboxes.get("b")!.map((l) => parseEnvelope(l)!.text).some((t) => t.includes("answer for B"))).toBe(true);

      // And the conversation is still in A's history despite B's message.
      await sendAs("a", "no topic from A");
      expect(readdirSync(dir).filter((f) => f.startsWith("peer-") && f.endsWith(".sock")).length).toBe(1);
    } finally {
      peer.stop();
      for (const s of servers) s.close();
      cleanup();
    }
  }, 20_000);

  test("a late turn-ended hook does not disturb the turn that replaced it", async () => {
    const { dir, cleanup } = harness();
    const inboxes = new Map<string, string[]>();
    const servers: net.Server[] = [];
    for (const who of ["a", "b"]) {
      const sock = join(dir, `${who}.sock`);
      const lines: string[] = [];
      inboxes.set(who, lines);
      const srv = net.createServer((c) => {
        c.setEncoding("utf8");
        let buf = "";
        c.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            const l = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (l) lines.push(l);
          }
        });
      });
      srv.listen(sock);
      servers.push(srv);
      registerTestSender(join(dir, "sessions"), sock, `session-${who}`);
    }
    const sendAs = async (who: string, text: string, target = join(dir, "peer.sock")) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, `${who}.sock`), ourName: `session-${who}` });
      await new Promise<void>((resolve, reject) => {
        const c = net.connect({ path: target }, () => { c.write(line); c.end(); resolve(); });
        c.on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 250));
    };

    const owners: Array<{ onNotification(m: string, p?: Record<string, unknown>): void }> = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: (_t, owner) => { owners.push(owner); hasTurn = true; return true; },
      releaseThread: () => { hasTurn = false; },
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await sendAs("a", "topic: gap\nfirst");                 // turn 1, audience {A}
      hasTurn = false;
      owners[0].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await sendAs("a", "second");                            // turn 2 claims, audience {A}
      // Turn 1's hook was deferred and only lands now — after turn 2 owns
      // the thread. It must not touch turn 2's state.
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 100));
      await sendAs("b", "me too");                            // B joins turn 2

      owners[owners.length - 1].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "answer for both" },
      });
      hasTurn = false;
      owners[owners.length - 1].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await new Promise((r) => setTimeout(r, 250));

      // A asked for turn 2 — a wiped audience would have delivered only to
      // B, the most recent speaker, and left A with nothing.
      expect(inboxes.get("a")!.map((l) => parseEnvelope(l)!.text).some((t) => t.includes("answer for both"))).toBe(true);
    } finally {
      peer.stop();
      for (const s of servers) s.close();
      cleanup();
    }
  }, 20_000);

  test("a completed conversation leaves no per-thread state behind", async () => {
    const { dir, send, cleanup } = harness();
    let hasTurn = false;
    const owners: Array<{ onNotification(m: string, p?: Record<string, unknown>): void }> = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: (_t, owner) => { owners.push(owner); hasTurn = true; return true; },
      releaseThread: () => { hasTurn = false; },
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: tidy\ndo it");
      owners[0].onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "done" } });
      hasTurn = false;
      owners[0].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      // The ordinary release: no message was injected mid-turn, so there is
      // no pending wake — the path that used to skip the only cleanup.
      peer.onThreadTurnEnded("thread-X");
      await new Promise((r) => setTimeout(r, 150));
      expect(peer.debugState().turnRecipients).toBe(0);
      expect(peer.debugState().pendingWakes).toBe(0);
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a conversation remembers only its most recent senders", async () => {
    const { dir, cleanup } = harness();
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true, // injection only
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      // Each Claude session brings a new socket path; without a bound the
      // map grows forever and every message re-serializes all of it.
      for (let i = 0; i < 12; i++) {
        const sock = join(dir, `s${i}.sock`);
        registerTestSender(join(dir, "sessions"), sock, `session-${i}`);
        const line = buildEnvelope({ text: "topic: shared\nhello", ourSocketPath: sock, ourName: `session-${i}` });
        await new Promise<void>((resolve, reject) => {
          const c = net.connect({ path: join(dir, "peer.sock") }, () => { c.write(line); c.end(); resolve(); });
          c.on("error", reject);
        });
        await new Promise((r) => setTimeout(r, 120));
      }
      const saved = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8")) as
        Array<{ lastInboundBy: Record<string, number> }>;
      expect(saved.length).toBe(1);
      expect(Object.keys(saved[0].lastInboundBy).length).toBeLessThanOrEqual(8);
      // The most recent sender is always among those kept.
      expect(Object.keys(saved[0].lastInboundBy)).toContain(join(dir, "s11.sock"));
    } finally {
      peer.stop();
      cleanup();
    }
  }, 25_000);

  test("conversation addresses come back after a broker restart", async () => {
    const { dir, send, cleanup } = harness();
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const first = createPeer(host);
    await send("topic: durable\nhello");
    const socketName = readdirSync(dir).find((f) => f.startsWith("peer-") && f.endsWith(".sock"));
    expect(socketName).toBeDefined();
    first.stop();
    expect(readdirSync(dir).some((f) => f === socketName)).toBe(false); // torn down with the broker

    const second = createPeer(host);
    try {
      // The same address is listening again — a session holding it from
      // before the restart is not left talking to a dead socket.
      expect(readdirSync(dir).some((f) => f === socketName)).toBe(true);
    } finally {
      second.stop();
      cleanup();
    }
  }, 15_000);

  test("shutdown tells senders their in-flight turn is not coming back", async () => {
    const { dir, send, cleanup } = harness();
    const senderSock = join(dir, "sender.sock");
    const inboxLines: string[] = [];
    const inboxServer = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l) inboxLines.push(l);
        }
      });
    });
    inboxServer.listen(senderSock);
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: s\nwork on this"); // a turn is now in flight
      peer.stop();                          // broker goes away mid-turn
      await new Promise((r) => setTimeout(r, 250));
      expect(inboxLines.some((l) => parseEnvelope(l)?.text.includes("broker shut down"))).toBe(true);
      // The run record must not stay "running" forever either.
      const runs = readdirSync(join(dir, "runs")).map((f) =>
        JSON.parse(readFileSync(join(dir, "runs", f), "utf-8")) as { status: string });
      expect(runs.every((r) => r.status !== "running")).toBe(true);
    } finally {
      peer.stop();
      inboxServer.close();
      cleanup();
    }
  }, 15_000);

  test("a message read mid-goal-continuation still gets its answer delivered", async () => {
    const { dir, send, cleanup } = harness();
    const senderSock = join(dir, "sender.sock");
    const inboxLines: string[] = [];
    const inboxServer = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (l) inboxLines.push(l);
        }
      });
    });
    inboxServer.listen(senderSock);

    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: g\nstart the work");
      const owner = owners.get("thread-X")!;
      owner.onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "first reply" } });
      owner.onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await new Promise((r) => setTimeout(r, 200));
      expect(inboxLines.length).toBe(1); // reply 1 delivered; buffer consumed

      // Goal mode: ownership persists, a continuation turn is running with
      // NO reply buffer. A message arriving now must not vanish into it.
      hasTurn = true;
      await send("are you still on track?");
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "reasoning" } });
      owner.onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "continuation answer" } });
      owner.onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await new Promise((r) => setTimeout(r, 200));
      // The re-armed buffer delivered the continuation's output as the reply.
      expect(inboxLines.length).toBe(2);
      expect(parseEnvelope(inboxLines[1])!.text).toContain("continuation answer");
    } finally {
      peer.stop();
      inboxServer.close();
      cleanup();
    }
  }, 15_000);

  test("a conversation created on the server default pins the model the server reports", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" }, model: "srv-default" };
        if (method === "turn/start") turnStarts.push(params!);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("no model header here"); // nothing explicit, nothing configured
      expect(turnStarts.length).toBe(1);
      // The conversation runs on what the server actually selected, pinned.
      expect(turnStarts[0].model).toBe("srv-default");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("every topic conversation survives a broker restart, not just each sender's latest", async () => {
    const { dir, send, cleanup } = harness();
    const injected: string[] = [];
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: `thread-${++n}` } };
        if (method === "thread/inject_items") injected.push(params!.threadId as string);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      threadHasTurn: () => true, // injection only
      log: () => {},
    };
    const first = createPeer(host);
    await send("topic: alpha work\none");
    await send("topic: beta work\ntwo");
    expect(n).toBe(2);
    first.stop();

    const second = createPeer(host);
    try {
      // Selecting the OLDER topic must continue its thread, not start a new
      // one — the restart must not have forgotten it.
      await send("topic: alpha work\nthree");
      expect(n).toBe(2);
      expect(injected[injected.length - 1]).toBe("thread-1");
    } finally {
      second.stop();
      cleanup();
    }
  }, 15_000);
});

describe.skipIf(onWindows)("peerCapability fallback gating", () => {
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
