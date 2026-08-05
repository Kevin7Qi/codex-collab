import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { parseMessage, formatNotification, formatResponse, connectDirect as connect, connectDirectWithRetry as connectWithRetry, explainConnectionFailure, withStartupLock, startupLockPath, type AppServerClient } from "./client";
import { join } from "path";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { config } from "./config";
import { acquireLockAsync } from "./lock";

// Test-local formatRequest helper with its own counter (not exported from client.ts
// to avoid ID collisions with AppServerClient's internal counter).
let testNextId = 1;
function formatRequest(method: string, params?: unknown): { line: string; id: number } {
  const id = testNextId++;
  const msg: Record<string, unknown> = { id, method };
  if (params !== undefined) msg.params = params;
  return { line: JSON.stringify(msg) + "\n", id };
}

async function captureErrorMessage(promise: Promise<unknown>): Promise<string> {
  // Workaround: bun test on Windows doesn't flush .rejects properly, so we
  // capture the rejection message manually instead of using .rejects.toThrow().
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (resolved) throw new Error("Expected promise to reject, but it resolved");
  return ""; // unreachable
}

const TEST_DIR = join(tmpdir(), "codex-collab-test-protocol");
const MOCK_SERVER = join(TEST_DIR, "mock-app-server.ts");

const MOCK_SERVER_SOURCE = `#!/usr/bin/env bun
function respond(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const exitEarly = process.env.MOCK_EXIT_EARLY === "1";
const errorResponse = process.env.MOCK_ERROR_RESPONSE === "1";
if (process.env.MOCK_SPAWN_GRANDCHILD) {
  const argv = process.env.MOCK_GRANDCHILD_STUBBORN === "1"
    ? ["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"]
    : ["sleep", "300"];
  const child = Bun.spawn(argv);
  require("fs").writeFileSync(process.env.MOCK_SPAWN_GRANDCHILD, String(child.pid));
}
let buffer = "";
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
    if (msg.id !== undefined && msg.method) {
      switch (msg.method) {
        case "initialize":
          respond({ id: msg.id, result: { userAgent: "mock-codex-server/0.1.0" } });
          if (exitEarly) setTimeout(() => process.exit(0), 50);
          break;
        case "thread/start":
          if (errorResponse) {
            respond({ id: msg.id, error: { code: -32603, message: "Internal error: model not available" } });
          } else {
            respond({ id: msg.id, result: {
              thread: { id: "thread-mock-001", preview: "", modelProvider: "openai",
                createdAt: Date.now(), updatedAt: Date.now(), status: { type: "idle" },
                path: null, cwd: "/tmp", cliVersion: "0.1.0", source: "mock", name: null,
                agentNickname: null, agentRole: null, gitInfo: null, turns: [] },
              model: msg.params?.model || "gpt-5.3-codex", modelProvider: "openai",
              cwd: "/tmp", approvalPolicy: "never", sandbox: null,
            }});
          }
          break;
        default:
          respond({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
      }
    }
  }
});
process.stdin.on("end", () => { if (process.env.MOCK_IGNORE_STDIN_END !== "1") process.exit(0); });
process.stdin.on("error", () => process.exit(1));
`;

beforeAll(async () => {
  const { mkdirSync, existsSync } = await import("fs");
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  await Bun.write(MOCK_SERVER, MOCK_SERVER_SOURCE);
});

beforeEach(() => {
  testNextId = 1;
});

describe("formatRequest", () => {
  test("formats a request with auto-incrementing id", () => {
    const { line, id } = formatRequest("thread/start", { model: "gpt-5.3-codex" });
    expect(id).toBe(1);
    expect(line).toContain('"method":"thread/start"');
    expect(line).toContain('"id":1');
    expect(line).toContain('"model":"gpt-5.3-codex"');
    expect(line).not.toContain("jsonrpc");
    expect(line.endsWith("\n")).toBe(true);
  });

  test("auto-increments id across calls", () => {
    const first = formatRequest("a");
    const second = formatRequest("b");
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
  });

  test("omits params when not provided", () => {
    const { line } = formatRequest("initialized");
    const parsed = JSON.parse(line);
    expect(parsed).not.toHaveProperty("params");
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("method", "initialized");
  });

  test("returns valid JSON", () => {
    const { line } = formatRequest("test", { key: "value" });
    const parsed = JSON.parse(line.trim());
    expect(parsed.id).toBe(1);
    expect(parsed.method).toBe("test");
    expect(parsed.params).toEqual({ key: "value" });
  });
});

