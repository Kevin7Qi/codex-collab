import { describe, expect, test, beforeEach } from "bun:test";
import { parseMessage, formatRequest, formatNotification, formatResponse, resetIdCounter } from "./protocol";

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
});
