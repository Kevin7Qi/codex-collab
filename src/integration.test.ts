// src/integration.test.ts — Integration smoke tests against a real codex app-server process
// Skipped unless RUN_INTEGRATION=1 is set (requires codex CLI on PATH and valid credentials).

import { describe, expect, test } from "bun:test";
import { connect } from "./protocol";

const runIntegration =
  process.env.RUN_INTEGRATION === "1" &&
  Bun.spawnSync([process.platform === "win32" ? "where" : "which", "codex"]).exitCode === 0;

describe.skipIf(!runIntegration)("integration", () => {
  test("connect and list models", async () => {
    const client = await connect();
    try {
      const resp = await client.request<{ data: Array<{ id: string }> }>("model/list", {});
      expect(resp.data.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("start thread and read it back", async () => {
    const client = await connect();
    try {
      const startResp = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: process.cwd(),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      expect(startResp.thread.id).toBeTruthy();

      // Verify we can read the thread back from the same connection
      const readResp = await client.request<{ thread: { id: string } }>("thread/read", {
        threadId: startResp.thread.id,
        includeTurns: false,
      });
      expect(readResp.thread.id).toBe(startResp.thread.id);

      // Cleanup: archive the thread (may fail if not yet persisted; that's OK)
      try {
        await client.request("thread/archive", { threadId: startResp.thread.id });
      } catch {
        // Not yet persisted to global store — acceptable
      }
    } finally {
      await client.close();
    }
  }, 30_000);
});
