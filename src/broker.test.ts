import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  createEndpoint,
  parseEndpoint,
  saveBrokerState,
  loadBrokerState,
  clearBrokerState,
  saveSessionState,
  loadSessionState,
  isBrokerAlive,
  getCurrentSessionId,
  acquireSpawnLock,
  teardownBroker,
} from "./broker";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { BrokerState } from "./types";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "broker-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── createEndpoint ───────────────────────────────────────────────────────

describe("createEndpoint", () => {
  test("returns unix endpoint on non-windows", () => {
    const ep = createEndpoint(tempDir, "linux");
    expect(ep).toBe(`unix:${tempDir}/broker.sock`);
  });

  test("returns unix endpoint on darwin", () => {
    const ep = createEndpoint(tempDir, "darwin");
    expect(ep).toBe(`unix:${tempDir}/broker.sock`);
  });

  test("returns pipe endpoint on win32", () => {
    const ep = createEndpoint(tempDir, "win32");
    expect(ep).toMatch(/^pipe:\\\\.\\pipe\\codex-collab-[0-9a-f]+$/);
  });

  test("defaults to current platform", () => {
    const ep = createEndpoint(tempDir);
    // On Linux/macOS CI, this should be unix:
    if (process.platform !== "win32") {
      expect(ep.startsWith("unix:")).toBe(true);
    } else {
      expect(ep.startsWith("pipe:")).toBe(true);
    }
  });
});

// ─── parseEndpoint ────────────────────────────────────────────────────────

describe("parseEndpoint", () => {
  test("parses unix endpoint", () => {
    const parsed = parseEndpoint("unix:/tmp/broker.sock");
    expect(parsed).toEqual({ kind: "unix", path: "/tmp/broker.sock" });
  });

  test("parses pipe endpoint", () => {
    const parsed = parseEndpoint("pipe:\\\\.\\pipe\\codex-collab-abc123");
    expect(parsed).toEqual({ kind: "pipe", path: "\\\\.\\pipe\\codex-collab-abc123" });
  });

  test("throws on invalid endpoint", () => {
    expect(() => parseEndpoint("http://localhost:3000")).toThrow(/Invalid endpoint/);
  });

  test("throws on empty string", () => {
    expect(() => parseEndpoint("")).toThrow(/Invalid endpoint/);
  });

  test("throws on prefix without path", () => {
    expect(() => parseEndpoint("unix:")).toThrow(/Invalid endpoint/);
  });
});

// ─── broker state persistence ─────────────────────────────────────────────

