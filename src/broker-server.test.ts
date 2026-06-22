/**
 * Tests for broker-server.ts — the detached broker process that multiplexes
 * JSON-RPC messages between socket clients and a single app-server child.
 *
 * Strategy: Spawn broker-server.ts as a real subprocess with a mock app-server
 * script on PATH. The mock app-server speaks just enough JSON-RPC to satisfy
 * the initialize handshake and respond to requests. Test clients connect via
 * Unix socket and exercise concurrency control, approval forwarding, idle
 * timeout, and shutdown.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Subprocess } from "bun";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "broker-server-test-"));
});

afterEach(async () => {
  // Kill any broker processes we spawned
  for (const proc of spawnedProcesses) {
    try { proc.kill(); } catch {}
  }
  spawnedProcesses.length = 0;
  // Clean up temp dir
  rmSync(tempDir, { recursive: true, force: true });
});

const spawnedProcesses: Subprocess[] = [];

/**
 * Create a mock codex CLI script that speaks JSON-RPC when invoked as
 * `codex app-server`. The mock handles initialize, thread/start, turn/start,
 * turn/interrupt, thread/read, thread/list, and review/start.
 *
 * It also supports sending notifications (item/started, turn/completed) after
 * turn/start, and server-sent approval requests when MOCK_SEND_APPROVAL=1.
 */
function createMockCodex(dir: string, opts?: {
  /** Delay in ms before responding to turn/start */
  turnDelay?: number;
  /** If true, send a turn/completed notification after turn/start response */
  sendTurnCompleted?: boolean;
  /** If true, send an approval request after turn/start */
  sendApproval?: boolean;
  /** Delay in ms before sending turn/completed (after response) */
  turnCompletedDelay?: number;
  /** If true, write the turn/completed notification BEFORE the turn/start
   *  response. Simulates the fast-turn race where the app-server emits
   *  completion before the broker has parsed the start response. */
  completeBeforeResponse?: boolean;
  /** Delay in ms before responding to review/start. Lets tests disconnect
   *  the client mid-request to exercise the orphan-turn cleanup path. */
  reviewDelay?: number;
}): string {
  const turnDelay = opts?.turnDelay ?? 0;
  const sendTurnCompleted = opts?.sendTurnCompleted ?? true;
  const sendApproval = opts?.sendApproval ?? false;
  const turnCompletedDelay = opts?.turnCompletedDelay ?? 10;
  const completeBeforeResponse = opts?.completeBeforeResponse ?? false;
  const reviewDelay = opts?.reviewDelay ?? 0;

  const interruptLog = join(dir, "interrupts.log");
  const scriptPath = join(dir, "codex");
  const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
// Mock codex app-server for broker-server tests
const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  process.stderr.write("Mock codex: expected 'app-server' subcommand\\n");
  process.exit(1);
}