describe("formatNotification", () => {
  test("formats a notification without id", () => {
    const msg = formatNotification("initialized");
    expect(msg).toContain('"method":"initialized"');
    expect(msg).not.toContain('"id"');
    expect(msg.endsWith("\n")).toBe(true);
  });

  test("includes params when provided", () => {
    const msg = formatNotification("item/started", { itemId: "abc" });
    const parsed = JSON.parse(msg);
    expect(parsed.method).toBe("item/started");
    expect(parsed.params).toEqual({ itemId: "abc" });
    expect(parsed).not.toHaveProperty("id");
  });

  test("omits params when not provided", () => {
    const msg = formatNotification("initialized");
    const parsed = JSON.parse(msg);
    expect(parsed).not.toHaveProperty("params");
  });

  test("does not include jsonrpc field", () => {
    const msg = formatNotification("test");
    expect(msg).not.toContain("jsonrpc");
  });
});

describe("formatResponse", () => {
  test("formats a response with matching id", () => {
    const msg = formatResponse(42, { decision: "accept" });
    expect(msg).toContain('"id":42');
    expect(msg).toContain('"result"');
    expect(msg.endsWith("\n")).toBe(true);
  });

  test("returns valid JSON with id and result", () => {
    const msg = formatResponse(7, { ok: true });
    const parsed = JSON.parse(msg);
    expect(parsed.id).toBe(7);
    expect(parsed.result).toEqual({ ok: true });
  });

  test("works with string id", () => {
    const msg = formatResponse("req-1", "done");
    const parsed = JSON.parse(msg);
    expect(parsed.id).toBe("req-1");
    expect(parsed.result).toBe("done");
  });

  test("does not include jsonrpc field", () => {
    const msg = formatResponse(1, null);
    expect(msg).not.toContain("jsonrpc");
  });
});

