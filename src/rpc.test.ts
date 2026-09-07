// Tests for rpc.ts — the JSON-RPC endpoint shared by every transport.
import { describe, expect, test } from "bun:test";
import { createRpcEndpoint, NO_RESPONSE } from "./rpc";

function endpoint() {
  const writes: Array<Record<string, unknown>> = [];
  const ep = createRpcEndpoint({
    label: "test",
    requestTimeout: 1000,
    send: (data) => { for (const line of data.split("\n")) if (line.trim()) writes.push(JSON.parse(line)); },
    downReason: () => null,
    overflowReason: "overflow",
    onOverflow: () => {},
    writeFailedPrefix: "write failed: ",
  });
  return { ep, writes };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("server-sent requests", () => {
  test("an unregistered method is answered method-not-found by default", async () => {
    const { ep, writes } = endpoint();
    ep.feed(JSON.stringify({ id: 1, method: "item/tool/requestUserInput", params: { threadId: "t" } }) + "\n");
    await tick();
    expect(writes).toEqual([{ id: 1, error: { code: -32601, message: "Method not found: item/tool/requestUserInput" } }]);
  });

  test("the catch-all handler decides for unregistered methods, and may stay silent", async () => {
    const { ep, writes } = endpoint();
    const seen: string[] = [];
    ep.onAnyRequest((method, params) => {
      seen.push(method);
      return (params as { threadId: string }).threadId === "mine" ? { ok: true } : NO_RESPONSE;
    });
    ep.feed(JSON.stringify({ id: 1, method: "mcpServer/elicitation/request", params: { threadId: "theirs" } }) + "\n");
    ep.feed(JSON.stringify({ id: 2, method: "item/permissions/requestApproval", params: { threadId: "mine" } }) + "\n");
    await tick();
    expect(seen).toEqual(["mcpServer/elicitation/request", "item/permissions/requestApproval"]);
    expect(writes).toEqual([{ id: 2, result: { ok: true } }]);
  });

  test("a specific handler wins over the catch-all, and NO_RESPONSE from it writes nothing", async () => {
    const { ep, writes } = endpoint();
    ep.onAnyRequest(() => ({ fallback: true }));
    ep.onRequest("item/commandExecution/requestApproval", () => NO_RESPONSE);
    ep.feed(JSON.stringify({ id: 3, method: "item/commandExecution/requestApproval", params: {} }) + "\n");
    await tick();
    expect(writes).toEqual([]);
  });

  test("a request re-sent while its first delivery is still being handled is not handled again", async () => {
    const { ep, writes } = endpoint();
    let handled = 0;
    let answer!: (v: unknown) => void;
    ep.onRequest("item/tool/call", () => { handled++; return new Promise((r) => { answer = r; }); });
    const req = JSON.stringify({ id: "call-7", method: "item/tool/call", params: { threadId: "t" } }) + "\n";
    ep.feed(req);
    await tick();
    ep.feed(req); // the server re-sends its pending request (a rejoin of the thread, say)
    await tick();
    expect(handled).toBe(1);
    answer({ done: true });
    await tick();
    expect(writes).toEqual([{ id: "call-7", result: { done: true } }]);
  });

  test("disposing catch-alls out of order never resurrects a released one", async () => {
    const { ep, writes } = endpoint();
    ep.onAnyRequest(() => ({ guard: true }));
    const disposeB = ep.onAnyRequest(() => ({ b: true }));
    const disposeC = ep.onAnyRequest(() => ({ c: true }));
    disposeB(); // released first, while C still stands
    ep.feed(JSON.stringify({ id: 7, method: "x/y", params: {} }) + "\n");
    await tick();
    disposeC();
    ep.feed(JSON.stringify({ id: 8, method: "x/y", params: {} }) + "\n");
    await tick();
    expect(writes).toEqual([{ id: 7, result: { c: true } }, { id: 8, result: { guard: true } }]);
  });

  test("a handler is told the server's id for the request", async () => {
    const { ep } = endpoint();
    const ids: unknown[] = [];
    ep.onRequest("item/tool/call", (_params, id) => { ids.push(id); return NO_RESPONSE; });
    ep.onAnyRequest((_m, _p, id) => { ids.push(id); return NO_RESPONSE; });
    ep.feed(JSON.stringify({ id: "call-1", method: "item/tool/call", params: {} }) + "\n");
    ep.feed(JSON.stringify({ id: 9, method: "x/y", params: {} }) + "\n");
    await tick();
    expect(ids).toEqual(["call-1", 9]);
  });

  test("disposing a catch-all restores the one that stood before it", async () => {
    const { ep, writes } = endpoint();
    ep.onAnyRequest(() => NO_RESPONSE); // the connection's own guard
    const dispose = ep.onAnyRequest(() => ({ turn: true }));
    ep.feed(JSON.stringify({ id: 5, method: "x/y", params: {} }) + "\n");
    await tick();
    dispose();
    ep.feed(JSON.stringify({ id: 6, method: "x/y", params: {} }) + "\n");
    await tick();
    // The second request meets the guard again, not method-not-found.
    expect(writes).toEqual([{ id: 5, result: { turn: true } }]);
  });

  test("an error carrying a code is forwarded with that code", async () => {
    const { ep, writes } = endpoint();
    ep.onAnyRequest((method) => { const e = new Error(`Method not found: ${method}`) as Error & { code: number }; e.code = -32601; throw e; });
    ep.feed(JSON.stringify({ id: 4, method: "x/y", params: {} }) + "\n");
    await tick();
    expect(writes).toEqual([{ id: 4, error: { code: -32601, message: "Method not found: x/y" } }]);
  });
});
