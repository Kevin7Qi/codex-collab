// Tests for src/peer.ts — the pure pieces (envelope parse/wrap, naming,
// registry entry shape) plus capability gating. The live socket/registry
// behavior is exercised end to end by the contract tests, not here.

import { describe, expect, test } from "bun:test";
import { config } from "./config";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  topicKey,
  conversationsToEvict,
  conversationModel,
  adoptionFor,
  workspaceSuffix,
  threadIsGone,
  buildDelegation,
  escapeDelegation,
  type Conversation,
  type PeerHost,
} from "./peer";

/** The peer never activates on Windows — peerCapability gates win32 before
 *  anything else runs — so the socket/registry integration behavior under
 *  test does not exist there: procStartOf shells out to POSIX `ps`, sockets
 *  bind Unix paths, and capability's registry scan is unreachable. Skipping
 *  mirrors production's own gate. */
const onWindows = process.platform === "win32";

/** Poll until `cond` holds, or fail after `timeoutMs`.
 *
 *  Integration tests here drive an async peer over a socket, so the question
 *  is always "has this happened yet", never "has 250ms elapsed". A fixed
 *  sleep answers the second question and only correlates with the first on
 *  an unloaded machine — which is how a suite starts failing when it merely
 *  runs slower. Polling is fast when the machine is fast and patient when it
 *  is not, and it fails with a real deadline rather than a race. */
async function waitFor(cond: () => boolean, timeoutMs = 10_000, pollMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("waitFor timed out — condition never held");
}

/** Bounded settle for the cases that prove a NEGATIVE ("nothing else was
 *  delivered"). There is no condition to converge on, so time is the only
 *  instrument; keep it generous so load cannot turn absence into a pass. */
const SETTLE_MS = 400;

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