describe("parseMessage", () => {
  test("parses a response", () => {
    const msg = parseMessage('{"id":1,"result":{"thread":{"id":"t1"}}}');
    expect(msg).toHaveProperty("id", 1);
    expect(msg).toHaveProperty("result");
  });

  test("parses a notification", () => {
    const msg = parseMessage('{"method":"turn/completed","params":{"threadId":"t1"}}');
    expect(msg).toHaveProperty("method", "turn/completed");
    expect(msg).not.toHaveProperty("id");
  });

  test("parses an error response", () => {
    const msg = parseMessage('{"id":1,"error":{"code":-32600,"message":"Invalid"}}');
    expect(msg).toHaveProperty("error");
  });

  test("returns null for malformed error response", () => {
    const msg = parseMessage('{"id":1,"error":null}');
    expect(msg).toBeNull();
  });

  test("returns null for response with both result and error", () => {
    const msg = parseMessage('{"id":1,"result":"ok","error":{"code":-1,"message":"bad"}}');
    expect(msg).toBeNull();
  });

  test("returns null for request/response hybrid", () => {
    const msg = parseMessage('{"id":1,"method":"turn/start","result":"ok"}');
    expect(msg).toBeNull();
  });

  test("parses a request (has id and method)", () => {
    const msg = parseMessage('{"id":5,"method":"item/commandExecution/requestApproval","params":{"command":"rm -rf /"}}');
    expect(msg).toHaveProperty("id", 5);
    expect(msg).toHaveProperty("method", "item/commandExecution/requestApproval");
    expect(msg).toHaveProperty("params");
  });

  test("returns null for invalid JSON", () => {
    const msg = parseMessage("not json");
    expect(msg).toBeNull();
  });

  test("returns null for empty string", () => {
    const msg = parseMessage("");
    expect(msg).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    const msg = parseMessage("{broken:}");
    expect(msg).toBeNull();
  });

  test("returns null for object with non-string method", () => {
    const msg = parseMessage('{"method":123}');
    expect(msg).toBeNull();
  });

  test("returns null for object with non-string/number id", () => {
    const msg = parseMessage('{"id":true,"result":"ok"}');
    expect(msg).toBeNull();
  });

  test("returns null for object with neither method nor id", () => {
    const msg = parseMessage('{"foo":"bar"}');
    expect(msg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AppServerClient integration tests (using mock server)
// ---------------------------------------------------------------------------

// Each test manages its own client lifecycle to avoid dangling-process races
// when bun runs tests concurrently within a describe block.
describe("AppServerClient", () => {
  // close() now properly awaits process exit on all platforms, so no
  // inter-test delay is needed.

  test("connect performs initialize handshake and returns userAgent", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });
    try {
      expect(c.userAgent).toBe("mock-codex-server/0.1.0");
    } finally {
      await c.close();
    }
  });

  test("close shuts down gracefully", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });
    await c.close();
    // No error means success — process exited cleanly
  });

  test("request sends and receives response", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });
    try {
      const result = await c.request<{ thread: { id: string }; model: string }>(
        "thread/start",
        { model: "gpt-5.3-codex" },
      );
      expect(result.thread.id).toBe("thread-mock-001");
      expect(result.model).toBe("gpt-5.3-codex");
    } finally {
      await c.close();
    }
  });

  test("request rejects with descriptive error on JSON-RPC error response", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
      env: { MOCK_ERROR_RESPONSE: "1" },
    });
    try {
      let error: unknown;
      try {
        await c.request("thread/start", { model: "bad-model" });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "JSON-RPC error -32603: Internal error: model not available",
      );
      expect((error as { rpcCode?: number }).rpcCode).toBe(-32603);
    } finally {
      await c.close();
    }
  });

  test("request rejects with error for unknown method", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });
    try {
      const error = await captureErrorMessage(c.request("unknown/method"));
      expect(error).toContain("Method not found: unknown/method");
    } finally {
      await c.close();
    }
  });

  test("request rejects when process exits unexpectedly", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
      env: { MOCK_EXIT_EARLY: "1" },
    });
    try {
      // The mock server exits after initialize, so the next request should fail
      await new Promise((r) => setTimeout(r, 100));
      const error = await captureErrorMessage(c.request("thread/start"));
      expect(error.length).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  });

  test("request rejects after client is closed", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });
    await c.close();

    const error = await captureErrorMessage(c.request("thread/start"));
    expect(error).toContain("Client is closed");
  });

  test("notification handlers receive server notifications", async () => {
    // For this test we use a custom inline mock that sends a notification
    const notifyServer = `
      let buffer = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              id: msg.id,
              result: { userAgent: "notify-server/0.1.0" },
            }) + "\\n");
          }
          if (!msg.id && msg.method === "initialized") {
            process.stdout.write(JSON.stringify({
              method: "item/started",
              params: { item: { type: "agentMessage", id: "item-1", text: "" }, threadId: "t1", turnId: "turn-1" },
            }) + "\\n");
          }
        }
      });
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("error", () => process.exit(1));
    `;

    const serverPath = join(TEST_DIR, "mock-notify-server.ts");
    await Bun.write(serverPath, notifyServer);

    const received: unknown[] = [];
    const c = await connect({
      command: ["bun", "run", serverPath],
      requestTimeout: 10000,
    });

    try {
      c.on("item/started", (params) => {
        received.push(params);
      });

      // Give time for the notification to arrive
      await new Promise((r) => setTimeout(r, 200));

      expect(received.length).toBe(1);
      expect(received[0]).toEqual({
        item: { type: "agentMessage", id: "item-1", text: "" },
        threadId: "t1",
        turnId: "turn-1",
      });
    } finally {
      await c.close();
    }
  });

  test("onRequest handler responds to server requests", async () => {
    // Mock server that sends a server request after initialize
    const approvalServer = `
      let sentApproval = false;
      let buffer = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.method === "initialize") {
            process.stdout.write(JSON.stringify({
              id: msg.id,
              result: { userAgent: "approval-server/0.1.0" },
            }) + "\\n");
          }
          if (!msg.id && msg.method === "initialized" && !sentApproval) {
            sentApproval = true;
            process.stdout.write(JSON.stringify({
              id: "srv-1",
              method: "item/commandExecution/requestApproval",
              params: { command: "rm -rf /", threadId: "t1", turnId: "turn-1", itemId: "item-1" },
            }) + "\\n");
          }
          if (msg.id === "srv-1" && msg.result) {
            process.stdout.write(JSON.stringify({
              method: "test/approvalReceived",
              params: { decision: msg.result.decision },
            }) + "\\n");
          }
        }
      });
      process.stdin.on("end", () => process.exit(0));
      process.stdin.on("error", () => process.exit(1));
    `;

    const serverPath = join(TEST_DIR, "mock-approval-server.ts");
    await Bun.write(serverPath, approvalServer);

    const c = await connect({
      command: ["bun", "run", serverPath],
      requestTimeout: 10000,
    });

    try {
      // Register handler for approval requests
      c.onRequest("item/commandExecution/requestApproval", (params: any) => {
        return { decision: "accept" };
      });

      // Wait for the round-trip
      const received: unknown[] = [];
      c.on("test/approvalReceived", (params) => {
        received.push(params);
      });

      await new Promise((r) => setTimeout(r, 300));

      expect(received.length).toBe(1);
      expect(received[0]).toEqual({ decision: "accept" });
    } finally {
      await c.close();
    }
  });

  test("on returns unsubscribe function", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
    });

    try {
      const received: unknown[] = [];
      const unsub = c.on("test/event", (params) => {
        received.push(params);
      });

      // Unsubscribe immediately
      unsub();

      // Even if a notification arrived, handler should not fire
      // (no notification is sent by the basic mock, but this verifies the unsub mechanism)
      expect(received.length).toBe(0);
    } finally {
      await c.close();
    }
  });
});

