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

  test("an error carrying a code is forwarded with that code", async () => {
    const { ep, writes } = endpoint();
    ep.onAnyRequest((method) => { const e = new Error(`Method not found: ${method}`) as Error & { code: number }; e.code = -32601; throw e; });
    ep.feed(JSON.stringify({ id: 4, method: "x/y", params: {} }) + "\n");
    await tick();
    expect(writes).toEqual([{ id: 4, error: { code: -32601, message: "Method not found: x/y" } }]);
  });
});
