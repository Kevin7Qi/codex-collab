// Contract tests — pin the UNDOCUMENTED vendor interfaces the native peer
// path rides on, so upstream drift breaks loudly here instead of silently
// muting the peer in production.
//
// Opt-in: `CODEX_COLLAB_CONTRACTS=1 bun test contracts/` — requires the real
// `codex` CLI (Codex contracts spend a few trivial model turns) and, for the
// registry contracts, the real `claude` CLI. The registry contracts write
// probe entries into the REAL ~/.claude/sessions and remove them in cleanup.
//
// What is pinned, and where it came from (see docs/interfaces.md):
//   codex: thread/start accepts dynamicTools + developerInstructions;
//          thread/inject_items accepts peer-authored agent_message items;
//          one connection runs turns on two threads CONCURRENTLY;
//          item/tool/call delivers plaintext arguments and returns results.
//   claude: a registry entry lists only while its pid names a live process
//          whose procStart matches exactly; socket path is NOT validated.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { connectDirect } from "../src/client";
import { PEER_DYNAMIC_TOOLS, PEER_DEVELOPER_INSTRUCTIONS, procStartOf, buildRegistryEntry } from "../src/peer";

const ENABLED = process.env.CODEX_COLLAB_CONTRACTS === "1";

describe.skipIf(!ENABLED)("codex app-server contracts", () => {
  test("thread/start accepts dynamicTools + developerInstructions; inject_items accepts a peer-authored agent_message", async () => {
    const client = await connectDirect();
    let threadId: string | null = null;
    try {
      const start = await client.request("thread/start", {
        cwd: process.cwd(),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        developerInstructions: PEER_DEVELOPER_INSTRUCTIONS,
        dynamicTools: PEER_DYNAMIC_TOOLS,
      }) as { thread: { id: string } };
      threadId = start.thread.id;
      expect(threadId).toBeTruthy();

      // The injection contract: peer-authored items append without error.
      await client.request("thread/inject_items", {
        threadId,
        items: [{
          type: "agent_message",
          author: "/root/claude",
          recipient: "/root",
          content: [{ type: "input_text", text: "[contract-test] peer injection probe" }],
        }],
      });
    } finally {
      if (threadId) await client.request("thread/delete", { threadId }).catch(() => undefined);
      await client.close();
    }
  }, 60_000);

  test("one connection runs turns on two threads concurrently", async () => {
    const client = await connectDirect();
    const ids: string[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const start = await client.request("thread/start", { cwd: process.cwd() }) as { thread: { id: string } };
        ids.push(start.thread.id);
      }
      const [t1, t2] = ids;
      const events: string[] = [];
      const done = new Map<string, () => void>();
      const completed = ids.map((id) => new Promise<void>((r) => done.set(id, r)));
      client.on("turn/started", (p: unknown) => {
        const tid = (p as { threadId?: string })?.threadId;
        if (tid) events.push(`start:${tid}`);
      });
      client.on("turn/completed", (p: unknown) => {
        const tid = (p as { threadId?: string })?.threadId;
        if (tid) { events.push(`done:${tid}`); done.get(tid)?.(); }
      });
      await Promise.all([
        client.request("turn/start", { threadId: t1, input: [{ type: "text", text: "Reply with the word ONE and stop. No tools." }] }),
        client.request("turn/start", { threadId: t2, input: [{ type: "text", text: "Reply with the word TWO and stop. No tools." }] }),
      ]);
      await Promise.race([
        Promise.all(completed),
        new Promise((_, rej) => setTimeout(() => rej(new Error("turns did not complete")), 150_000)),
      ]);
      // Overlap: the later starter began before the earlier finisher ended.
      const firstDone = events.findIndex((e) => e.startsWith("done:"));
      const starts = events.filter((e, i) => e.startsWith("start:") && i < firstDone).length;
      expect(starts).toBe(2);
    } finally {
      for (const id of ids) await client.request("thread/delete", { threadId: id }).catch(() => undefined);
      await client.close();
    }
  }, 180_000);

  test("item/tool/call delivers plaintext arguments and returns the result into the turn", async () => {
    const client = await connectDirect();
    let threadId: string | null = null;
    const MARK = "CONTRACT-ARG-1187";
    const ANSWER = "CONTRACT-ANSWER-2291";
    try {
      let sawPlaintext = false;
      client.onRequest("item/tool/call", (params: unknown) => {
        const p = params as { arguments?: unknown };
        sawPlaintext = JSON.stringify(p?.arguments ?? "").includes(MARK);
        return { contentItems: [{ type: "inputText", text: ANSWER }], success: true };
      });
      const start = await client.request("thread/start", {
        cwd: process.cwd(),
        dynamicTools: PEER_DYNAMIC_TOOLS,
      }) as { thread: { id: string } };
      threadId = start.thread.id;

      let finalText = "";
      client.on("item/completed", (p: unknown) => {
        const item = (p as { item?: { type?: string; text?: string } })?.item;
        if (item?.type === "agentMessage" && item.text) finalText += item.text;
      });
      const turnDone = new Promise<void>((r) => {
        client.on("turn/completed", () => r());
        client.on("turn/failed", () => r());
      });
      await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: `Call collab.consult with the question "${MARK}?" then repeat the answer you receive verbatim and stop.` }],
      });
      await Promise.race([turnDone, new Promise((r) => setTimeout(r, 150_000))]);

      expect(sawPlaintext).toBe(true);
      expect(finalText).toContain(ANSWER);
    } finally {
      if (threadId) await client.request("thread/delete", { threadId }).catch(() => undefined);
      await client.close();
    }
  }, 180_000);
});