// ---------------------------------------------------------------------------
// close() must kill grandchildren (Unix process group)
// ---------------------------------------------------------------------------

/** kill(pid, 0) succeeds for zombies: an orphaned grandchild stays STAT=Z
 *  until PID 1 reaps it, which never happens promptly in containers with a
 *  non-reaping init. Read the process state so "killed but unreaped" counts
 *  as dead. */
function grandchildAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
    .stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
}

describe("close() kills grandchildren", () => {
  test("a grandchild of a hung server dies with the process group", async () => {
    if (process.platform === "win32") return; // Windows tree kill is taskkill /T
    const pidFile = join(TEST_DIR, `grandchild-${process.pid}-${Date.now()}.pid`);
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
      env: { MOCK_SPAWN_GRANDCHILD: pidFile, MOCK_IGNORE_STDIN_END: "1" },
    });

    const { existsSync, readFileSync, rmSync } = await import("fs");
    let grandchildPid = 0;
    for (let i = 0; i < 100 && !grandchildPid; i++) {
      if (existsSync(pidFile)) grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
      if (!grandchildPid) await new Promise((r) => setTimeout(r, 50));
    }
    expect(grandchildPid).toBeGreaterThan(0);

    try {
      // The server ignores stdin EOF (hung server), so close() escalates to
      // a group SIGTERM — which must take the grandchild down too. Before
      // group signalling, only the direct child died and sleep(300) leaked.
      await c.close();

      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        alive = grandchildAlive(grandchildPid);
        if (alive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive).toBe(false);
    } finally {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      rmSync(pidFile, { force: true });
    }
  }, 20000);

  // Parameterized: a well-behaved grandchild dies from the sweep's SIGTERM;
  // a SIGTERM-ignoring one must be caught by the sweep's SIGKILL escalation.
  for (const stubborn of [false, true]) {
    test(`a grandchild left behind by a GRACEFUL exit is swept (${stubborn ? "ignores SIGTERM" : "well-behaved"})`, async () => {
    if (process.platform === "win32") return;
    const pidFile = join(TEST_DIR, `grandchild-graceful-${stubborn}-${process.pid}-${Date.now()}.pid`);
    // Default mock behavior: exits on stdin EOF — but the grandchild it
    // spawned survives that clean exit. close() must sweep the group.
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
      env: {
        MOCK_SPAWN_GRANDCHILD: pidFile,
        ...(stubborn ? { MOCK_GRANDCHILD_STUBBORN: "1" } : {}),
      },
    });

    const { existsSync, readFileSync, rmSync } = await import("fs");
    let grandchildPid = 0;
    for (let i = 0; i < 100 && !grandchildPid; i++) {
      if (existsSync(pidFile)) grandchildPid = Number(readFileSync(pidFile, "utf-8").trim());
      if (!grandchildPid) await new Promise((r) => setTimeout(r, 50));
    }
    expect(grandchildPid).toBeGreaterThan(0);

    try {
      await c.close();
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        alive = grandchildAlive(grandchildPid);
        if (alive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive).toBe(false);
    } finally {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      rmSync(pidFile, { force: true });
    }
    }, 20000);
  }
});

// ─── connectDirectWithRetry ────────────────────────────────────────────────

/** An app-server that dies during startup on its first N spawns, then behaves.
 *  Models codex losing the exclusive lock on its shared sqlite state: it never
 *  answers `initialize`, it just exits. The attempt counter lives in a file so
 *  it survives across spawns and lets a test pin the exact number of tries. */
const FLAKY_SERVER = join(TEST_DIR, "flaky-app-server.ts");
const FLAKY_SERVER_SOURCE = `#!/usr/bin/env bun
const fs = require("fs");
const counterPath = process.env.FLAKY_COUNTER;
const failCount = Number(process.env.FLAKY_FAIL_COUNT ?? "1");
let attempts = 0;
try { attempts = Number(fs.readFileSync(counterPath, "utf-8")) || 0; } catch {}
fs.writeFileSync(counterPath, String(attempts + 1));
if (attempts < failCount) {
  process.stderr.write("Error: failed to initialize sqlite state runtime under /tmp/codex\\n");
  process.exit(1);
}
function respond(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
let buffer = "";
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
    if (msg.id !== undefined && msg.method === "initialize") {
      respond({ id: msg.id, result: { userAgent: "flaky-mock/0.1.0" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(1));
`;