/** Write one envelope line to a peer's front door and close. */
async function sendLine(stateDir: string, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect({ path: join(stateDir, "peer.sock") }, () => {
      sock.write(line);
      sock.end();
      resolve();
    });
    sock.on("error", reject);
  });
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
  // Paths are built with join(): the check compares against the platform
  // separator, so a hardcoded "/" fails on Windows for the right reason.
  test("recognizes our own broker sockets and not Claude's", () => {
    expect(isCodexCollabSocket(join(config.dataDir, "workspaces", "foo-abc", "peer.sock"))).toBe(true);
    expect(isCodexCollabSocket("/tmp/cc-socks/68002.sock")).toBe(false);
  });

  test("a path that merely starts with the same characters is not ours", () => {
    expect(isCodexCollabSocket(join(`${config.dataDir}-evil`, "peer.sock"))).toBe(false);
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

  test("a non-ASCII topic gets a readable address, not an empty one", () => {
    expect(topicPeerLabel("登录重构")).toBe("codex(登录重构)");
    expect(topicPeerLabel("登录 refactor v2")).toBe("codex(登录-refactor-v2)");
  });

  test("an address never carries a character that collides with addressing", () => {
    for (const t of ["登录重构", "a/b", "x@y", "p[q]", 'say "hi"', "a b c"]) {
      expect(topicPeerLabel(t)).not.toMatch(/[\[\]@\/\s<>&"]/);
    }
  });

  // Routing must not depend on the display slug: a topic whose characters
  // all get dropped still names one conversation.
  test("topicKey survives text that leaves no displayable slug", () => {
    expect(topicPeerLabel("🎉🎉")).toBe("");        // nothing to display
    expect(topicKey("🎉🎉")).toBe("🎉🎉");           // but it still routes
  });

  test("topicKey normalizes case, surrounding and internal whitespace", () => {
    expect(topicKey(" Auth  Refactor ")).toBe(topicKey("auth refactor"));
    expect(topicKey("登录重构")).toBe("登录重构");
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

  test("a model alias resolves at the header, not at the server", () => {
    // A conversation restates its model on EVERY turn, so an alias that
    // reached thread/start unresolved would fail the conversation forever.
    expect(parseHeaders("model: spark\nx").headers.model).toBe("gpt-5.3-codex-spark");
    // Non-aliases pass through untouched.
    expect(parseHeaders("model: gpt-5.6-luna\nx").headers.model).toBe("gpt-5.6-luna");
  });

  test("timeout: takes whole seconds within the CLI's bounds, and prose ends the block", () => {
    expect(parseHeaders("timeout: 900\ngo").headers.timeout).toBe(900);
    expect(parseHeaders("timeout: 900\ngo").body).toBe("go");
    // Not a number: the line is content, not a setting.
    const prose = parseHeaders("timeout: the login flow hangs\ngo");
    expect(prose.headers.timeout).toBeUndefined();
    expect(prose.body).toBe("timeout: the login flow hangs\ngo");
    // Out of range ends the block the same way, so nothing silently caps.
    expect(parseHeaders("timeout: 0\ngo").headers.timeout).toBeUndefined();
    expect(parseHeaders("timeout: 9999999999\ngo").headers.timeout).toBeUndefined();
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

  test("non-ASCII text is kept, not discarded", () => {
    expect(threadPeerLabel("调查一下这个测试为什么不稳定", "a1b2c3d4")).toBe("codex(调查一下这个测试为什么不稳定-a1b2)");
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
    expect(entry.nameSource).toBe("user"); // a chosen name, in Claude Code's own vocabulary
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
      interruptThread: async () => {},
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
      await waitFor(() => released.includes("thread-X"));
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
    if (!holder.pid) throw new Error("holder spawn failed");
    // `ps` must be able to see it before its registry entry can be forged.
    await waitFor(() => { try { return procStartOf(holder.pid!).length > 0; } catch { return false; } });

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
      interruptThread: async () => {},
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

      // A live session that binds no messaging socket (an older Claude Code)
      // cannot message the peer, so it must not keep the broker resident.
      const socketless = buildRegistryEntry({
        pid: holder.pid!,
        cwd: "/tmp",
        name: "old-claude-session",
        socketPath: "",
        version: "2.1.220",
        procStart: procStartOf(holder.pid!),
        sessionId: "00000000-0000-4000-8000-00000000000c",
      });
      delete socketless.messagingSocketPath;
      writeFileSync(join(dir, "sessions", `${holder.pid}.json`), JSON.stringify(socketless));
      expect(peer.hasLiveSessions()).toBe(false);
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
          // A real thread/start takes a moment. That suspension window is
          // where a second message can pass the map lookup before the first
          // has stored its conversation.
          await new Promise((r) => setTimeout(r, 50));
          return { thread: { id: `thread-${++started}` } };
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
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
      await waitFor(() => requests.filter((m) => m === "turn/start").length === 2);
      // The whole point: one thread, not one per message.
      expect(requests.filter((m) => m === "thread/start").length).toBe(1);
      // Both messages reached it. The thread is idle each time, so each one
      // arrives as its own turn's input rather than as an injected item.
      expect(requests.filter((m) => m === "turn/start").length).toBe(2);
      expect(requests).not.toContain("thread/inject_items");
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe.skipIf(onWindows)("inbound serialization across senders", () => {
  test("two senders opening the same topic get ONE thread, not one each", async () => {
    // Front-door messages used to be queued by sender, so two sessions
    // naming the same new topic ran in separate queues — both looked up
    // byTopic before either had stored its conversation, and each created a
    // thread. The topic route then pointed at whichever finished last, and
    // the other conversation was unreachable by the name that made it.
    const dir = mkdtempSync(join(tmpdir(), "peer-race-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    registerTestSender(join(dir, "sessions"), join(dir, "a.sock"), "sender-a");
    registerTestSender(join(dir, "sessions"), join(dir, "b.sock"), "sender-b");

    let started = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") {
          // A real thread/start suspends; that window is the race.
          await new Promise((r) => setTimeout(r, 50));
          return { thread: { id: `thread-${++started}` } };
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      const send = (sock: string, who: string) => new Promise<void>((resolve, reject) => {
        const line = buildEnvelope({ text: "topic: shared work\nhello", ourSocketPath: sock, ourName: who });
        const c = net.connect({ path: join(dir, "peer.sock") }, () => { c.write(line); c.end(); resolve(); });
        c.on("error", reject);
      });
      // Both sessions name the same new topic at the same moment.
      await Promise.all([send(join(dir, "a.sock"), "sender-a"), send(join(dir, "b.sock"), "sender-b")]);
      await waitFor(() => started > 0);
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      expect(started).toBe(1);
      const saved = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8"));
      expect(saved).toHaveLength(1);
      // And both senders are in it, so each one's reply reaches it.
      expect(Object.keys(saved[0].lastInboundBy).sort())
        .toEqual([join(dir, "a.sock"), join(dir, "b.sock")].sort());
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
      interruptThread: async () => {},
      threadHasTurn: () => true, // stay mid-turn: no turn/start, just injection
      log: () => {},
    };

    const peer = createPeer(host);
    const send = async (text: string, until?: () => boolean) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, "sender.sock"), ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      if (until) await waitFor(until);
      else await new Promise((r) => setTimeout(r, SETTLE_MS));
    };

    try {
      await send("topic: alpha work\nfirst", () => injected.length === 1);
      await send("topic: beta work\nsecond", () => injected.length === 2);
      await send("topic: alpha work\nthird", () => injected.length === 3);
      await send("fourth", () => injected.length === 4);

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
  }, 15_000);

  // A topic written in a script with no ASCII must route like any other.
  // Its display slug is empty, so routing keyed on the slug would re-create
  // the thread on every message and leave the conversation unreachable by
  // the topic that named it.
  test("a Chinese topic continues its conversation instead of starting a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    registerTestSender(join(dir, "sessions"), join(dir, "sender.sock"));

    const injected: string[] = [];
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: `thread-${++n}` } };
        if (method === "thread/inject_items") {
          const items = params!.items as Array<{ content: Array<{ text: string }> }>;
          injected.push(`${params!.threadId}:${items[0].content[0].text}`);
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => true,
      log: () => {},
    };

    const peer = createPeer(host);
    const send = async (text: string, until?: () => boolean) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, "sender.sock"), ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      if (until) await waitFor(until);
      else await new Promise((r) => setTimeout(r, SETTLE_MS));
    };

    try {
      await send("topic: 登录重构\n第一条", () => injected.length === 1);
      await send("topic: 数据迁移\nsecond topic", () => injected.length === 2);
      await send("topic: 登录重构\n第二条", () => injected.length === 3);

      expect(injected).toEqual([
        "thread-1:[test-sender] 第一条",
        "thread-2:[test-sender] second topic",
        "thread-1:[test-sender] 第二条",   // same topic → same thread
      ]);
      expect(n).toBe(2); // two topics, two threads — not three
    } finally {
      peer.stop();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
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
      interruptThread: async () => {},
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
      interruptThread: async () => {},
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
      interruptThread: async () => {},
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
    const send = async (text: string, until?: () => boolean) => {
      const line = buildEnvelope({ text, ourSocketPath: senderSock, ourName: "test-sender" });
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
        sock.on("error", reject);
      });
      if (until) await waitFor(until);
      else await new Promise((r) => setTimeout(r, SETTLE_MS));
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
      interruptThread: async () => {},
      threadHasTurn: () => true, // injection only — turns are not the subject here
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: t\nsandbox: read-only\napproval: auto\nmodel: gpt-5.4-mini\nhi",
        () => threadStarts.length === 1);
      expect(threadStarts[0].sandbox).toBe("read-only");

      injectFailFor.add("thread-1"); // thread dies; resume fails too → recovery
      await send("continue", () => threadStarts.length === 2); // a plain continuation: NO headers
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

  /** Stand up an inbox on the sender's reply socket and collect the text of
   *  every message the peer delivers back to it. */
  function inbox(senderSock: string) {
    const texts: string[] = [];
    const server = net.createServer((sock) => {
      sock.setEncoding("utf8");
      let buf = "";
      sock.on("data", (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) {
            const parsed = parseEnvelope(line);
            if (parsed) texts.push(parsed.text);
          }
        }
      });
    });
    server.listen(senderSock);
    return { texts, close: () => server.close() };
  }

  test("a lost thread says whether it was archived or gone, and how to get it back", async () => {
    // The resume error distinguishes an archived thread from a deleted one.
    // The sender has to hear which: either way their next reply comes from a
    // thread with no memory of the conversation.
    for (const scenario of [
      { resumeError: "session thread-1 is archived. Run `codex unarchive thread-1`", expect: /was archived/ },
      { resumeError: "thread not found: thread-1", expect: /is gone/ },
    ]) {
      const { dir, send, cleanup } = harness();
      const box = inbox(join(dir, "sender.sock"));
      const injectFailFor = new Set<string>();
      let n = 0;
      const host: PeerHost = {
        cwd: dir,
        stateDir: dir,
        request: async (method: string, params?: Record<string, unknown>) => {
          if (method === "thread/start") return { thread: { id: `thread-${++n}` } };
          if (method === "thread/inject_items" && injectFailFor.has(params!.threadId as string)) {
            throw new Error("thread not found");
          }
          if (method === "thread/resume") throw new Error(scenario.resumeError);
          return {};
        },
        claimThread: () => true,
        releaseThread: () => {},
        interruptThread: async () => {},
        threadHasTurn: () => true, // injection only — turns are not the subject
        log: () => {},
      };
      const peer = createPeer(host);
      try {
        await send("topic: t\nhello", () => n === 1);
        injectFailFor.add("thread-1");
        await send("continue", () => box.texts.some((t) => t.includes("[codex-collab]")));

        const notice = box.texts.find((t) => t.includes("[codex-collab]"))!;
        expect(notice).toMatch(scenario.expect);
        // Both cases must say the history is gone and that the message still
        // landed — a silent recovery is what made this a bug.
        expect(notice).toMatch(/fresh thread/);
        // Only the recoverable case offers the recovery.
        expect(/codex unarchive thread-1/.test(notice)).toBe(scenario.expect.source === "was archived");
      } finally {
        peer.stop();
        box.close();
        cleanup();
      }
    }
  }, 20_000);

  test("an aliased model reaches thread/start resolved", async () => {
    const { dir, send, cleanup } = harness();
    const threadStarts: Array<Record<string, unknown>> = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") { threadStarts.push(params!); return { thread: { id: "thread-X" } }; }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => true, // the thread start is the subject, not the turn
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("model: spark\ndo it", () => threadStarts.length === 1);
      expect(threadStarts[0].model).toBe("gpt-5.3-codex-spark");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("an idle conversation receives the message once, not twice", async () => {
    // Injection and turn input BOTH reach the model — the mid-turn path
    // relies on injection being read. Doing both put the message in Codex's
    // context twice, and an imperative message twice is an instruction it
    // can carry out twice.
    const { dir, send, cleanup } = harness();
    const injects: string[] = [];
    const turnStarts: Array<Record<string, unknown>> = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => false, // idle
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("delete the staging bucket", () => turnStarts.length === 1);
      // Exactly one copy, and it is the one the Codex app can render.
      expect(injects).toHaveLength(0);
      const input = (turnStarts[0].input as Array<{ text: string }>)[0].text;
      expect(input).toContain("delete the staging bucket");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a mid-turn message is still injected — nothing else reaches a running turn", async () => {
    const { dir, send, cleanup } = harness();
    const injects: string[] = [];
    const turnStarts: Array<Record<string, unknown>> = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: t\nfirst", () => turnStarts.length === 1);
      expect(injects).toHaveLength(0);
      hasTurn = true;
      await send("and another thing", () => injects.length === 1);
      // No second turn: the running one owns the thread.
      expect(turnStarts).toHaveLength(1);
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("an idle conversation recovers a vanished thread through turn/start", async () => {
    // On the idle path the turn IS the delivery, so turn/start is where a
    // vanished thread now surfaces. It reports only "not found" for both an
    // archived and a deleted thread, so resume still has to be what tells
    // them apart.
    const { dir, send, cleanup } = harness();
    const box = inbox(join(dir, "sender.sock"));
    const turnStarts: string[] = [];
    const deadThreads = new Set<string>();
    let n = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: `thread-${++n}` } };
        if (method === "turn/start") {
          const id = params!.threadId as string;
          if (deadThreads.has(id)) throw new Error(`thread not found: ${id}`);
          turnStarts.push(id);
        }
        if (method === "thread/resume" && deadThreads.has(params!.threadId as string)) {
          throw new Error(`session ${params!.threadId} is archived. Run \`codex unarchive x\``);
        }
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: t\nhello", () => turnStarts.length === 1);
      expect(turnStarts[0]).toBe("thread-1");

      deadThreads.add("thread-1"); // archived out from under the conversation
      await send("still there?", () => turnStarts.length === 2);

      // The conversation continued on a fresh thread, and the message was
      // delivered to it rather than lost with the old one.
      expect(turnStarts[1]).toBe("thread-2");
      expect(n).toBe(2);
      // And the sender was told which case it was, with the way back.
      await waitFor(() => box.texts.some((t) => t.includes("was archived")));
      expect(box.texts.find((t) => t.includes("was archived"))).toContain("codex unarchive");
    } finally {
      peer.stop();
      box.close();
      cleanup();
    }
  }, 15_000);

  test("the turn input carries the message, not a pointer to it", async () => {
    // The Codex app renders turn input and nothing else. Spending it on a
    // notice about an injected item — which the app cannot display — meant a
    // user watching the conversation there saw a placeholder where the
    // message should be.
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
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
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("Review the login flow & check <Auth> first", () => turnStarts.length > 0);
      const input = (turnStarts[0].input as Array<{ text: string }>)[0].text;
      expect(input).toContain("<codex_delegation>");
      expect(input).toContain("Review the login flow &amp; check &lt;Auth&gt; first");
      // The sender is named inside the envelope: the app's own badge says
      // only "from another task", so attribution has to ride in the text.
      expect(input).toContain("[message from test-sender]");
      expect(input).not.toContain("agent_message");
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a transient failure does not cost the conversation its history", async () => {
    // Abandoning a thread is destructive: the conversation continues on a new
    // one with no memory. Only "the thread is gone" earns that. A timeout or
    // a server hiccup says nothing about whether the history still exists.
    const { dir, send, cleanup } = harness();
    const box = inbox(join(dir, "sender.sock"));
    let failInject = false;
    let threadsStarted = 0;
    let resumes = 0;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => {
        if (method === "thread/start") { threadsStarted++; return { thread: { id: `thread-${threadsStarted}` } }; }
        if (method === "thread/resume") { resumes++; return {}; }
        if (method === "thread/inject_items" && failInject) throw new Error("request timed out");
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: t\nhello", () => threadsStarted === 1);
      failInject = true;
      await send("continue", () => box.texts.some((t) => t.includes("could not be processed")));

      // No new thread, and no resume — resuming would have stripped the
      // conversation's dynamic tools over a timeout.
      expect(threadsStarted).toBe(1);
      expect(resumes).toBe(0);
      // The sender is told, rather than quietly answered by a blank thread.
      expect(box.texts.some((t) => t.includes("could not be processed"))).toBe(true);
    } finally {
      peer.stop();
      box.close();
      cleanup();
    }
  }, 15_000);

  test("a message the running turn never sampled wakes the thread when the turn ends", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    const injects: string[] = [];
    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst", () => turnStarts.length === 1);

      // A turn is running, so the follow-up can only be injected — and it
      // is the ONLY injection, because the idle first message went in as
      // turn input instead.
      hasTurn = true;
      await send("second", () => injects.length === 1);
      expect(turnStarts.length).toBe(1);

      // A command starting late is NOT proof the model sampled after the
      // injection — it may have been chosen by an earlier sample.
      owners.get("thread-X")!.onNotification("item/started", { threadId: "thread-X", item: { type: "commandExecution" } });

      hasTurn = false; // the turn ended without ever sampling the injection
      peer.onThreadTurnEnded("thread-X");
      await waitFor(() => turnStarts.length === 2);
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
    const injects: string[] = [];
    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst", () => turnStarts.length === 1);
      hasTurn = true;
      await send("second", () => injects.length === 1);
      // Even reasoning/agentMessage can come from a request whose context
      // was fixed BEFORE the injection, so none of it proves the message was
      // read. The wake happens regardless — a redundant confirmation turn is
      // the acceptable cost; a dropped message is not.
      const owner = owners.get("thread-X")!;
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "reasoning" } });
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "agentMessage" } });
      hasTurn = false;
      peer.onThreadTurnEnded("thread-X");
      await waitFor(() => turnStarts.length === 2);
    } finally {
      peer.stop();
      cleanup();
    }
  }, 15_000);

  test("a wake waits for a turn that is still running instead of dropping the debt", async () => {
    const { dir, send, cleanup } = harness();
    const turnStarts: Array<Record<string, unknown>> = [];
    const injects: string[] = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "turn/start") turnStarts.push(params!);
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: w\nfirst", () => turnStarts.length === 1);
      hasTurn = true;
      await send("second", () => injects.length === 1);

      // A turn is STILL running when this fires (a CLI run claimed the
      // thread in the gap). Its reply goes to its own client, so the debt
      // must survive rather than be marked settled.
      peer.onThreadTurnEnded("thread-X");
      // Proving a NEGATIVE — no turn started — so time is the only
      // instrument available.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      expect(turnStarts.length).toBe(1);

      hasTurn = false;
      peer.onThreadTurnEnded("thread-X"); // now it really is over
      await waitFor(() => turnStarts.length === 2);
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
      interruptThread: async () => {},
      threadHasTurn: () => claimed,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      const first = send("topic: r\nkick it off"); // claims, turn/start in flight
      await waitFor(() => turnStarts.includes("failing"));
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
      await waitFor(() => turnStarts.length === 2);

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
      await waitFor(() => inboxLines.some((l) => parseEnvelope(l)?.text.includes("replacement answer")));
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
      interruptThread: async () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: alpha\none", () => injected.length === 1);
      await send("topic: beta\ntwo", () => injected.length === 2);

      // The default is whichever was spoken to last — beta.
      await send("no topic here", () => injected.length === 3);
      expect(injected[injected.length - 1]).toBe("thread-2");

      // Reopening the older topic makes IT the default again, and a turn
      // completing on beta afterwards must not steal the default back:
      // completion is activity, not the sender speaking.
      await send("topic: alpha\nback to alpha", () => injected.length === 4);
      await send("no topic again", () => injected.length === 5);
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
    const sendAs = async (who: string, text: string, target = join(dir, "peer.sock"), until?: () => boolean) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, `${who}.sock`), ourName: `session-${who}` });
      await new Promise<void>((resolve, reject) => {
        const s = net.connect({ path: target }, () => { s.write(line); s.end(); resolve(); });
        s.on("error", reject);
      });
      if (until) await waitFor(until);
      else await new Promise((r) => setTimeout(r, SETTLE_MS));
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
      interruptThread: async () => {},
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
      await waitFor(() => inboxes.get("a")!.length > 0 && inboxes.get("b")!.length > 0);

      const aTexts = inboxes.get("a")!.map((l) => parseEnvelope(l)!.text);
      const bTexts = inboxes.get("b")!.map((l) => parseEnvelope(l)!.text);
      // A asked, so A must get the answer — not nothing because B spoke
      // last. B joined before the turn
      // ended, so the turn is answering B as well and B receives it too:
      // the conversation is shared, not stolen.
      expect(aTexts.some((t) => t.includes("answer for A"))).toBe(true);
      expect(bTexts.some((t) => t.includes("answer for A"))).toBe(true);

      // B is not forgotten either: B's message earned a wake, and that
      // turn's answer goes to B.
      peer.onThreadTurnEnded("thread-X");
      await waitFor(() => owners.length === 2);
      owners[1].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "answer for B" },
      });
      owners[1].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await waitFor(() => inboxes.get("b")!.map((l) => parseEnvelope(l)!.text).some((t) => t.includes("answer for B")));

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
    const sendAs = async (who: string, text: string, target = join(dir, "peer.sock"), until?: () => boolean) => {
      const line = buildEnvelope({ text, ourSocketPath: join(dir, `${who}.sock`), ourName: `session-${who}` });
      await new Promise<void>((resolve, reject) => {
        const c = net.connect({ path: target }, () => { c.write(line); c.end(); resolve(); });
        c.on("error", reject);
      });
      if (until) await waitFor(until);
      else await new Promise((r) => setTimeout(r, SETTLE_MS));
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
      interruptThread: async () => {},
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
      // The hook is deferred a tick; let it land before B joins.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      await sendAs("b", "me too");                            // B joins turn 2

      owners[owners.length - 1].onNotification("item/completed", {
        threadId: "thread-X", item: { type: "agentMessage", text: "answer for both" },
      });
      hasTurn = false;
      owners[owners.length - 1].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await waitFor(() => inboxes.get("a")!.length > 0 && inboxes.get("b")!.length > 0);

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
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: tidy\ndo it", () => owners.length === 1);
      owners[0].onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "done" } });
      hasTurn = false;
      owners[0].onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      // The ordinary release: no message was injected mid-turn, so there is
      // no pending wake — the path where cleanup is easiest to miss.
      peer.onThreadTurnEnded("thread-X");
      await waitFor(() => peer.debugState().turnRecipients === 0
        && peer.debugState().pendingWakes === 0);
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
      interruptThread: async () => {},
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
        // Wait for THIS sender to be recorded before the next one sends —
        // the test is about which senders survive the bound, so the order
        // they arrive in has to be the order they were sent in.
        await waitFor(() => {
          try {
            const rows = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8"));
            return rows[0]?.lastInboundBy?.[sock] !== undefined;
          } catch { return false; }
        });
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
      interruptThread: async () => {},
      threadHasTurn: () => true,
      log: () => {},
    };
    const first = createPeer(host);
    // Wait for the conversation record, which is written AFTER the thread
    // peer finishes registering — the socket alone appears partway through,
    // so keying on it can tear the peer down mid-setup.
    await send("topic: durable\nhello", () => existsSync(join(dir, "peer-conversations.json")));
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

  test("a CLI-created thread stays addressable across a broker restart", async () => {
    // A thread `run` creates is adopted as an address AND a conversation.
    // Without the record the linger sweep reads it as idle and retires it,
    // and a broker restart does not bring it back.
    const { dir, cleanup } = harness();
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async () => ({}),
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const first = createPeer(host);
    first.adoptThread("cli-thread-1", "read-only");
    // Adoption is deliberately deferred so the CLI can write the thread index
    // first; wait for the record, not for the clock. Not for the socket
    // either — the peer binds that partway through registering, so it exists
    // for a while before the conversation behind it is written.
    await waitFor(() => existsSync(join(dir, "peer-conversations.json")));
    const socketName = readdirSync(dir).find((f) => f.startsWith("peer-") && f.endsWith(".sock"))!;
    expect(socketName).toBeDefined();

    const saved = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].threadId).toBe("cli-thread-1");
    // The sandbox the CLI asked for, so the conversation attests its own
    // from-mode instead of the workspace default.
    expect(saved[0].sandbox).toBe("read-only");
    // Nobody has spoken to it, so it is nobody's no-topic default.
    expect(saved[0].lastInboundBy).toEqual({});

    first.stop();
    const second = createPeer(host);
    try {
      expect(readdirSync(dir).some((f) => f === socketName)).toBe(true);
    } finally {
      second.stop();
      cleanup();
    }
  }, 15_000);

  test("re-adopting a thread refreshes it instead of duplicating it", async () => {
    const { dir, cleanup } = harness();
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async () => ({}),
      claimThread: () => true,
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      peer.adoptThread("cli-thread-1");
      await waitFor(() => existsSync(join(dir, "peer-conversations.json"))
        && JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8")).length === 1);
      const before = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8"))[0].lastActivity;

      // `thread/resume` adopts again. Continued CLI use must keep the address
      // alive rather than leaving it to age out mid-session.
      await new Promise((r) => setTimeout(r, 20));
      peer.adoptThread("cli-thread-1");
      const after = JSON.parse(readFileSync(join(dir, "peer-conversations.json"), "utf-8"));
      expect(after).toHaveLength(1);
      expect(after[0].lastActivity).toBeGreaterThan(before);
    } finally {
      peer.stop();
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
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      // The turn must actually be in flight before the broker goes away —
      // that is the whole scenario, so wait for the run rather than assume it.
      await send("topic: s\nwork on this", () => peer.debugState().activeRuns === 1);
      peer.stop();                          // broker goes away mid-turn
      await waitFor(() => inboxLines.some((l) => parseEnvelope(l)?.text.includes("broker shut down")));
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
    const injects: string[] = [];
    let hasTurn = false;
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "thread/start") return { thread: { id: "thread-X" } };
        if (method === "thread/inject_items") injects.push(params!.threadId as string);
        return {};
      },
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      interruptThread: async () => {},
      threadHasTurn: () => hasTurn,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      await send("topic: g\nstart the work", () => owners.has("thread-X"));
      const owner = owners.get("thread-X")!;
      owner.onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "first reply" } });
      owner.onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      await waitFor(() => inboxLines.length === 1); // reply 1 delivered; buffer consumed

      // Goal mode: ownership persists, a continuation turn is running with
      // NO reply buffer. A message arriving now must not vanish into it.
      hasTurn = true;
      await send("are you still on track?", () => injects.length === 1);
      owner.onNotification("item/started", { threadId: "thread-X", item: { type: "reasoning" } });
      owner.onNotification("item/completed", { threadId: "thread-X", item: { type: "agentMessage", text: "continuation answer" } });
      owner.onNotification("turn/completed", { threadId: "thread-X", turn: { status: "completed", error: null } });
      // The re-armed buffer delivered the continuation's output as the reply.
      await waitFor(() => inboxLines.length === 2);
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
      interruptThread: async () => {},
      threadHasTurn: () => false,
      log: () => {},
    };
    const peer = createPeer(host);
    try {
      // nothing explicit, nothing configured
      await send("no model header here", () => turnStarts.length === 1);
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
      interruptThread: async () => {},
      threadHasTurn: () => true, // injection only
      log: () => {},
    };
    const first = createPeer(host);
    await send("topic: alpha work\none", () => injected.length === 1);
    await send("topic: beta work\ntwo", () => injected.length === 2);
    expect(n).toBe(2);
    first.stop();

    const second = createPeer(host);
    try {
      // Selecting the OLDER topic must continue its thread, not start a new
      // one — the restart must not have forgotten it.
      await send("topic: alpha work\nthree", () => injected.length === 3);
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

  test("a sibling broker does not make an older Claude Code look capable", () => {
    // Every codex-collab broker registers itself WITH a messaging socket. On
    // a Claude Code too old to bind one, a sibling broker in another
    // workspace was the only reachable entry — so the probe answered "can a
    // Claude session message us" with our own reflection and reported
    // messaging as supported. hasLiveSessions already excludes siblings.
    const child = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    const sibling = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      withRegistry([
        { pid: child.pid, name: "old-session" },
        { pid: sibling.pid, name: "codex(other-abc123)", messagingSocketPath: join(config.dataDir, "workspaces", "other", "peer.sock") },
      ], () => {
        const cap = peerCapability();
        expect(cap.ok).toBe(false);
        expect(cap.reason).toContain("no messaging sockets");
      });
    } finally {
      child.kill();
      sibling.kill();
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


describe("conversationsToEvict", () => {
  const conv = (id: string, lastActivity: number, spokenBy?: string): Conversation => ({
    threadId: id,
    replyPath: spokenBy ?? "",
    fromName: spokenBy ? "someone" : "",
    lastActivity,
    lastInboundBy: spokenBy ? { [spokenBy]: lastActivity } : {},
  });
  const none = () => false;

  test("nothing is evicted while under the cap", () => {
    const convs = [conv("a", 1), conv("b", 2)];
    expect(conversationsToEvict(convs, none, 2)).toEqual([]);
    expect(conversationsToEvict(convs, none, 5)).toEqual([]);
  });

  test("conversations nobody spoke to go before ones with history", () => {
    // An adopted CLI thread is a courtesy address; a conversation someone
    // actually messaged is a thing they can lose. Even when the adopted one
    // is NEWER, it goes first.
    const spokenOld = conv("spoken-old", 10, "/s.sock");
    const adoptedNew = conv("adopted-new", 99);
    const evicted = conversationsToEvict([spokenOld, adoptedNew], none, 1);
    expect(evicted.map((c) => c.threadId)).toEqual(["adopted-new"]);
  });

  test("within a group the oldest goes first", () => {
    const convs = [conv("new", 30), conv("old", 10), conv("mid", 20)];
    expect(conversationsToEvict(convs, none, 1).map((c) => c.threadId)).toEqual(["old", "mid"]);
  });

  test("an exempt conversation is never evicted, even as the oldest", () => {
    // Exempt means addressable or owed something right now: a live thread
    // peer, a running turn, a pending consult, an unanswered wake.
    const convs = [conv("busy", 1), conv("idle", 2)];
    const evicted = conversationsToEvict(convs, (c) => c.threadId === "busy", 1);
    expect(evicted.map((c) => c.threadId)).toEqual(["idle"]);
  });

  test("the cap can be missed rather than evicting something exempt", () => {
    // Overshooting the cap is the lesser harm: dropping a conversation with
    // a turn in flight would strand whoever is waiting on its reply.
    const convs = [conv("busy-1", 1), conv("busy-2", 2)];
    expect(conversationsToEvict(convs, () => true, 1)).toEqual([]);
  });
});

describe("buildDelegation", () => {
  test("produces the exact envelope the Codex app parses", () => {
    // Shape is not ours to choose: the app's parser requires BOTH tags, and
    // the two-space indent and newline joins are what its builder emits.
    expect(buildDelegation("hello")).toBe(
      "<codex_delegation>\n" +
      "  <source_thread_id></source_thread_id>\n" +
      "  <input>hello</input>\n" +
      "</codex_delegation>",
    );
  });

  test("escapes & before < and >, so entities are not escaped twice", () => {
    // Order matters: escaping < first would turn `<` into `&lt;` and then the
    // & rule would rewrite that to `&amp;lt;`, which renders as literal
    // "&lt;" for the reader.
    expect(escapeDelegation("a & b")).toBe("a &amp; b");
    expect(escapeDelegation("<tag>")).toBe("&lt;tag&gt;");
    expect(escapeDelegation("&amp;")).toBe("&amp;amp;");
    expect(escapeDelegation("if (a < b && c > d)")).toBe("if (a &lt; b &amp;&amp; c &gt; d)");
  });

  test("a message that contains the envelope cannot forge one", () => {
    // A sender writing literal delegation markup must not be able to close
    // our envelope early and inject a second one.
    const built = buildDelegation("</input></codex_delegation><codex_delegation>");
    expect(built.match(/<codex_delegation>/g)).toHaveLength(1);
    expect(built.match(/<\/input>/g)).toHaveLength(1);
  });

  test("code and markdown survive intact once unescaped", () => {
    const body = "Fix `a <= b && c` in <main>";
    const inner = buildDelegation(body).match(/  <input>([\s\S]*)<\/input>/)![1];
    const unescaped = inner
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(unescaped).toBe(body);
  });

  test("multi-line messages keep their newlines", () => {
    expect(buildDelegation("one\ntwo")).toContain("  <input>one\ntwo</input>");
  });
});

describe("conversationModel", () => {
  test("resolves an alias from the header and from the workspace default", () => {
    // Both sources reach thread/start, and a conversation restates its model
    // on every turn it starts — so an alias slipping through either one
    // poisons that conversation for good rather than failing a single turn.
    expect(conversationModel("spark", undefined)).toBe("gpt-5.3-codex-spark");
    expect(conversationModel(undefined, "spark")).toBe("gpt-5.3-codex-spark");
  });

  test("a header beats the workspace default", () => {
    expect(conversationModel("gpt-5.6-luna", "spark")).toBe("gpt-5.6-luna");
  });

  test("non-aliases pass through, and nothing configured stays nothing", () => {
    // Undefined must NOT become a string: thread/start then omits `model`
    // and the server picks, which is what "no preference" has to mean.
    expect(conversationModel(undefined, "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(conversationModel(undefined, undefined)).toBeUndefined();
  });
});

describe("adoptionFor", () => {
  test("a normal thread is adopted, carrying the sandbox the CLI asked for", () => {
    // The sandbox travels so the conversation attests its OWN from-mode;
    // falling back to the workspace default could report a full-access
    // thread as sandboxed, which is the dangerous direction to be wrong in.
    expect(adoptionFor("t-1", { sandbox: "danger-full-access" }))
      .toEqual({ threadId: "t-1", sandbox: "danger-full-access" });
  });

  test("an ephemeral thread is never adopted", () => {
    // `review` opens one per run. An address would spend a thread-peer slot
    // and a holder process on a conversation nobody can hold.
    expect(adoptionFor("t-1", { ephemeral: true, sandbox: "read-only" })).toBeNull();
    // Only the literal flag counts — a truthy value is not the contract.
    expect(adoptionFor("t-1", { ephemeral: "yes" })).not.toBeNull();
  });

  test("no usable thread id means nothing to adopt", () => {
    expect(adoptionFor(undefined, {})).toBeNull();
    expect(adoptionFor("", {})).toBeNull();
    expect(adoptionFor(42, {})).toBeNull();
  });

  test("a missing or malformed sandbox is left undefined, not invented", () => {
    expect(adoptionFor("t-1", undefined)).toEqual({ threadId: "t-1", sandbox: undefined });
    expect(adoptionFor("t-1", { sandbox: 7 })).toEqual({ threadId: "t-1", sandbox: undefined });
  });
});

describe("cross-workspace addressing", () => {
  // The session registry is shared by every workspace on the machine and the
  // name IS the messaging address, so any address that carries only a topic
  // or a thread slug can be claimed by two checkouts at once — and a message
  // reaches whichever registered last.
  const A = mkdtempSync(join(tmpdir(), "ws-a-"));
  const B = mkdtempSync(join(tmpdir(), "ws-b-"));

  test("two workspaces naming the same topic get different addresses", () => {
    const a = topicPeerLabel("auth refactor", workspaceSuffix(A));
    const b = topicPeerLabel("auth refactor", workspaceSuffix(B));
    expect(a).not.toBe(b);
    expect(a.startsWith("codex(auth-refactor-")).toBe(true);
  });

  test("two workspaces whose threads share a slug and short id still differ", () => {
    const a = threadPeerLabel("fix the login flow", "ab12cd34", workspaceSuffix(A));
    const b = threadPeerLabel("fix the login flow", "ab12cd34", workspaceSuffix(B));
    expect(a).not.toBe(b);
  });

  test("every address from one workspace carries that workspace's suffix", () => {
    // The front door already did; now the conversations do too, so an
    // address can be traced back to the checkout that owns it.
    const sfx = workspaceSuffix(A);
    expect(peerNameFor(A)).toContain(sfx);
    expect(topicPeerLabel("auth", sfx)).toContain(sfx);
    expect(threadPeerLabel("hello there", "ab12cd34", sfx)).toContain(sfx);
  });

  test("addresses stay inside the 40-char registry budget", () => {
    const sfx = workspaceSuffix(A);
    const long = "a very long topic name that just keeps going and going and going";
    expect(topicPeerLabel(long, sfx).length).toBeLessThanOrEqual(40);
    expect(threadPeerLabel(long, "ab12cd34", sfx).length).toBeLessThanOrEqual(40);
    // Truncation must never eat the suffix — a clipped suffix is a collision.
    expect(topicPeerLabel(long, sfx)).toContain(sfx);
    expect(threadPeerLabel(long, "ab12cd34", sfx)).toContain(sfx);
  });

  test("the readable half names the workspace root, like the hash does", () => {
    // Only manifests inside a checkout: the hash is of the repository root,
    // so a name built from the raw command directory disagrees with it, and
    // the same workspace state gets two addresses depending on where the
    // broker happened to start. Outside a repo both halves resolve to cwd.
    const repo = mkdtempSync(join(tmpdir(), "ws-repo-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    const sub = join(repo, "packages", "inner");
    mkdirSync(sub, { recursive: true });
    try {
      expect(peerNameFor(sub)).toBe(peerNameFor(repo));
      // And it is the ROOT that is named, not the subdirectory.
      expect(peerNameFor(sub)).not.toContain("inner");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("threadIsGone", () => {
  test("recognizes the two ways a thread stops existing", () => {
    expect(threadIsGone("thread not found: 019f-abc")).toBe(true);
    expect(threadIsGone("session 019f-abc is archived. Run `codex unarchive 019f-abc`")).toBe(true);
  });

  test("a failed request is not a missing thread", () => {
    // Each of these used to take the same path as a deleted thread and cost
    // the conversation everything it knew.
    for (const d of [
      "request timed out",
      "socket hang up",
      "JSON-RPC error -32603: Internal error",
      "connection reset by peer",
      "",
    ]) expect(threadIsGone(d)).toBe(false);
  });
});

describe.skipIf(onWindows)("peer status diagnosis", () => {
  // A broker decides once, at startup, whether it can register a peer. One
  // that started before Claude Code was installed stays peerless for its
  // whole life, and connecting to it changes nothing — so reporting that as
  // "no broker yet, run `peer up`" sent the user back to the command that
  // had just declined to help.
  test("a live broker with no peer is reported as such, not as no broker", async () => {
    const { readPeerState, isAlive } = await import("./commands/peer");
    const { loadBrokerState } = await import("./broker");
    const dir = mkdtempSync(join(tmpdir(), "peer-diag-"));
    try {
      // Broker state present and alive (our own pid), peer state absent.
      writeFileSync(join(dir, "broker.json"), JSON.stringify({
        endpoint: join(dir, "b.sock"),
        pid: process.pid,
        sessionDir: dir,
        startedAt: new Date().toISOString(),
      }));
      const broker = loadBrokerState(dir);
      expect(broker?.pid).toBe(process.pid);
      expect(isAlive(broker!.pid!)).toBe(true);
      // This is the state the status output has to tell apart: a broker
      // that is running, with no peer behind it.
      expect(readPeerState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(onWindows)("turn deadlines", () => {
  function listen(path: string): { lines: string[]; close: () => void } {
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

  /** A peer over a fake host whose threads start instantly and whose turns
   *  the test completes by hand. Every message carries `timeout: 1`, the
   *  smallest limit the header accepts, so a deadline is a second away. */
  function setUp() {
    const dir = mkdtempSync(join(tmpdir(), "peer-deadline-"));
    const prevSessions = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = join(dir, "sessions");
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const senderSock = join(dir, "sender.sock");
    registerTestSender(join(dir, "sessions"), senderSock);
    const inbox = listen(senderSock);
    const owners = new Map<string, { onNotification(m: string, p?: Record<string, unknown>): void }>();
    const interrupted: string[] = [];
    const host: PeerHost = {
      cwd: dir,
      stateDir: dir,
      request: async (method: string) => (method === "thread/start" ? { thread: { id: "thread-D" } } : {}),
      claimThread: (threadId, owner) => { owners.set(threadId, owner); return true; },
      releaseThread: () => {},
      threadHasTurn: () => false,
      interruptThread: async (threadId) => { interrupted.push(threadId); },
      log: () => {},
    };
    const peer = createPeer(host);
    const send = (text: string) => new Promise<void>((resolve, reject) => {
      const line = buildEnvelope({ text, ourSocketPath: senderSock, ourName: "test-sender" });
      const sock = net.connect({ path: join(dir, "peer.sock") }, () => { sock.write(line); sock.end(); resolve(); });
      sock.on("error", reject);
    });
    const tearDown = () => {
      peer.stop();
      inbox.close();
      if (prevSessions === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = prevSessions;
      rmSync(dir, { recursive: true, force: true });
    };
    return { peer, send, owners, interrupted, inbox, tearDown };
  }

  test("an overdue turn is interrupted, and its end is reported as a timeout", async () => {
    const t = setUp();
    try {
      await t.send("timeout: 1\nplease do the thing");
      await waitFor(() => t.owners.has("thread-D"));
      expect(t.peer.debugState().deadlines).toBe(1);
      // The deadline fires on its own; nothing here nudges it.
      await waitFor(() => t.interrupted.length > 0, 5_000);
      expect(t.interrupted).toEqual(["thread-D"]);
      // The interrupt only asks; the turn's own completion follows.
      t.owners.get("thread-D")!.onNotification("turn/completed", {
        threadId: "thread-D",
        turn: { status: "interrupted", error: null },
      });
      await waitFor(() => t.inbox.lines.length > 0);
      const delivered = parseEnvelope(t.inbox.lines[0])!;
      expect(delivered.text).toContain("exceeding its 1-second limit");
      expect(delivered.text).toContain("timeout:");
      expect(t.peer.debugState().deadlines).toBe(0);
    } finally {
      t.tearDown();
    }
  });

  test("a turn that ends in time is never interrupted, and leaves no deadline behind", async () => {
    const t = setUp();
    try {
      await t.send("timeout: 1\nplease do the thing");
      await waitFor(() => t.owners.has("thread-D"));
      const owner = t.owners.get("thread-D")!;
      owner.onNotification("item/completed", { threadId: "thread-D", item: { type: "agentMessage", text: "done" } });
      owner.onNotification("turn/completed", { threadId: "thread-D", turn: { status: "completed", error: null } });
      await waitFor(() => t.inbox.lines.length > 0);
      expect(parseEnvelope(t.inbox.lines[0])!.text).toBe("done");
      expect(t.peer.debugState().deadlines).toBe(0);
      // Past the limit now: the disarmed deadline must not fire.
      await new Promise((r) => setTimeout(r, 1_300));
      expect(t.interrupted).toEqual([]);
    } finally {
      t.tearDown();
    }
  });
});
