// src/integration.test.ts — Integration smoke tests against a real codex app-server process
// These tests are skipped if the codex CLI is not available on PATH.

import { describe, expect, test } from "bun:test";
import { connect } from "./protocol";

const hasCodex = Bun.spawnSync(["which", "codex"]).exitCode === 0;

describe.skipIf(!hasCodex)("integration", () => {
  test("connect and list models", async () => {
    const client = await connect();
    try {
      const resp = await client.request<{ data: Array<{ modelId: string }> }>("model/list", {});
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
      });
      expect(startResp.thread.id).toBeTruthy();

      // Verify we can read the thread back from the same connection
      const readResp = await client.request<{ thread: { id: string } }>("thread/read", {
        threadId: startResp.thread.id,
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