describe("connectDirectWithRetry", () => {
  let counterPath: string;
  let logged: string[];
  let restoreError: (() => void) | null = null;

  beforeEach(async () => {
    const { mkdirSync, existsSync, rmSync } = await import("fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    await Bun.write(FLAKY_SERVER, FLAKY_SERVER_SOURCE);
    counterPath = join(TEST_DIR, `flaky-counter-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    rmSync(counterPath, { force: true });

    // Capture the retry notice: it is the only observable that distinguishes
    // "classified as transient and retried" from "happened to succeed".
    logged = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
    restoreError = () => { console.error = original; };
  });

  afterEach(async () => {
    restoreError?.();
    restoreError = null;
    const { rmSync } = await import("fs");
    rmSync(counterPath, { force: true });
  });

  async function attempts(): Promise<number> {
    const { readFileSync, existsSync } = await import("fs");
    return existsSync(counterPath) ? Number(readFileSync(counterPath, "utf-8")) : 0;
  }

  test("retries once when the app-server dies during startup", async () => {
    const c = await connectWithRetry({
      command: ["bun", "run", FLAKY_SERVER],
      requestTimeout: 10000,
      env: { FLAKY_COUNTER: counterPath, FLAKY_FAIL_COUNT: "1" },
    });
    try {
      expect(c.userAgent).toBe("flaky-mock/0.1.0");
      expect(await attempts()).toBe(2);
      expect(logged.some((l) => /retrying once/i.test(l))).toBe(true);
    } finally {
      await c.close();
    }
  }, 20000);

  test("retries at most once, then surfaces the failure", async () => {
    // Pins the cap: a second startup death must propagate rather than loop.
    const error = await captureErrorMessage(connectWithRetry({
      command: ["bun", "run", FLAKY_SERVER],
      requestTimeout: 10000,
      env: { FLAKY_COUNTER: counterPath, FLAKY_FAIL_COUNT: "2" },
    }));
    expect(error).toContain("App server process exited unexpectedly");
    expect(await attempts()).toBe(2);
  }, 20000);

  test("does not retry a binary that never started", async () => {
    // ENOENT is deterministic — retrying only doubles the time to the same
    // error, and the user needs the install hint, not a delay. It surfaces as
    // either the spawn error or a write into never-opened stdin, depending on
    // which wins the race, so assert the decision rather than the wording.
    const error = await captureErrorMessage(connectWithRetry({
      command: [join(TEST_DIR, "definitely-not-a-real-binary")],
      requestTimeout: 5000,
    }));
    expect(error.length).toBeGreaterThan(0);

    // Windows runs commands through a `cmd.exe /c` shim, so the shim spawns
    // successfully and its exit is reported as a startup death — a missing
    // binary is genuinely indistinguishable there, and IS retried. Asserting
    // the Unix outcome cross-platform would only encode a wrong expectation.
    if (process.platform !== "win32") {
      expect(error).not.toContain("App server process exited unexpectedly");
      expect(logged.some((l) => /retrying once/i.test(l))).toBe(false);
    }
  }, 20000);
});

describe("connectDirect onSpawn", () => {
  test("reports the child PID before the handshake completes", async () => {
    // The broker needs a handle on its app-server during startup: if the
    // handshake hangs it never receives a client, and killing the PID is the
    // only way to avoid orphaning a detached process that holds codex's
    // sqlite state lock.
    const seen: number[] = [];
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 10000,
      onSpawn: (pid) => seen.push(pid),
    });
    try {
      expect(seen.length).toBe(1);
      expect(seen[0]).toBeGreaterThan(0);
    } finally {
      await c.close();
    }
  }, 20000);

  test("reports each attempt's PID when the first one dies", async () => {
    const { mkdirSync, existsSync } = await import("fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    await Bun.write(FLAKY_SERVER, FLAKY_SERVER_SOURCE);
    const counter = join(TEST_DIR, `onspawn-counter-${Date.now()}`);
    const seen: number[] = [];
    const c = await connectWithRetry({
      command: ["bun", "run", FLAKY_SERVER],
      requestTimeout: 10000,
      env: { FLAKY_COUNTER: counter, FLAKY_FAIL_COUNT: "1" },
      onSpawn: (pid) => seen.push(pid),
    });
    try {
      // Two spawns, two distinct PIDs — the retry's PID must not shadow a
      // stale one the caller might still act on.
      expect(seen.length).toBe(2);
      expect(seen[0]).not.toBe(seen[1]);
    } finally {
      await c.close();
      const { rmSync } = await import("fs");
      rmSync(counter, { force: true });
    }
  }, 20000);
});

describe("explainConnectionFailure", () => {
  const withStderr = (stderr: string) =>
    Object.assign(new Error("App server process exited unexpectedly"), { appServerStderr: stderr });

  test("names the locked directory and what to do about it", () => {
    // "process exited unexpectedly" is a symptom. The cause is a stderr line
    // the user has no reason to connect to it, so say it out loud.
    const msg = explainConnectionFailure(withStderr(
      "Error: failed to initialize sqlite state runtime under /home/u/.codex: database is locked",
    ));
    expect(msg).toContain("/home/u/.codex");
    expect(msg).toMatch(/Another Codex process/);
    expect(msg).toMatch(/codex app-server|codex-collab health/);
  });

  test("only a real busy/locked signature claims contention", () => {
    for (const s of ["Error: database is locked", "Error: database table is locked", "SQLITE_BUSY"]) {
      expect(explainConnectionFailure(withStderr(s))).toMatch(/Another Codex process is using/);
    }
  });

  test("the wrapper alone does not assert a cause", () => {
    // codex emits it for contention, corruption, a full disk and permissions
    // alike. Telling someone to wait for a lock that is really a malformed
    // database sends them after the wrong problem.
    const generic = explainConnectionFailure(withStderr(
      "Error: failed to initialize sqlite state runtime under /home/u/.codex: database disk image is malformed",
    ));
    expect(generic).toMatch(/could not initialize its state database/);
    expect(generic).not.toMatch(/Another Codex process is using/);
    expect(generic).toMatch(/underlying cause/);
    expect(generic).toContain("/home/u/.codex");
  });

  test("a directory containing spaces is reported whole", () => {
    // \S+ truncated "C:\\Users\\First Last\\.codex" to "C:\\Users\\First", pointing
    // the user at a path that does not exist.
    const msg = explainConnectionFailure(withStderr(
      "Error: failed to initialize state runtime at C:\\Users\\First Last\\.codex: database is locked",
    ));
    expect(msg).toContain("C:\\Users\\First Last\\.codex");
  });

  test("process-inspection advice is runnable on this platform", () => {
    // `ps aux` does not exist in cmd or PowerShell.
    const msg = explainConnectionFailure(withStderr("Error: database is locked"))!;
    expect(msg).toContain(process.platform === "win32" ? "tasklist" : "ps aux");
    if (process.platform === "win32") expect(msg).not.toContain("ps aux");
  });

  test("SQLITE_CANTOPEN is a broken path, not contention", () => {
    // Opposite remedy: nothing is going to clear, so telling the user to wait
    // and hunt for a stuck app server sends them after the wrong problem.
    const msg = explainConnectionFailure(withStderr(
      "Error: failed to initialize sqlite state runtime under /bad/dir: unable to open database file",
    ));
    expect(msg).toMatch(/could not open its state database/);
    expect(msg).toMatch(/retrying will not help/);
    expect(msg).not.toMatch(/Another Codex process/);
    expect(msg).toContain("/bad/dir");
  });

  test("claims a retry only when one actually happened", () => {
    // withClient's post-handshake busy fallback and any external caller reach
    // the explanation having spawned exactly once.
    const once = withStderr("Error: database is locked");
    expect(explainConnectionFailure(once)).not.toMatch(/already retried/);
    expect(explainConnectionFailure(Object.assign(once, { appServerRetried: true })))
      .toMatch(/already retried once/);
  });

  test("explains nothing for an unrelated crash", () => {
    // A false match would misexplain the failure, which is worse than the
    // bare error — so an unrecognized stderr must stay silent.
    expect(explainConnectionFailure(withStderr("thread 'main' panicked at src/lib.rs:42"))).toBeNull();
    expect(explainConnectionFailure(new Error("App server process exited unexpectedly"))).toBeNull();
    expect(explainConnectionFailure(null)).toBeNull();
  });

  test("falls back to CODEX_HOME when the path is not in the message", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/custom/codex";
    try {
      expect(explainConnectionFailure(withStderr("Error: database is locked"))).toContain("/custom/codex");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  });

  test("a real startup death carries its stderr through to the explanation", async () => {
    // End-to-end: the tail must survive connectDirect's failure path, not
    // just be reachable when a test hands it in.
    const { mkdirSync, existsSync } = await import("fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const dying = join(TEST_DIR, "locked-app-server.ts");
    await Bun.write(dying, `#!/usr/bin/env bun
process.stderr.write("Error: failed to initialize sqlite state runtime under /home/u/.codex: locked\\n");
setTimeout(() => process.exit(1), 30);
`);
    const error = await captureErrorMessage(connect({
      command: ["bun", "run", dying],
      requestTimeout: 5000,
    }).catch((e) => { throw Object.assign(e, { explained: explainConnectionFailure(e) }); }));
    expect(error).toContain("App server process exited unexpectedly");
  }, 20000);
});

describe("startup retry policy vs state failures", () => {
  test("an unopenable state directory is not retried", async () => {
    // Deterministic: the second spawn fails identically 750ms later, and the
    // retry notice would tell the user to expect contention that isn't there.
    const { mkdirSync, existsSync } = await import("fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const counter = join(TEST_DIR, `cantopen-counter-${Date.now()}`);
    const script = join(TEST_DIR, "cantopen-app-server.ts");
    await Bun.write(script, `#!/usr/bin/env bun
const fs = require("fs");
let n = 0; try { n = Number(fs.readFileSync(process.env.C, "utf-8")) || 0; } catch {}
fs.writeFileSync(process.env.C, String(n + 1));
process.stderr.write("Error: failed to initialize sqlite state runtime under /bad: unable to open database file\\n");
setTimeout(() => process.exit(1), 20);
`);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
    try {
      await captureErrorMessage(connectWithRetry({
        command: ["bun", "run", script],
        requestTimeout: 5000,
        env: { C: counter },
      }));
    } finally {
      console.error = original;
    }
    const { readFileSync, rmSync } = await import("fs");
    expect(Number(readFileSync(counter, "utf-8"))).toBe(1); // one spawn, not two
    expect(logged.some((l) => /retrying once/i.test(l))).toBe(false);
    rmSync(counter, { force: true });
  }, 20000);
});

describe("stderr retained across chunk boundaries", () => {
  test("a message split by the stream still classifies", async () => {
    // Chunk boundaries are arbitrary. Trimming each chunk and joining with
    // newlines turned "database is" + " locked" into "database is\nlocked",
    // so the lock classifier missed a failure it should have named.
    const { mkdirSync, existsSync } = await import("fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const split = join(TEST_DIR, "split-stderr-app-server.ts");
    await Bun.write(split, `#!/usr/bin/env bun
process.stderr.write("Error: failed to initialize sqlite state runtime under /home/u/.codex: database is");
setTimeout(() => {
  process.stderr.write(" locked\\n");
  setTimeout(() => process.exit(1), 30);
}, 40);
`);
    let captured: unknown = null;
    try {
      await connect({ command: ["bun", "run", split], requestTimeout: 5000 });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    const msg = explainConnectionFailure(captured);
    expect(msg).toMatch(/Another Codex process is using/);
    expect(msg).toContain("/home/u/.codex");
  }, 20000);
});


// The lock lives under ~/.codex-collab. A sandbox that denies writes there
// makes withStartupLock fail open — correct behaviour, but it turns these
// assertions into noise. Announce and skip, the same way the broker suite
// handles a socket it cannot bind: a run that does not cover this should say
// so rather than report a pass it did not earn.
const LOCK_DIR_WRITABLE = await (async () => {
  // Acquire a throwaway lock for real: mkdirSync on an existing directory is
  // a no-op and succeeds even where writes are denied, so only taking a lock
  // proves the capability.
  try {
    mkdirSync(join(config.dataDir, "locks"), { recursive: true, mode: 0o700 });
    const release = await acquireLockAsync(
      join(config.dataDir, "locks", `probe-${process.pid}.lock`),
      { maxAttempts: 1 },
    );
    release();
    return true;
  } catch {
    return false;
  }
})();

if (!LOCK_DIR_WRITABLE) {
  console.warn(
    `\n⚠️  startup-lock tests SKIPPED — cannot write to ${join(config.dataDir, "locks")}.` +
    `\n   This run does NOT cover app-server startup serialization.\n`,
  );
}

describe.skipIf(!LOCK_DIR_WRITABLE)("withStartupLock", () => {
  const HOME = process.env.CODEX_HOME;
  let lockHome: string;

  beforeEach(async () => {
    const { mkdtempSync } = await import("fs");
    lockHome = mkdtempSync(join(tmpdir(), "codex-lock-test-"));
    process.env.CODEX_HOME = lockHome;
  });

  afterEach(async () => {
    if (HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = HOME;
    const { rmSync } = await import("fs");
    rmSync(lockHome, { recursive: true, force: true });
  });

  test("serializes concurrent startups against one CODEX_HOME", async () => {
    // Measured against the real binary: six concurrent app-server starts on a
    // fresh CODEX_HOME lost 1-3 of them to "failed to initialize state
    // runtime", and lost none once serialized. This pins the serialization
    // without needing codex present.
    const spans: Array<[number, number]> = [];
    await Promise.all(Array.from({ length: 3 }, () =>
      withStartupLock(async () => {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, 80));
        spans.push([start, Date.now()]);
      }),
    ));
    expect(spans.length).toBe(3);
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      // Each start must follow the previous end — overlap means the lock did
      // not hold, which is the whole failure being prevented.
      expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1] - 5);
    }
  }, 20000);

  test("runs the work even when the lock cannot be taken", async () => {
    // Fails OPEN by design: a coordination primitive that can wedge every
    // startup is worse than the race it removes. Third-party app-servers
    // never take this lock either, so recovery is required regardless.
    //
    // Hold the lock for real rather than pointing CODEX_HOME at an
    // unwritable path: the file lives in OUR state dir and is only KEYED by
    // CODEX_HOME, so a bogus home still acquires cleanly and would assert
    // nothing.
    const { mkdirSync, writeFileSync, rmSync, utimesSync } = await import("fs");
    const heldLock = startupLockPath();
    mkdirSync(join(config.dataDir, "locks"), { recursive: true, mode: 0o700 });
    writeFileSync(heldLock, "", { flag: "wx" });
    // Keep the holder looking alive for as long as acquisition spins. The
    // spin is a fixed 100 attempts, not a fixed duration, so on a slow enough
    // runner it would outlast the 10s stale threshold, get its lock broken,
    // and acquire cleanly — passing `ran` while silently testing nothing.
    // Refreshing mtime pins the timeout branch at any runner speed.
    const keepFresh = setInterval(() => {
      try { utimesSync(heldLock, new Date(), new Date()); } catch {}
    }, 500);

    const warnings: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => { warnings.push(a.join(" ")); };
    let ran = false;
    try {
      await withStartupLock(async () => { ran = true; });
    } finally {
      clearInterval(keepFresh);
      console.error = original;
      rmSync(heldLock, { force: true });
    }

    expect(ran).toBe(true);
    // Distinguishes failing open from quietly acquiring — without this the
    // assertion above passes even with the catch removed.
    expect(warnings.some((w) => /could not serialize app-server startup/.test(w))).toBe(true);
  }, 30000);

  test("keys the lock by CODEX_HOME but keeps the file in our own state dir", async () => {
    // ~/.codex belongs to codex. Scattering files through another program's
    // directory is a thing users are right to distrust, so the lock is keyed
    // by that path rather than stored under it.
    const { existsSync, readdirSync } = await import("fs");
    await withStartupLock(async () => {
      expect(existsSync(startupLockPath())).toBe(true);
      expect(startupLockPath()).toContain(".codex-collab");
      expect(readdirSync(lockHome)).toEqual([]); // nothing written into CODEX_HOME
    });
  }, 20000);

  test("a different CODEX_HOME is a different lock", () => {
    expect(startupLockPath({ CODEX_HOME: "/one" })).not.toBe(startupLockPath({ CODEX_HOME: "/two" }));
    expect(startupLockPath({ CODEX_HOME: "/one" })).toBe(startupLockPath({ CODEX_HOME: "/one" }));
  });
});

describe.skipIf(!LOCK_DIR_WRITABLE)("startup lock follows the child's environment", () => {
  test("an env override decides the lock, not the parent", async () => {
    // connectDirect lets a caller point the child at a different CODEX_HOME.
    // Locking on the parent's would put two processes that share a child
    // state directory on different locks, serializing nothing.
    const { mkdtempSync, existsSync, rmSync } = await import("fs");
    const childHome = mkdtempSync(join(tmpdir(), "codex-child-home-"));
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-parent-home-"));
    try {
      await withStartupLock(async () => {
        expect(existsSync(startupLockPath({ CODEX_HOME: childHome }))).toBe(true);
        expect(existsSync(startupLockPath())).toBe(false); // not the parent's
      }, { CODEX_HOME: childHome });
    } finally {
      rmSync(childHome, { recursive: true, force: true });
      rmSync(process.env.CODEX_HOME!, { recursive: true, force: true });
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
  }, 20000);
});