function respond(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let buffer = "";
let approvalIdCounter = 1;
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Notification — no id
    if (msg.id === undefined) continue;

    switch (msg.method) {
      case "initialize":
        respond({ id: msg.id, result: { userAgent: "mock-codex/0.1.0" } });
        break;

      case "thread/start":
        respond({ id: msg.id, result: {
          thread: {
            id: "thread-001", preview: "", modelProvider: "openai",
            createdAt: Date.now(), updatedAt: Date.now(),
            status: { type: "idle" }, path: null, cwd: "/tmp",
            cliVersion: "0.1.0", source: "mock", name: null,
            agentNickname: null, agentRole: null, gitInfo: null, turns: [],
          },
          model: "gpt-5.3-codex", modelProvider: "openai",
          cwd: "/tmp", approvalPolicy: "never", sandbox: null,
        }});
        break;

      case "turn/start": {
        const threadId = msg.params?.threadId || "thread-001";
        ${completeBeforeResponse ? `
        // Fast-turn race: write turn/completed BEFORE the turn/start
        // response so they arrive at the broker in a single read chunk
        // with completion first.
        respond({
          method: "turn/completed",
          params: {
            threadId: threadId,
            turn: { id: "turn-001", items: [], status: "completed", error: null },
          },
        });
        ` : ""}
        setTimeout(() => {
          respond({ id: msg.id, result: {
            turn: { id: "turn-001", items: [], status: "inProgress", error: null },
          }});

          ${sendApproval ? `
          // Send approval request after turn/start response
          setTimeout(() => {
            const approvalId = "approval-" + (approvalIdCounter++);
            respond({
              id: approvalId,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: threadId,
                turnId: "turn-001",
                itemId: "item-001",
                command: "echo hello",
                cwd: "/tmp",
              },
            });
          }, 5);
          ` : ""}

          ${sendTurnCompleted ? `
          setTimeout(() => {
            respond({
              method: "turn/completed",
              params: {
                threadId: threadId,
                turn: { id: "turn-001", items: [], status: "completed", error: null },
              },
            });
          }, ${turnCompletedDelay});
          ` : ""}
        }, ${turnDelay});
        break;
      }

      case "review/start": {
        const threadId = msg.params?.threadId || "thread-001";
        const reviewThreadId = "review-thread-001";
        setTimeout(() => {
          respond({ id: msg.id, result: {
            turn: { id: "review-turn-001", items: [], status: "inProgress", error: null },
            reviewThreadId: reviewThreadId,
          }});
          ${sendTurnCompleted ? `
          setTimeout(() => {
            respond({
              method: "turn/completed",
              params: {
                threadId: reviewThreadId,
                turn: { id: "review-turn-001", items: [], status: "completed", error: null },
              },
            });
          }, ${turnCompletedDelay});
          ` : ""}
        }, ${reviewDelay});
        break;
      }

      case "turn/interrupt":
        appendFileSync(${JSON.stringify(interruptLog)}, JSON.stringify({
          threadId: msg.params?.threadId ?? null,
          turnId: msg.params?.turnId ?? null,
        }) + "\\n");
        respond({ id: msg.id, result: {} });
        break;

      case "thread/read":
        respond({ id: msg.id, result: {
          thread: {
            id: msg.params?.threadId || "thread-001", preview: "",
            modelProvider: "openai", createdAt: Date.now(), updatedAt: Date.now(),
            status: { type: "idle" }, path: null, cwd: "/tmp",
            cliVersion: "0.1.0", source: "mock", name: null,
            agentNickname: null, agentRole: null, gitInfo: null, turns: [],
          },
        }});
        break;

      case "thread/list":
        respond({ id: msg.id, result: { data: [], nextCursor: null } });
        break;

      default:
        respond({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(1));
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });
  return dir; // The dir to prepend to PATH
}

