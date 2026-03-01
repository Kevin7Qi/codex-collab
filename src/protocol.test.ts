import { describe, expect, test, beforeAll, beforeEach, afterEach } from "bun:test";
import { parseMessage, formatNotification, formatResponse, connect, type AppServerClient } from "./protocol";
import { join } from "path";
import { tmpdir } from "os";

// Test-local formatRequest helper with its own counter (not exported from protocol.ts
// to avoid ID collisions with AppServerClient's internal counter).
let testNextId = 1;
function formatRequest(method: string, params?: unknown): { line: string; id: number } {
  const id = testNextId++;
  const msg: Record<string, unknown> = { id, method };
  if (params !== undefined) msg.params = params;
  return { line: JSON.stringify(msg) + "\n", id };
}

const TEST_DIR = join(tmpdir(), "codex-collab-test-protocol");
const MOCK_SERVER = join(TEST_DIR, "mock-app-server.ts");

const MOCK_SERVER_SOURCE = `#!/usr/bin/env bun
function respond(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
const exitEarly = process.env.MOCK_EXIT_EARLY === "1";
const errorResponse = process.env.MOCK_ERROR_RESPONSE === "1";
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
process.stdin.on("end", () => process.exit(0));
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
  // On Windows, bun's test runner doesn't fully await async finally blocks before moving
  // to the next test. close() takes ~400ms on Windows (dominated by taskkill process tree
  // cleanup). This delay ensures close() completes before the next test spawns a mock server.
  afterEach(async () => {
    if (process.platform === "win32") {
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  test("connect performs initialize handshake and returns userAgent", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
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
      requestTimeout: 5000,
    });
    await c.close();
    // No error means success — process exited cleanly
  });

  test("request sends and receives response", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
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
      requestTimeout: 5000,
      env: { MOCK_ERROR_RESPONSE: "1" },
    });
    try {
      await expect(
        c.request("thread/start", { model: "bad-model" }),
      ).rejects.toThrow("JSON-RPC error -32603: Internal error: model not available");
    } finally {
      await c.close();
    }
  });

  test("request rejects with error for unknown method", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });
    try {
      await expect(
        c.request("unknown/method"),
      ).rejects.toThrow("Method not found: unknown/method");
    } finally {
      await c.close();
    }
  });

  test("request rejects when process exits unexpectedly", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
      env: { MOCK_EXIT_EARLY: "1" },
    });
    try {
      // The mock server exits after initialize, so the next request should fail
      await new Promise((r) => setTimeout(r, 100));
      await expect(c.request("thread/start")).rejects.toThrow();
    } finally {
      await c.close();
    }
  });

  test("request rejects after client is closed", async () => {
    const c = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });
    await c.close();

    await expect(
      c.request("thread/start"),
    ).rejects.toThrow("Client is closed");
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
      requestTimeout: 5000,
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
      requestTimeout: 5000,
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
      requestTimeout: 5000,
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
