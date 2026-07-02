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
  clearBrokerArtifacts,
  isBrokerBusyError,
  BROKER_BUSY_RPC_CODE,
} from "./broker";
import { connectToBroker } from "./broker-client";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "fs";
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
  test.skipIf(process.platform === "win32")("returns unix endpoint on non-windows", () => {
    const ep = createEndpoint(tempDir, "linux");
    expect(ep).toBe(`unix:${tempDir}/broker.sock`);
  });

  test.skipIf(process.platform === "win32")("returns unix endpoint on darwin", () => {
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
  test("acquires and releases lock", async () => {
    const release = await acquireSpawnLock(tempDir);
    expect(release).not.toBeNull();
    expect(existsSync(join(tempDir, "broker.lock"))).toBe(true);
    release!();
    expect(existsSync(join(tempDir, "broker.lock"))).toBe(false);
  });

  test("second acquire succeeds after first is released", async () => {
    const release1 = await acquireSpawnLock(tempDir);
    expect(release1).not.toBeNull();
    release1!();

    const release2 = await acquireSpawnLock(tempDir);
    expect(release2).not.toBeNull();
    release2!();
  });

  test("release after a stale-break does not delete the new holder's lock", async () => {
    // Simulate a crashed holder: acquire, then backdate the lock file so a
    // second contender force-breaks it.
    const release1 = await acquireSpawnLock(tempDir);
    expect(release1).not.toBeNull();
    const lockPath = join(tempDir, "broker.lock");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    // Contender breaks the stale lock and acquires its own.
    const release2 = await acquireSpawnLock(tempDir);
    expect(release2).not.toBeNull();
    expect(existsSync(lockPath)).toBe(true);

    // The original (broken) holder releasing must NOT remove the new lock.
    release1!();
    expect(existsSync(lockPath)).toBe(true);

    release2!();
    expect(existsSync(lockPath)).toBe(false);
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

// ─── clearBrokerArtifacts ─────────────────────────────────────────────────

describe("clearBrokerArtifacts", () => {
  // Regression guard: dead-socket cleanup must not interpret `state.pid` as
  // "kill this". When a broker exits cleanly leaving stale broker.json behind
  // and the OS recycles its PID for an unrelated user process, the previous
  // teardownBroker call on the dead-socket path would SIGTERM that process.

  test("removes socket and state files without killing anything", () => {
    const sockPath = join(tempDir, "broker.sock");
    writeFileSync(sockPath, "");
    // Use a live PID we explicitly do NOT want killed: this test process.
    // If clearBrokerArtifacts ever calls terminateProcessTree, this test
    // would terminate the runner instead of failing — the kill is the bug.
    const state: BrokerState = {
      endpoint: `unix:${sockPath}`,
      pid: process.pid,
      sessionDir: tempDir,
      startedAt: "2026-01-01T00:00:00Z",
    };
    saveBrokerState(tempDir, state);
    clearBrokerArtifacts(tempDir, state);
    expect(existsSync(sockPath)).toBe(false);
    expect(loadBrokerState(tempDir)).toBeNull();
    // If we got here, the helper did not kill the test runner — that's the
    // assertion. (Bun would have terminated us otherwise.)
  });

  test("survives a missing socket file (idempotent cleanup)", () => {
    const state: BrokerState = {
      endpoint: `unix:${tempDir}/gone.sock`,
      pid: 0, // PID 0 is never a real user process; safe even on accidental kill paths
      sessionDir: tempDir,
      startedAt: "2026-01-01T00:00:00Z",
    };
    expect(() => clearBrokerArtifacts(tempDir, state)).not.toThrow();
  });
});

// ─── isBrokerBusyError ────────────────────────────────────────────────────

describe("isBrokerBusyError", () => {
  test("returns true for an RpcError carrying BROKER_BUSY_RPC_CODE", () => {
    const err = Object.assign(new Error("busy"), { rpcCode: BROKER_BUSY_RPC_CODE });
    expect(isBrokerBusyError(err)).toBe(true);
  });

  test("returns false for an RpcError carrying a different code", () => {
    const err = Object.assign(new Error("nope"), { rpcCode: -32603 });
    expect(isBrokerBusyError(err)).toBe(false);
  });

  test("returns false for an Error without rpcCode", () => {
    expect(isBrokerBusyError(new Error("boom"))).toBe(false);
  });

  test("returns false for non-error values", () => {
    expect(isBrokerBusyError(null)).toBe(false);
    expect(isBrokerBusyError(undefined)).toBe(false);
    expect(isBrokerBusyError("BROKER_BUSY")).toBe(false);
    expect(isBrokerBusyError({})).toBe(false);
  });
});

// ─── BrokerClient ────────────────────────────────────────────────────────

// BrokerClient tests require Unix socket creation, which may be restricted
// in sandboxed environments. Detected at first test run.
let canCreateSockets: boolean | null = null;

async function checkSocketSupport(): Promise<boolean> {
  if (canCreateSockets !== null) return canCreateSockets;
  // BrokerClient tests use `unix:` endpoint strings which don't work on Windows
  if (process.platform === "win32") { canCreateSockets = false; return false; }
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

// ─── BrokerClient edge cases ────────────────────────────────────────────

// Helper: create a mock broker server that completes the initialize handshake
// and optionally runs a per-connection callback for custom behavior.
type ConnectionHandler = (
  socket: net.Socket,
  parsedMessages: { resolve: (msg: Record<string, unknown>) => void; promise: Promise<Record<string, unknown>> },
) => void;

function createMockBroker(
  sockPath: string,
  onConnection?: ConnectionHandler,
): { server: net.Server; clientSockets: net.Socket[]; start: () => Promise<void>; stop: () => Promise<void> } {
  const clientSockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    clientSockets.push(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let handshakeDone = false;

    // Create a deferred for the first post-handshake message
    let resolveNext: ((msg: Record<string, unknown>) => void) | null = null;
    const nextMessage = new Promise<Record<string, unknown>>((resolve) => {
      resolveNext = resolve;
    });

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
            socket.write(
              JSON.stringify({ id: msg.id, result: { userAgent: "test-broker" } }) + "\n",
            );
          } else if (msg.method === "initialized") {
            handshakeDone = true;
          } else if (handshakeDone && resolveNext) {
            resolveNext(msg);
          }
        } catch {}
      }
    });

    if (onConnection) {
      onConnection(socket, { resolve: resolveNext!, promise: nextMessage });
    }
  });

  return {
    server,
    clientSockets,
    start: () => new Promise<void>((resolve) => server.listen(sockPath, resolve)),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const s of clientSockets) {
          try { s.destroy(); } catch {}
        }
        // On macOS, Bun's server.close() callback can fail to fire when a
        // connection was destroyed with backpressured write data (observed
        // with the 11MB overflow test) — bound the wait so tests can't hang.
        const timer = setTimeout(resolve, 2000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        try { rmSync(sockPath); } catch {}
      }),
  };
}