describe.skipIf(!ENABLED)("claude session-registry contracts", () => {
  const registry = join(homedir(), ".claude", "sessions");

  function listedNames(): string[] {
    const out = execFileSync("claude", ["agents", "--json"]).toString();
    const parsed = JSON.parse(out);
    const rows: Array<{ name?: string }> = Array.isArray(parsed) ? parsed : parsed.agents ?? [];
    return rows.map((r) => r.name ?? "");
  }

  // Deliberately NOT pinned: whether the filename pid must equal the content
  // pid. 2.1.226 rejected a filename that borrowed a different *live* pid;
  // 2.1.229 lists it — the validator checks the two pids independently rather
  // than binding them. Nothing here rides on that binding: our entries are
  // always written under their own holder's pid, which satisfies the strict
  // rule and the relaxed one alike. Asserting it either way would only break
  // this file the next time upstream moves without touching the peer.
  test("a live pid with an exact procStart lists; a dead pid or a wrong procStart does not; socket path is not validated", async () => {
    // Two holders: one backs the entry that must list, the other an entry
    // that is live and well-named but carries the wrong procStart.
    const holder = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    const impostor = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    if (!holder.pid || !impostor.pid) throw new Error("holder spawn failed");
    const cleanup: string[] = [];
    try {
      await new Promise((r) => setTimeout(r, 300));
      const procStart = procStartOf(holder.pid);
      const mkEntry = (pid: number, name: string, ps: typeof procStart) => buildRegistryEntry({
        pid,
        cwd: process.cwd(),
        name,
        socketPath: `/tmp/does-not-exist-${pid}.sock`, // never validated
        version: "2.1.229",
        procStart: ps,
        sessionId: "00000000-0000-4000-8000-000000000001",
      });
      const put = (file: string, entry: unknown) => {
        const p = join(registry, file);
        writeFileSync(p, JSON.stringify(entry));
        cleanup.push(p);
      };

      // Lists: live pid, exact procStart — and a socket path that does not
      // exist, which is what lets one process serve many holder-backed peers.
      put(`${holder.pid}.json`, mkEntry(holder.pid, "contract-valid", procStart));

      // Rejected: the filename names a pid that is not running. This is what
      // de-lists a peer automatically when its holder dies.
      put(`4900801.json`, mkEntry(4900801, "contract-deadpid", procStart));

      // Rejected: live pid, but procStart does not match it. Pins the exact
      // `ps -o lstart=` string comparison our own procStartOf reproduces —
      // a recycled pid must not resurrect a dead session's entry.
      put(`${impostor.pid}.json`, mkEntry(impostor.pid, "contract-badprocstart", "Sat Aug  8 10:47:21 2026"));

      const names = listedNames();
      expect(names).toContain("contract-valid");
      expect(names).not.toContain("contract-deadpid");
      expect(names).not.toContain("contract-badprocstart");
    } finally {
      for (const f of cleanup) { try { unlinkSync(f); } catch { /* gone */ } }
      holder.kill();
      impostor.kill();
    }
  }, 30_000);
});
