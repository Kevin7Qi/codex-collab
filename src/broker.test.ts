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
import { connectToBroker } from "./broker-client";
import net from "node:net";
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

// ─── BrokerClient ────────────────────────────────────────────────────────

// BrokerClient tests require Unix socket creation, which may be restricted
// in sandboxed environments. Detected at first test run.
let canCreateSockets: boolean | null = null;

async function checkSocketSupport(): Promise<boolean> {
  if (canCreateSockets !== null) return canCreateSockets;
  const checkDir = mkdtempSync(join(tmpdir(), "broker-sock-check-"));
  const testSock = join(checkDir, "test.sock");
  try {
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.on("error", reject);
      srv.listen(testSock, () => { srv.close(); resolve(); });
    });
    canCreateSockets = true;
  } catch {
    canCreateSockets = false;
  }
  try { rmSync(checkDir, { recursive: true, force: true }); } catch {}
  return canCreateSockets;
}

describe("BrokerClient", () => {
  test("connects to a mock broker server and performs handshake", async () => {
    if (!await checkSocketSupport()) return; // skip in sandboxed environments
    const sockPath = join(tempDir, "mock-broker.sock");

    // Create a mock broker that responds to initialize
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method === "initialize" && msg.id !== undefined) {
              socket.write(JSON.stringify({ id: msg.id, result: { userAgent: "mock-broker" } }) + "\n");
            } else if (msg.method === "initialized") {
              // Swallow
            } else if (msg.method === "test/echo" && msg.id !== undefined) {
              socket.write(JSON.stringify({ id: msg.id, result: { echo: msg.params } }) + "\n");
            }
          } catch {
            // ignore parse errors
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });
      expect(client.userAgent).toBe("mock-broker");

      // Test a round-trip request
      const result = await client.request<{ echo: unknown }>("test/echo", { hello: "world" });
      expect(result.echo).toEqual({ hello: "world" });

      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { rmSync(sockPath); } catch {}
    }
  });

  test("receives notifications from broker", async () => {
    if (!await checkSocketSupport()) return; // skip in sandboxed environments
    const sockPath = join(tempDir, "mock-notif.sock");
    let clientSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      clientSocket = socket;
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method === "initialize" && msg.id !== undefined) {
              socket.write(JSON.stringify({ id: msg.id, result: { userAgent: "mock-notif" } }) + "\n");
            }
          } catch {}
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      // Register notification handler
      const received: unknown[] = [];
      client.on("test/event", (params) => {
        received.push(params);
      });

      // Send a notification from the server
      clientSocket!.write(JSON.stringify({ method: "test/event", params: { value: 42 } }) + "\n");

      // Give it a moment to arrive
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual([{ value: 42 }]);

      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { rmSync(sockPath); } catch {}
    }
  });

  test("rejects with error on connection failure", async () => {
    await expect(
      connectToBroker({ endpoint: `unix:${tempDir}/nonexistent.sock` }),
    ).rejects.toThrow(/Failed to connect to broker/);
  });

  test("request rejects on JSON-RPC error from broker", async () => {
    if (!await checkSocketSupport()) return; // skip in sandboxed environments
    const sockPath = join(tempDir, "mock-err.sock");

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.method === "initialize" && msg.id !== undefined) {
              socket.write(JSON.stringify({ id: msg.id, result: { userAgent: "mock" } }) + "\n");
            } else if (msg.method === "test/fail" && msg.id !== undefined) {
              socket.write(JSON.stringify({
                id: msg.id,
                error: { code: -32001, message: "Broker is busy" },
              }) + "\n");
            }
          } catch {}
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });
      await expect(client.request("test/fail")).rejects.toThrow(/Broker is busy/);
      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { rmSync(sockPath); } catch {}
    }
  });
});