describe("BrokerClient — request timeout", () => {
  test("rejects when server never responds to a request", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "timeout.sock");

    // Server completes handshake but never responds to subsequent requests
    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({
        endpoint: `unix:${sockPath}`,
        requestTimeout: 200, // 200ms for fast test
      });

      const start = Date.now();
      await expect(client.request("test/hang")).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(2000);

      await client.close();
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — socket close during pending request", () => {
  test("rejects all pending requests when server closes the connection", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "close-pending.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({
        endpoint: `unix:${sockPath}`,
        requestTimeout: 5000,
      });

      // Fire a request, then immediately destroy the server socket
      const reqPromise = client.request("test/pending");
      // Small delay to ensure the request is sent before destroying
      await new Promise((r) => setTimeout(r, 20));
      for (const s of broker.clientSockets) s.destroy();

      await expect(reqPromise).rejects.toThrow(/Broker connection closed/);

      await client.close();
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — socket error during pending request", () => {
  test("rejects pending requests when socket emits an error", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "error-pending.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({
        endpoint: `unix:${sockPath}`,
        requestTimeout: 5000,
      });

      const reqPromise = client.request("test/error-case");
      // Capture rejection before triggering it to prevent unhandled rejection
      let rejectedWith: Error | null = null;
      reqPromise.catch((e: Error) => { rejectedWith = e; });
      await new Promise((r) => setTimeout(r, 20));
      // Destroy the server-side socket to trigger client disconnection
      for (const s of broker.clientSockets) {
        s.destroy();
      }
      // Wait for the rejection to propagate
      await new Promise((r) => setTimeout(r, 50));
      // Remote destroy may surface as either "close" or "error" depending on
      // platform timing — both are valid rejection paths in broker-client.ts.
      expect(rejectedWith).not.toBeNull();
      expect(rejectedWith!.message).toMatch(/Broker connection closed|Broker socket error/);
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — close() while requests pending", () => {
  test("rejects pending requests with 'Client closed'", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "close-while-pending.sock");

    // Server never responds to post-handshake requests
    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({
        endpoint: `unix:${sockPath}`,
        requestTimeout: 30000,
      });

      const reqPromise = client.request("test/slow");
      // Capture the rejection BEFORE calling close() — close() synchronously
      // calls rejectAll which fires reject() before we can attach a handler.
      let rejectedWith: Error | null = null;
      reqPromise.catch((e: Error) => { rejectedWith = e; });
      // close() synchronously calls rejectAll("Client closed")
      await client.close();
      // Give microtask queue time to process the rejection
      await new Promise((r) => setTimeout(r, 10));
      expect(rejectedWith).not.toBeNull();
      expect(rejectedWith!.message).toMatch(/Client closed/);
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — request after close()", () => {
  test("immediately rejects with 'Client is closed'", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "request-after-close.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });
      await client.close();

      await expect(client.request("test/anything")).rejects.toThrow(/Client is closed/);
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — server-sent request (onRequest handler)", () => {
  test("dispatches server-sent requests and sends back the response", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "server-request.sock");

    let serverSocket: net.Socket | null = null;
    const broker = createMockBroker(sockPath, (socket) => {
      serverSocket = socket;
    });
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      // Register a handler for a method the server will call
      const receivedParams: unknown[] = [];
      client.onRequest("approval/request", (params) => {
        receivedParams.push(params);
        return { approved: true };
      });

      // Server sends a request to the client
      serverSocket!.write(
        JSON.stringify({ id: 999, method: "approval/request", params: { tool: "bash", command: "ls" } }) + "\n",
      );

      // Wait for the response to come back on the server socket
      const response = await new Promise<Record<string, unknown>>((resolve) => {
        let buf = "";
        // The socket already has a data listener from createMockBroker, so
        // we add another one specifically to capture the response
        const onData = (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 999 && "result" in msg) {
                serverSocket!.removeListener("data", onData);
                resolve(msg);
              }
            } catch {}
          }
        };
        serverSocket!.on("data", onData);
      });

      expect(receivedParams).toEqual([{ tool: "bash", command: "ls" }]);
      expect(response.result).toEqual({ approved: true });

      await client.close();
    } finally {
      await broker.stop();
    }
  });

  test("sends method-not-found error when no handler registered", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "server-request-no-handler.sock");

    let serverSocket: net.Socket | null = null;
    const broker = createMockBroker(sockPath, (socket) => {
      serverSocket = socket;
    });
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      // Server sends a request for a method with no handler
      serverSocket!.write(
        JSON.stringify({ id: 888, method: "unknown/method", params: {} }) + "\n",
      );

      // Wait for the error response
      const response = await new Promise<Record<string, unknown>>((resolve) => {
        let buf = "";
        const onData = (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 888 && "error" in msg) {
                serverSocket!.removeListener("data", onData);
                resolve(msg);
              }
            } catch {}
          }
        };
        serverSocket!.on("data", onData);
      });

      expect((response.error as any).code).toBe(-32601);
      expect((response.error as any).message).toContain("Method not found");

      await client.close();
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — onClose callback", () => {
  test("fires on unexpected server disconnect", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "onclose-unexpected.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      let closeFired = false;
      client.onClose(() => {
        closeFired = true;
      });

      // Destroy all server sockets (simulate unexpected disconnect)
      for (const s of broker.clientSockets) s.destroy();

      // Wait for close event to propagate
      await new Promise((r) => setTimeout(r, 100));
      expect(closeFired).toBe(true);

      await client.close();
    } finally {
      await broker.stop();
    }
  });

  test("does NOT fire on intentional close()", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "onclose-intentional.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      let closeFired = false;
      client.onClose(() => {
        closeFired = true;
      });

      await client.close();

      // Give it some time to ensure the handler does not fire
      await new Promise((r) => setTimeout(r, 100));
      expect(closeFired).toBe(false);
    } finally {
      await broker.stop();
    }
  });

  test("unsubscribe removes the onClose handler", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "onclose-unsub.sock");

    const broker = createMockBroker(sockPath);
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      let closeFired = false;
      const unsub = client.onClose(() => {
        closeFired = true;
      });
      unsub(); // unsubscribe before the disconnect

      for (const s of broker.clientSockets) s.destroy();
      await new Promise((r) => setTimeout(r, 100));
      expect(closeFired).toBe(false);

      await client.close();
    } finally {
      await broker.stop();
    }
  });
});