describe("broker state", () => {
  test("save/load round-trip", () => {
    const state: BrokerState = {
      endpoint: "unix:/tmp/broker.sock",
      pid: 12345,
      sessionDir: "/tmp/session",
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveBrokerState(tempDir, state);
    const loaded = loadBrokerState(tempDir);
    expect(loaded).toEqual(state);
  });

  test("returns null for missing file", () => {
    const loaded = loadBrokerState(tempDir);
    expect(loaded).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    writeFileSync(join(tempDir, "broker.json"), "not-json{{{");
    const loaded = loadBrokerState(tempDir);
    expect(loaded).toBeNull();
  });

  test("clear removes broker.json", () => {
    const state: BrokerState = {
      endpoint: "unix:/tmp/broker.sock",
      pid: 12345,
      sessionDir: "/tmp/session",
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveBrokerState(tempDir, state);
    expect(loadBrokerState(tempDir)).not.toBeNull();

    clearBrokerState(tempDir);
    expect(loadBrokerState(tempDir)).toBeNull();
    expect(existsSync(join(tempDir, "broker.json"))).toBe(false);
  });
});

// ─── session state persistence ────────────────────────────────────────────

describe("session state", () => {
  test("save/load round-trip", () => {
    const state = {
      sessionId: "abc-123",
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveSessionState(tempDir, state);
    const loaded = loadSessionState(tempDir);
    expect(loaded).toEqual(state);
  });

  test("returns null for missing file", () => {
    const loaded = loadSessionState(tempDir);
    expect(loaded).toBeNull();
  });
});

// ─── isBrokerAlive ────────────────────────────────────────────────────────

describe("isBrokerAlive", () => {
  test("returns false for non-existent unix socket", async () => {
    const alive = await isBrokerAlive("unix:/tmp/nonexistent-broker-test.sock", 100);
    expect(alive).toBe(false);
  });

  test("returns false for non-existent pipe", async () => {
    const alive = await isBrokerAlive("pipe:\\\\.\\pipe\\nonexistent-broker-test", 100);
    expect(alive).toBe(false);
  });

  test("returns false for invalid endpoint", async () => {
    const alive = await isBrokerAlive("invalid:something", 100);
    expect(alive).toBe(false);
  });

  test("returns false for null endpoint", async () => {
    const alive = await isBrokerAlive(null, 100);
    expect(alive).toBe(false);
  });
});

// ─── getCurrentSessionId ──────────────────────────────────────────────────

describe("getCurrentSessionId", () => {
  test("reads from env var first", () => {
    const orig = process.env.CODEX_COLLAB_SESSION_ID;
    try {
      process.env.CODEX_COLLAB_SESSION_ID = "env-session-123";
      const id = getCurrentSessionId(tempDir);
      expect(id).toBe("env-session-123");
    } finally {
      if (orig !== undefined) {
        process.env.CODEX_COLLAB_SESSION_ID = orig;
      } else {
        delete process.env.CODEX_COLLAB_SESSION_ID;
      }
    }
  });

  test("reads from session.json when env var not set", () => {
    const orig = process.env.CODEX_COLLAB_SESSION_ID;
    try {
      delete process.env.CODEX_COLLAB_SESSION_ID;
      saveSessionState(tempDir, {
        sessionId: "file-session-456",
        startedAt: "2026-01-01T00:00:00Z",
      });
      const id = getCurrentSessionId(tempDir);
      expect(id).toBe("file-session-456");
    } finally {
      if (orig !== undefined) {
        process.env.CODEX_COLLAB_SESSION_ID = orig;
      } else {
        delete process.env.CODEX_COLLAB_SESSION_ID;
      }
    }
  });

  test("returns null when neither env var nor session.json exists", () => {
    const orig = process.env.CODEX_COLLAB_SESSION_ID;
    try {
      delete process.env.CODEX_COLLAB_SESSION_ID;
      const id = getCurrentSessionId(tempDir);
      expect(id).toBeNull();
    } finally {
      if (orig !== undefined) {
        process.env.CODEX_COLLAB_SESSION_ID = orig;
      } else {
        delete process.env.CODEX_COLLAB_SESSION_ID;
      }
    }
  });
});

// ─── acquireSpawnLock ─────────────────────────────────────────────────────

describe("acquireSpawnLock", () => {
  test("acquires and releases lock", () => {
    const release = acquireSpawnLock(tempDir);
    expect(release).not.toBeNull();
    expect(existsSync(join(tempDir, "broker.lock"))).toBe(true);
    release!();
    expect(existsSync(join(tempDir, "broker.lock"))).toBe(false);
  });

  test("second acquire succeeds after first is released", () => {
    const release1 = acquireSpawnLock(tempDir);
    expect(release1).not.toBeNull();
    release1!();

    const release2 = acquireSpawnLock(tempDir);
    expect(release2).not.toBeNull();
    release2!();
  });
});

// ─── teardownBroker ───────────────────────────────────────────────────────

describe("teardownBroker", () => {
  test("clears broker state file", () => {
    const state: BrokerState = {
      endpoint: `unix:${tempDir}/broker.sock`,
      pid: null,
      sessionDir: tempDir,
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveBrokerState(tempDir, state);
    teardownBroker(tempDir, state);
    expect(loadBrokerState(tempDir)).toBeNull();
  });

  test("removes socket file for unix endpoint", () => {
    const sockPath = join(tempDir, "broker.sock");
    writeFileSync(sockPath, ""); // simulate socket file
    const state: BrokerState = {
      endpoint: `unix:${sockPath}`,
      pid: null,
      sessionDir: tempDir,
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveBrokerState(tempDir, state);
    teardownBroker(tempDir, state);
    expect(existsSync(sockPath)).toBe(false);
  });

  test("does not throw for missing socket file", () => {
    const state: BrokerState = {
      endpoint: `unix:${tempDir}/nonexistent.sock`,
      pid: null,
      sessionDir: tempDir,
      startedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => teardownBroker(tempDir, state)).not.toThrow();
  });
});