/** Spawn broker-server as a subprocess with the mock codex on PATH. */
function spawnBroker(
  endpoint: string,
  mockCodexDir: string,
  opts?: {
    idleTimeout?: number;
    cwd?: string;
  },
): Subprocess {
  const brokerPath = join(import.meta.dir, "broker-server.ts");
  const args = [
    "run", brokerPath, "serve",
    "--endpoint", endpoint,
    "--idle-timeout", String(opts?.idleTimeout ?? 30000),
  ];
  if (opts?.cwd) {
    args.push("--cwd", opts.cwd);
  }

  const proc = Bun.spawn(["bun", ...args], {
    env: {
      ...process.env,
      PATH: `${mockCodexDir}:${process.env.PATH}`,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd ?? tempDir,
  });

  spawnedProcesses.push(proc);
  return proc;
}

/** Wait for the broker socket to become connectable. */
async function waitForSocket(
  sockPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const sock = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        sock.on("connect", () => { sock.destroy(); resolve(); });
        sock.on("error", reject);
        sock.connect({ path: sockPath });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Socket ${sockPath} did not become available within ${timeoutMs}ms`);
}

/**
 * A minimal JSON-RPC client for testing. Connects to a Unix socket, performs
 * the initialize handshake, and provides request/notify/onMessage helpers.
 */
class TestClient {
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string | number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private notificationHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  private requestHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  private allMessages: Array<Record<string, unknown>> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          this.allMessages.push(msg);
          this.dispatch(msg);
        } catch {}
      }
    });
  }

  static async connect(sockPath: string): Promise<TestClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = new net.Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Connection timed out"));
      }, 5000);
      sock.on("connect", () => { clearTimeout(timer); resolve(sock); });
      sock.on("error", (err) => { clearTimeout(timer); reject(err); });
      sock.connect({ path: sockPath });
    });
    return new TestClient(socket);
  }

  /** Connect and perform the initialize handshake. */
  static async connectAndInit(sockPath: string): Promise<TestClient> {
    const client = await TestClient.connect(sockPath);
    const result = await client.request("initialize", {
      clientInfo: { name: "test", title: null, version: "0.0.1" },
      capabilities: { experimentalApi: false },
    }) as { userAgent: string };
    client.send({ method: "initialized" });
    return client;
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response (has id + result or error, no method)
    if (msg.id !== undefined && !("method" in msg)) {
      const entry = this.pending.get(msg.id as string | number);
      if (entry) {
        this.pending.delete(msg.id as string | number);
        if ("error" in msg) {
          const err = msg.error as { code: number; message: string };
          const error = new Error(err.message) as Error & { code: number };
          error.code = err.code;
          entry.reject(error);
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // Request from server (has id + method)
    if (msg.id !== undefined && "method" in msg) {
      for (const h of this.requestHandlers) h(msg);
      return;
    }

    // Notification (method, no id)
    if ("method" in msg && msg.id === undefined) {
      for (const h of this.notificationHandlers) h(msg);
    }
  }

  send(msg: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      this.pending.set(id, { resolve, reject });
      this.send(msg);
      // 10s timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 10_000);
    });
  }

  onNotification(handler: (msg: Record<string, unknown>) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: Record<string, unknown>) => void): void {
    this.requestHandlers.push(handler);
  }

  get messages(): Array<Record<string, unknown>> {
    return this.allMessages;
  }

  async close(): Promise<void> {
    this.socket.end();
    await new Promise<void>((resolve) => {
      this.socket.on("close", resolve);
      if (this.socket.destroyed) resolve();
      setTimeout(resolve, 1000);
    });
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }
}

/** Collect notifications from a client into an array. Returns the array ref. */
function collectNotifications(
  client: TestClient,
): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  client.onNotification((msg) => collected.push(msg));
  return collected;
}

/** Wait for a condition to become true within a timeout. */
async function waitFor(
  condFn: () => boolean,
  timeoutMs = 5000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condFn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("waitFor timed out");
}

async function exitsWithin(proc: Subprocess, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

// ─── Socket support detection ────────────────────────────────────────────────

// These integration tests spawn a real broker-server subprocess with a mock
// codex script (bash shebang) and connect via Unix socket. They require:
// 1. Unix platform (the mock script uses #!/usr/bin/env bun)
// 2. Unix socket support (not restricted by sandbox)
const IS_UNIX = process.platform !== "win32";
const SOCKETS_AVAILABLE = IS_UNIX && await (async () => {
  const checkDir = mkdtempSync(join(tmpdir(), "broker-sock-check-"));
  const testSock = join(checkDir, "test.sock");
  try {
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.on("error", reject);
      srv.listen(testSock, () => { srv.close(); resolve(); });
    });
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(checkDir, { recursive: true, force: true }); } catch {}
  }
})();

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!SOCKETS_AVAILABLE)("broker-server", () => {

  // ── Initialize handshake ──────────────────────────────────────────────────

  describe("initialize handshake", () => {
    test("responds with userAgent locally, does not forward to app-server", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connect(sockPath);
        const result = await client.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string };

        expect(result.userAgent).toBe("codex-collab-broker");
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("initialize returns busy=false when no stream is active", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connect(sockPath);
        const result = await client.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("initialize returns busy=true when a stream is active", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        // Client 1 establishes a stream
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 connects — initialize should report busy
        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(true);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("initialize returns busy=true while a streaming request is pending", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        turnDelay: 1000,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const pendingTurn = client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // The broker has accepted the streaming request, but turn/start has
        // not returned yet, so stream ownership has not been established.
        await new Promise((r) => setTimeout(r, 100));

        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(true);

        await pendingTurn;
        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("non-streaming error from stream owner preserves stream ownership", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // Long-running turn that won't auto-complete during the test.
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Same socket sends a non-streaming RPC the mock rejects with -32601.
        // Before the fix, the broker's catch path cleared activeStreamSocket
        // for non-streaming errors, letting a second client interleave.
        let errored = false;
        try {
          await client1.request("nonexistent/method", {});
        } catch {
          errored = true;
        }
        expect(errored).toBe(true);

        // Stream ownership must still be held — the turn is still running.
        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(true);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("reports busy=false after a fast turn that completes before turn/start response", async () => {
      // Regression: when turn/completed arrives before the broker has finished
      // processing the turn/start response, the fast-completion branch cleared
      // activeRequestSocket but left activeRequestIsStreaming = true. Since
      // initialize computes busy as (activeStreamSocket !== null ||
      // activeRequestIsStreaming), the broker would report busy=true forever
      // and every subsequent streaming invocation would fall back to a direct
      // app-server until the broker restarted.
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // Force the race: the mock writes turn/completed *before* turn/start's
      // response, and `turnDelay > 0` makes the broker still be awaiting
      // appClient.request's resolution when it sees turn/completed.
      const mockDir = createMockCodex(tempDir, { completeBeforeResponse: true, turnDelay: 20 });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        // Give the broker time to drain any straggler notifications.
        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        // A fresh client should see busy=false. Pre-fix, this was true.
        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(false);
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("swallows initialized notification without error", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        // Send another initialized notification — should be silently ignored
        client.send({ method: "initialized" });
        // If the broker crashes or sends an error, the next request would fail
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Basic request forwarding ──────────────────────────────────────────────

  describe("request forwarding", () => {
    test("forwards thread/start to app-server and returns result", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const result = await client.request("thread/start", {
          cwd: "/tmp",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }) as { thread: { id: string } };

        expect(result.thread.id).toBe("thread-001");
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("forwards thread/read and thread/list as read-only methods", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        const listResult = await client.request("thread/list") as { data: unknown[] };
        expect(listResult.data).toBeArrayOfSize(0);

        const readResult = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(readResult.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("returns JSON parse error for invalid JSON input", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        // Send raw invalid JSON
        client.send({ bogus: true } as any); // This is valid JSON but missing id/method
        // The broker ignores notifications without id, so this is just dropped.
        // Now send actually invalid JSON:
        (client as any).socket.write("not valid json\n");

        // Wait for error response
        await new Promise((r) => setTimeout(r, 200));

        const errorMsg = client.messages.find(
          (m) => m.id === null && (m as any).error?.code === -32700,
        );
        expect(errorMsg).toBeDefined();
        expect((errorMsg as any).error.message).toContain("Invalid JSON");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("ignores client notifications (no id)", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a notification (no id) — broker should silently ignore it
        client.send({ method: "some/notification", params: {} });

        // Verify the broker is still functional after receiving the notification.
        // NOTE: This only verifies the broker didn't crash. It does not verify that
        // the notification was NOT forwarded to the app-server, because the mock
        // app-server silently ignores notifications (no id) and there is no
        // observable side-effect to check from the client side.
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Concurrency control ───────────────────────────────────────────────────

  describe("concurrency control", () => {
    test("second client gets -32001 busy error during active stream", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // Use a long turn delay so the stream stays active
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn (streaming method)
        const turnResult = await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        expect(turnResult).toBeDefined();

        // Wait briefly for stream ownership to be established
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 tries to start a turn — should get busy error
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "world" }],
          });
          throw new Error("Expected busy error");
        } catch (err: any) {
          expect(err.message).toContain("Shared Codex broker is busy");
          expect(err.code).toBe(-32001);
        }

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("second client can proceed after first client's turn completes", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed
        await new Promise((r) => setTimeout(r, 300));

        // Client 2 should now be able to make requests
        const result = await client2.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("turn/interrupt allowed from different socket during active stream", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for stream ownership
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 sends turn/interrupt — should succeed (not blocked)
        const interruptResult = await client2.request("turn/interrupt", {
          threadId: "thread-001",
          turnId: "turn-001",
        });
        expect(interruptResult).toEqual({});

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("thread/read allowed from different socket during active stream", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Client 2 reads a thread — should succeed
        const readResult = await client2.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(readResult.thread.id).toBe("thread-001");

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("thread/list allowed from different socket during active stream", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Client 2 lists threads — should succeed
        const listResult = await client2.request("thread/list") as { data: unknown[] };
        expect(listResult.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("non-streaming request from same socket is allowed", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Start a turn (streaming)
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Same socket can still make requests (it owns the stream)
        const result = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(result.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Notification routing ──────────────────────────────────────────────────

  describe("notification routing", () => {
    test("turn/completed notification is forwarded to the stream-owning socket", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed notification
        await waitFor(() => notifications.some(
          (n) => n.method === "turn/completed",
        ), 3000);

        const turnCompleted = notifications.find((n) => n.method === "turn/completed");
        expect(turnCompleted).toBeDefined();
        expect((turnCompleted!.params as any).threadId).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("notifications are not sent to non-owning sockets", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);
        const notifications1 = collectNotifications(client1);
        const notifications2 = collectNotifications(client2);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed
        await waitFor(() => notifications1.some(
          (n) => n.method === "turn/completed",
        ), 3000);

        // Client 2 should NOT have received the notification
        expect(notifications2.length).toBe(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Approval forwarding ───────────────────────────────────────────────────

  describe("approval forwarding", () => {
    test("client receives forwarded approval request and responds — round-trip", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Set up approval response handler — when we receive a request
        // with method "item/commandExecution/requestApproval", respond with accept
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            // Respond with approval decision
            client.send({
              id: msg.id,
              result: { decision: "accept" },
            });
          }
        });

        // Start a turn (which triggers the mock to send an approval request)
        const turnResult = await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        expect(turnResult).toBeDefined();

        // Wait for the approval request to arrive and be responded to
        await waitFor(
          () => client.messages.some(
            (m) =>
              m.method === "item/commandExecution/requestApproval" &&
              m.id !== undefined,
          ),
          3000,
        );

        // Verify we received the forwarded approval request
        const approvalReq = client.messages.find(
          (m) => m.method === "item/commandExecution/requestApproval",
        );
        expect(approvalReq).toBeDefined();
        expect((approvalReq!.params as any).command).toBe("echo hello");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("malformed response (missing result and error) is rejected", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Respond to approval with neither result nor error
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            // Send malformed response — just id, no result or error
            client.send({ id: msg.id });
          }
        });

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for the approval request to arrive
        await waitFor(
          () => client.messages.some(
            (m) => m.method === "item/commandExecution/requestApproval",
          ),
          3000,
        );

        // The broker should reject the malformed response internally and log a
        // warning to stderr. We cannot easily verify the stderr warning from the
        // subprocess, nor can we observe the rejection sent to the app-server from
        // the client side. We verify the broker remains functional, which confirms
        // it handled the malformed response without crashing.
        await new Promise((r) => setTimeout(r, 200));

        // Broker should still be alive and respond to requests
        // (the stream owner is still this client, so same-socket request works)
        const result = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(result.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("socket disconnect during pending approval rejects only that socket's approvals", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Don't respond to approval — just disconnect
        let approvalReceived = false;
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            approvalReceived = true;
            // Don't respond — just disconnect
            setTimeout(() => client.close(), 50);
          }
        });

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for approval to arrive and client to disconnect
        await waitFor(() => approvalReceived, 3000);
        await new Promise((r) => setTimeout(r, 200));

        // Broker should still be alive — connect a new client.
        // NOTE: We cannot directly verify that the pending approval was rejected
        // (sent back to the app-server as a reject response) because the mock
        // app-server does not expose that information. We verify indirectly: the
        // broker survives the disconnect and accepts new connections, which confirms
        // it cleaned up the pending approval state without deadlocking.
        const client2 = await TestClient.connectAndInit(sockPath);
        expect(client2.destroyed).toBe(false);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Socket permissions ────────────────────────────────────────────────────

  describe("socket permissions", () => {
    test("socket file has restrictive permissions (0o700)", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const stats = statSync(sockPath);
        // Socket permission bits — the file mode should have 0o700
        // On Linux, socket files may have 0o755 or similar, but the
        // chmodSync(path, 0o700) should set the permission bits.
        const permBits = stats.mode & 0o777;
        expect(permBits).toBe(0o700);
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── broker/shutdown RPC ───────────────────────────────────────────────────

  describe("broker/shutdown", () => {
    test("broker exits cleanly after broker/shutdown request", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      const client = await TestClient.connectAndInit(sockPath);

      // Send broker/shutdown
      const result = await client.request("broker/shutdown");
      expect(result).toEqual({});

      // Wait for process to exit
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-1), 5000)),
      ]);
      expect(exitCode).toBe(0);

      await client.close();
    }, 15_000);
  });

  // ── Idle timeout ──────────────────────────────────────────────────────────

  describe("idle timeout", () => {
    test("broker shuts down after idle timeout with no activity", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      // Use a very short idle timeout (1 second)
      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 1000 });
      await waitForSocket(sockPath);

      // Don't send any requests — just wait for the broker to exit
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-999), 5000)),
      ]);

      // Should exit with code 0 (idle timeout)
      expect(exitCode).toBe(0);
    }, 10_000);

    test("activity resets the idle timer", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      // Use a 2s idle timeout
      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 2000 });
      await waitForSocket(sockPath);

      const client = await TestClient.connectAndInit(sockPath);

      // Send periodic requests to keep the broker alive
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 800));
        await client.request("thread/list");
      }

      // At this point ~2.4s have passed, but the timer was reset each time
      // so the broker should still be alive
      const result = await client.request("thread/list") as { data: unknown[] };
      expect(result.data).toBeArrayOfSize(0);

      await client.close();

      // Now wait for idle timeout after closing
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-999), 5000)),
      ]);
      expect(exitCode).toBe(0);
    }, 15_000);

    test("active stream prevents idle shutdown", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 300 });
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "long running" }],
        });

        expect(await exitsWithin(proc, 900)).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("pending approval prevents idle shutdown", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendApproval: true,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 300 });
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "needs approval" }],
        });

        await waitFor(() => client.messages.some(m => m.method === "item/commandExecution/requestApproval"), 2000, 50);
        expect(await exitsWithin(proc, 900)).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 10_000);
  });

  // ── Buffer overflow protection ────────────────────────────────────────────

  describe("buffer overflow protection", () => {
    test("broker destroys socket when client sends >10MB without newlines", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 30000 });
      await waitForSocket(sockPath);

      try {
        // Use a raw socket (not TestClient) so we can flood data without
        // the JSON-RPC framing getting in the way.
        const rawSocket = new net.Socket();
        await new Promise<void>((resolve, reject) => {
          rawSocket.on("connect", resolve);
          rawSocket.on("error", reject);
          rawSocket.connect({ path: sockPath });
        });

        // Complete the initialize handshake first so the broker accepts us
        rawSocket.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", title: null, version: "1.0" }, capabilities: { experimentalApi: false } } }) + "\n");
        await new Promise((r) => setTimeout(r, 100));

        // Now flood >10MB without newlines. Use a single large write to
        // maximize the chance the broker receives it all in one chunk.
        let destroyed = false;
        rawSocket.on("close", () => { destroyed = true; });
        rawSocket.on("error", () => { destroyed = true; });

        // Write in a loop with drain handling to ensure data actually flows
        const chunkSize = 256 * 1024; // 256KB — typical kernel buffer unit
        const target = 11 * 1024 * 1024; // 11MB > MAX_BUFFER_SIZE (10MB)
        let written = 0;

        while (written < target && !destroyed) {
          const chunk = "x".repeat(chunkSize);
          const canWrite = rawSocket.write(chunk);
          written += chunkSize;
          if (!canWrite && !destroyed) {
            // Wait for drain before writing more
            await new Promise<void>((resolve) => {
              rawSocket.once("drain", resolve);
              // Safety: if socket destroyed, also resolve
              rawSocket.once("close", resolve);
              setTimeout(resolve, 1000);
            });
          }
        }

        // Wait for the broker to detect overflow and destroy our socket
        await waitFor(() => destroyed, 30000, 50);
        expect(destroyed).toBe(true);

        rawSocket.destroy();
      } finally {
        proc.kill();
      }
    }, 30_000);
  });

  // ── Multiple clients ──────────────────────────────────────────────────────

  describe("multiple clients", () => {
    test("multiple clients can connect and make sequential requests", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);
        const client3 = await TestClient.connectAndInit(sockPath);

        // Each client makes a non-streaming request sequentially
        const r1 = await client1.request("thread/list") as { data: unknown[] };
        expect(r1.data).toBeArrayOfSize(0);

        const r2 = await client2.request("thread/list") as { data: unknown[] };
        expect(r2.data).toBeArrayOfSize(0);

        const r3 = await client3.request("thread/list") as { data: unknown[] };
        expect(r3.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
        await client3.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("client disconnect during stream preserves concurrency lock until turn completes", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Use a longer delay to ensure stream ownership is firmly established
        await new Promise((r) => setTimeout(r, 300));

        // Client 1 disconnects while stream is active
        await client1.close();
        // Wait long enough for broker to process the disconnect and set sentinel
        await new Promise((r) => setTimeout(r, 300));

        // Client 2 tries to start a new streaming request — should be blocked
        // because the orphaned stream is still a sentinel (turn never completed)
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "next" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("client disconnect before turn/start response preserves request lock", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        turnDelay: 1000,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        void client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "slow start" }],
        }).catch(() => undefined);

        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "must not interleave" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan stream stays reserved after a successful interrupt RPC", async () => {
      // Regression: the orphan path used to drop the stream reservation
      // when turn/interrupt succeeded, on the assumption that success meant
      // the turn was fully cancelled. But turn/interrupt only acknowledges
      // the request; the app-server may still be unwinding. A second
      // streaming client could then start a turn on the same app-server
      // while the previous one was mid-cancel. Reserve before the
      // interrupt and let the natural turn/completed (or the watchdog)
      // release.
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // Delay the turn/start response so the broker is awaiting
      // appClient.request when client1 disconnects — that is the only
      // condition that triggers the orphan branch on the post-response
      // path. Don't send turn/completed so the reservation must come from
      // the orphan code, not from the normal completion flow.
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        turnDelay: 300,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        void client1.request("turn/start", {
          threadId: "thread-orphan",
          input: [{ type: "text", text: "go" }],
        }).catch(() => undefined);

        // Disconnect during the broker's await on appClient.request, so
        // the orphan branch fires when the response finally arrives.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();
        // Wait long enough for the response (turnDelay=300ms) to land,
        // the orphan path to set up the reservation, and turn/interrupt
        // to come back as success.
        await new Promise((r) => setTimeout(r, 500));

        // A second client must NOT be able to start a streaming RPC on
        // the same app-server while the orphan is still unwinding.
        const client2 = await TestClient.connectAndInit(sockPath);
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-orphan-2",
            input: [{ type: "text", text: "no" }],
          });
        } catch (err) {
          gotBusy = true;
          // -32001 = BROKER_BUSY
          expect((err as { code?: number }).code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan fast turn (completed before response) does NOT hold the stream slot", async () => {
      // Regression: when a streaming client disconnects mid-request AND its
      // turn/completed lands before the turn/start response is processed (the
      // fast-turn race), the orphan path must NOT reserve the stream slot — the
      // turn is already done, so there is nothing to unwind. Reserving would
      // pin the broker busy until the watchdog fires (ORPHAN_WATCHDOG_MS = idle
      // timeout), forcing every other client onto direct connections meanwhile.
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // completeBeforeResponse: the single turn/completed (turn-001) is written
      // before the turn/start response; turnDelay holds the response so the
      // client can disconnect after the completion but before the response
      // lands. sendTurnCompleted:false ensures NO second completion is sent
      // after the response — that's what production does (one completion per
      // turn), and a second completion would mask the bug by naturally
      // releasing the (incorrect) orphan reservation.
      const mockDir = createMockCodex(tempDir, {
        completeBeforeResponse: true,
        sendTurnCompleted: false,
        turnDelay: 300,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        void client1.request("turn/start", {
          threadId: "thread-fast-orphan",
          input: [{ type: "text", text: "go" }],
        }).catch(() => undefined);

        // Disconnect after turn/completed is processed (sent first) but before
        // the delayed turn/start response arrives.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();
        // Let the response land (turnDelay=300ms) and the orphan branch run.
        await new Promise((r) => setTimeout(r, 500));

        // The slot must be free: a second streaming client must NOT get busy.
        const client2 = await TestClient.connectAndInit(sockPath);
        let result: unknown;
        let busyErr: { code?: number } | null = null;
        try {
          result = await client2.request("turn/start", {
            threadId: "thread-fast-orphan-2",
            input: [{ type: "text", text: "ok" }],
          });
        } catch (err) {
          busyErr = err as { code?: number };
        }
        expect(busyErr).toBeNull();
        expect(result).toBeDefined();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("review client disconnect before review/start response interrupts the review subthread", async () => {
      // Regression: the orphan path read params.threadId (parent) and sent
      // turn/interrupt there, while the actual review turn runs on the
      // response's reviewThreadId. The interrupt missed, so the review kept
      // running and held the broker's stream slot until natural completion.
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        reviewDelay: 200, // window for the client to disconnect mid-flight
      });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);

        // Fire-and-forget so we can close before the response lands.
        void client1.request("review/start", {
          threadId: "thread-parent",
          target: { type: "uncommittedChanges" },
        }).catch(() => undefined);

        // Disconnect before reviewDelay elapses — the broker is still
        // awaiting appClient.request, and the orphan-detection branch will
        // fire once that promise resolves with the review subthread.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();

        await waitFor(() => existsSync(interruptLog), 5000, 50);
        const interrupts = readFileSync(interruptLog, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Must target the review subthread, NOT the parent.
        expect(interrupts).toContainEqual({
          threadId: "review-thread-001",
          turnId: "review-turn-001",
        });
        expect(interrupts).not.toContainEqual({
          threadId: "thread-parent",
          turnId: "review-turn-001",
        });
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan watchdog interrupts with threadId and turnId", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 1000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        await waitFor(() => existsSync(interruptLog), 5000, 50);
        const interrupts = readFileSync(interruptLog, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(interrupts).toContainEqual({
          threadId: "thread-001",
          turnId: "turn-001",
        });
      } finally {
        proc.kill();
      }
    }, 10_000);
  });

  // ── Streaming methods ─────────────────────────────────────────────────────

  describe("streaming methods", () => {
    test("review/start establishes stream ownership with reviewThreadId", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      // Use a long turn-completed delay so stream stays active during the test
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 5000,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a review (streaming method)
        const reviewResult = await client1.request("review/start", {
          threadId: "thread-001",
          target: { type: "uncommittedChanges" },
        }) as { turn: { id: string }; reviewThreadId: string };
        expect(reviewResult.reviewThreadId).toBe("review-thread-001");

        // Immediately try client 2 — review stream is still active (5s delay)
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "hello" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Error forwarding ──────────────────────────────────────────────────────

  describe("error forwarding", () => {
    test("app-server error responses are forwarded to the client", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a method that the mock doesn't know — it returns Method not found
        try {
          await client.request("unknown/method");
          throw new Error("Expected error");
        } catch (err: any) {
          expect(err.message).toContain("Method not found: unknown/method");
          expect(err.code).toBe(-32601);
        }

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Forwarded response from wrong socket ──────────────────────────────────

  describe("forwarded response validation", () => {
    // NOTE: This test only verifies the broker doesn't crash when receiving a
    // response with an unknown id. It does not verify that the response is
    // actually dropped (vs. silently forwarded somewhere). The broker logs a
    // warning to stderr, but we don't capture subprocess stderr in assertions.
    test("response for unknown forwarded request is ignored", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a response with an id that doesn't match any pending forwarded request
        client.send({ id: "nonexistent-req-id", result: { ok: true } });

        // Broker should just log a warning and continue functioning
        await new Promise((r) => setTimeout(r, 200));
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Stale socket cleanup ──────────────────────────────────────────────────

  describe("stale socket cleanup", () => {
    test("removes stale socket file before listening", async () => {

      const sockPath = join(tempDir, "broker.sock");
      const endpoint = `unix:${sockPath}`;
      const mockDir = createMockCodex(tempDir);

      // Create a stale socket file
      writeFileSync(sockPath, "stale");

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        // Should be able to connect despite the stale file
        const client = await TestClient.connectAndInit(sockPath);
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });
});
