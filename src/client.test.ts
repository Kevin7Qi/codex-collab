import { describe, expect, test } from "bun:test";
import { formatNotification, formatResponse, parseMessage } from "./client";

describe("formatNotification", () => {
  test("produces newline-terminated JSON", () => {
    const msg = formatNotification("initialized");
    expect(msg).toBe('{"method":"initialized"}\n');
  });

  test("includes params when provided", () => {
    const msg = formatNotification("turn/start", { threadId: "t1" });
    const parsed = JSON.parse(msg);
    expect(parsed.method).toBe("turn/start");
    expect(parsed.params).toEqual({ threadId: "t1" });
  });
});

describe("formatResponse", () => {
  test("produces newline-terminated JSON with id and result", () => {
    const msg = formatResponse(1, { ok: true });
    const parsed = JSON.parse(msg);
    expect(parsed.id).toBe(1);
    expect(parsed.result).toEqual({ ok: true });
  });
});

describe("parseMessage", () => {
  test("parses a notification", () => {
    const msg = parseMessage('{"method":"turn/completed","params":{}}');
    expect(msg).toBeTruthy();
    expect((msg as any).method).toBe("turn/completed");
  });

  test("parses a response", () => {
    const msg = parseMessage('{"id":1,"result":{"ok":true}}');
    expect(msg).toBeTruthy();
    expect((msg as any).id).toBe(1);
  });

  test("returns null for garbage", () => {
    expect(parseMessage("not json")).toBeNull();
  });

  test("returns null for empty object", () => {
    expect(parseMessage("{}")).toBeNull();
  });
});
