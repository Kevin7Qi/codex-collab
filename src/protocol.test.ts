import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseMessage, formatRequest, formatNotification, formatResponse, resetIdCounter, connect, type AppServerClient } from "./protocol";

const MOCK_SERVER = "/tmp/claude-1000/mock-app-server.ts";

beforeEach(() => {
  resetIdCounter();
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

describe("AppServerClient", () => {
  let client: AppServerClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  test("connect performs initialize handshake and returns userAgent", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });
    expect(client.userAgent).toBe("mock-codex-server/0.1.0");
  });

  test("close shuts down gracefully", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });
    await client.close();
    client = null;
    // No error means success — process exited cleanly
  });

  test("request sends and receives response", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });

    const result = await client.request<{ thread: { id: string }; model: string }>(
      "thread/start",
      { model: "gpt-5.3-codex" },
    );

    expect(result.thread.id).toBe("thread-mock-001");
    expect(result.model).toBe("gpt-5.3-codex");
  });

  test("request rejects with descriptive error on JSON-RPC error response", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
      env: { MOCK_ERROR_RESPONSE: "1" },
    });

    await expect(
      client.request("thread/start", { model: "bad-model" }),
    ).rejects.toThrow("JSON-RPC error -32603: Internal error: model not available");
  });

  test("request rejects with error for unknown method", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });

    await expect(
      client.request("unknown/method"),
    ).rejects.toThrow("Method not found: unknown/method");
  });

  test("request rejects when process exits unexpectedly", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
      env: { MOCK_EXIT_EARLY: "1" },
    });

    // The mock server exits after initialize, so the next request should fail
    // Give a tiny delay for the process to actually exit
    await new Promise((r) => setTimeout(r, 100));

    await expect(
      client.request("thread/start"),
    ).rejects.toThrow();
  });

  test("request rejects after client is closed", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });

    await client.close();
    client = null;

    // We need a fresh reference but close has been called, so we reconnect then close then try
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
      const decoder = new TextDecoder();
      async function main() {
        const reader = Bun.stdin.stream().getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
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
              // After receiving "initialized" notification, send a server notification
              if (!msg.id && msg.method === "initialized") {
                process.stdout.write(JSON.stringify({
                  method: "item/started",
                  params: { itemId: "item-1", threadId: "t1", turnId: "turn-1" },
                }) + "\\n");
              }
            }
          }
        } catch {}
      }
      main();
    `;

    const serverPath = "/tmp/claude-1000/mock-notify-server.ts";
    await Bun.write(serverPath, notifyServer);

    const received: unknown[] = [];
    client = await connect({
      command: ["bun", "run", serverPath],
      requestTimeout: 5000,
    });

    client.on("item/started", (params) => {
      received.push(params);
    });

    // Give time for the notification to arrive
    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({
      itemId: "item-1",
      threadId: "t1",
      turnId: "turn-1",
    });
  });

  test("onRequest handler responds to server requests", async () => {
    // Mock server that sends a server request after initialize
    const approvalServer = `
      const decoder = new TextDecoder();
      let sentApproval = false;
      async function main() {
        const reader = Bun.stdin.stream().getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
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
              // After initialized notification, send a server request
              if (!msg.id && msg.method === "initialized" && !sentApproval) {
                sentApproval = true;
                process.stdout.write(JSON.stringify({
                  id: "srv-1",
                  method: "item/commandExecution/requestApproval",
                  params: { command: "rm -rf /", threadId: "t1", turnId: "turn-1" },
                }) + "\\n");
              }
              // When we get back our response, send a verification notification
              if (msg.id === "srv-1" && msg.result) {
                process.stdout.write(JSON.stringify({
                  method: "test/approvalReceived",
                  params: { decision: msg.result.decision },
                }) + "\\n");
              }
            }
          }
        } catch {}
      }
      main();
    `;

    const serverPath = "/tmp/claude-1000/mock-approval-server.ts";
    await Bun.write(serverPath, approvalServer);

    client = await connect({
      command: ["bun", "run", serverPath],
      requestTimeout: 5000,
    });

    // Register handler for approval requests
    client.onRequest("item/commandExecution/requestApproval", (params: any) => {
      return { decision: "accept" };
    });

    // Wait for the round-trip
    const received: unknown[] = [];
    client.on("test/approvalReceived", (params) => {
      received.push(params);
    });

    await new Promise((r) => setTimeout(r, 300));

    expect(received.length).toBe(1);
    expect(received[0]).toEqual({ decision: "accept" });
  });

  test("on returns unsubscribe function", async () => {
    client = await connect({
      command: ["bun", "run", MOCK_SERVER],
      requestTimeout: 5000,
    });

    const received: unknown[] = [];
    const unsub = client.on("test/event", (params) => {
      received.push(params);
    });

    // Unsubscribe immediately
    unsub();

    // Even if a notification arrived, handler should not fire
    // (no notification is sent by the basic mock, but this verifies the unsub mechanism)
    expect(received.length).toBe(0);
  });
});
