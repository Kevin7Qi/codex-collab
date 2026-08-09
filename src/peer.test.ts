// Tests for src/peer.ts — the pure pieces (envelope parse/wrap, naming,
// registry entry shape) plus capability gating. The live socket/registry
// behavior is exercised end to end by the contract tests, not here.

import { describe, expect, test } from "bun:test";
import {
  buildEnvelope,
  buildRegistryEntry,
  parseEnvelope,
  peerCapability,
  peerNameFor,
  sessionsDir,
} from "./peer";

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