describe("BrokerClient — buffer overflow protection", () => {
  test("disconnects when buffer exceeds MAX_BUFFER_SIZE", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "overflow.sock");

    let serverSocket: net.Socket | null = null;
    const broker = createMockBroker(sockPath, (socket) => {
      serverSocket = socket;
    });
    await broker.start();

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });

      let closeFired = false;
      client.onClose(() => {
        closeFired = true;
      });

      const reqPromise = client.request("test/pending-during-overflow");
      let rejectedWith: Error | null = null;
      reqPromise.catch((e: Error) => { rejectedWith = e; });

      // Send a payload larger than MAX_BUFFER_SIZE (10 MB) without any newline.
      // Write in chunks with async yields so the event loop can process the
      // client-side buffer check between writes.
      const chunkSize = 1024 * 1024; // 1 MB per chunk
      const totalChunks = 11; // 11 MB total > 10 MB limit
      const chunk = "x".repeat(chunkSize);
      for (let i = 0; i < totalChunks; i++) {
        if (serverSocket!.destroyed) break;
        serverSocket!.write(chunk);
        await new Promise((r) => setTimeout(r, 10)); // yield to event loop
      }

      // Wait for the client to detect the overflow and disconnect
      const deadline = Date.now() + 10_000;
      while (!closeFired && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(closeFired).toBe(true);
      expect(rejectedWith).not.toBeNull();
      expect(rejectedWith!.message).toContain("Broker response buffer exceeded maximum size");
    } finally {
      await broker.stop();
    }
  }, 30_000); // generous timeout — writing 11MB over socket can be slow
});

describe("BrokerClient — brokerBusy flag", () => {
  test("reports brokerBusy=true when initialize returns busy=true", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "busy-broker.sock");

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
              socket.write(JSON.stringify({
                id: msg.id,
                result: { userAgent: "test-broker", busy: true },
              }) + "\n");
            }
          } catch {}
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });
      expect(client.brokerBusy).toBe(true);
      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("reports brokerBusy=false when initialize returns busy=false", async () => {
    if (!await checkSocketSupport()) return;
    const sockPath = join(tempDir, "idle-broker.sock");

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
              socket.write(JSON.stringify({
                id: msg.id,
                result: { userAgent: "test-broker", busy: false },
              }) + "\n");
            }
          } catch {}
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    try {
      const client = await connectToBroker({ endpoint: `unix:${sockPath}` });
      expect(client.brokerBusy).toBe(false);
      expect(client.userAgent).toBe("test-broker");
      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

