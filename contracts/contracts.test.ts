// Contract tests — pin the UNDOCUMENTED vendor interfaces the native peer
// path rides on, so upstream drift breaks loudly here instead of silently
// muting the peer in production.
//
// Opt-in: `CODEX_COLLAB_CONTRACTS=1 bun test contracts/` — requires the real
// `codex` CLI (Codex contracts spend a few trivial model turns) and, for the
// Claude contracts, the real `claude` CLI. The registry contracts write probe
// entries into the REAL ~/.claude/sessions and remove them in cleanup; the
// background-session contracts start two background sessions in the current
// folder (which Claude Code must trust) — one trivial Sonnet turn at low
// effort, and one on a model that does not exist, which no model runs — and
// stop, remove and delete them afterwards, transcripts included.
//
// What is pinned, and where it came from (see docs/interfaces.md):
//   codex: thread/start accepts dynamicTools + developerInstructions;
//          thread/inject_items accepts peer-authored agent_message items;
//          one connection runs turns on two threads CONCURRENTLY;
//          item/tool/call delivers plaintext arguments and returns results.
//   claude: a registry entry lists only while its pid names a live process
//          whose procStart matches exactly; socket path is NOT validated.
//          A background session's entry is `kind: "bg"` with its `jobId`,
//          `procStart`, `sessionId` and a `status` of busy/idle/waiting/shell;
//          its job's state.json names the same session, and a finished turn
//          leaves it `state: "done"`, `tempo` not active, and `inFlight`
//          counts (tasks, queued, kinds, drainableMonitors) of no work;
//          `claude stop` retires it with no signal needed. Its transcript's
//          replies carry `message.model` (an alias resolved to a version)
//          and the `effort` sent. An API error is a reply with
//          `isApiErrorMessage`, `apiErrorStatus` and `error` (the reason),
//          made up by Claude Code (`message.model: "<synthetic>"`), and its
//          job ends `state: "failed"`.

import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { connectDirect } from "../src/client";
import { modelAliasTargets } from "../src/config";
import { fetchAllPages, resolveModelDefaults } from "../src/models";
import type { AppServerClient } from "../src/client";
import type { Model } from "../src/types";
import { PEER_DYNAMIC_TOOLS, PEER_DEVELOPER_INSTRUCTIONS } from "../src/peer";
import { SPAWN_PERMISSION_MODE, SPAWN_SETTINGS, jobHasWorkInFlight, jobSessionId, jobsDir, listClaudeSessions, parseBackgroundId, sessionStatusNow, spawnEnv, stopSpawnedSession } from "../src/claude-sessions";
import { ranOn, transcriptPath, turnEndedOnError } from "../src/claude-transcript";
import { procStartOf, buildRegistryEntry, sniffRegistryVersion, sessionsDir } from "../src/claude-registry";

const ENABLED = process.env.CODEX_COLLAB_CONTRACTS === "1";

/** The model a contract turn runs on: the one codex-collab would pick for a
 *  run of its own. Left to the server, a turn runs on the default in the
 *  user's Codex config, and one this account cannot use fails every turn for
 *  a reason that has nothing to do with the contract. */
async function contractModel(client: AppServerClient): Promise<string | undefined> {
  return (await resolveModelDefaults(client, {}))?.model;
}

describe.skipIf(!ENABLED)("codex app-server contracts", () => {
  test("every MODEL_ALIASES target is a model the server still lists", async () => {
    const client = await connectDirect();
    try {
      const models = await fetchAllPages<Model>(client, "model/list", { includeHidden: true });
      const ids = new Set(models.map((m) => m.id));
      for (const [alias, target] of Object.entries(modelAliasTargets())) {
        // A retired target would make `-m <alias>` fail on every turn, and
        // no unit test can notice — only the live list can.
        expect(ids.has(target), `alias "${alias}" points at "${target}", which model/list no longer returns`).toBe(true);
      }
    } finally {
      await client.close();
    }
  }, 60_000);


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
      const model = await contractModel(client);
      for (let i = 0; i < 2; i++) {
        const start = await client.request("thread/start", { cwd: process.cwd(), model }) as { thread: { id: string } };
        ids.push(start.thread.id);
      }
      const [t1, t2] = ids;
      const events: string[] = [];
      const statuses: unknown[] = [];
      const done = new Map<string, () => void>();
      const completed = ids.map((id) => new Promise<void>((r) => done.set(id, r)));
      client.on("turn/started", (p: unknown) => {
        const tid = (p as { threadId?: string })?.threadId;
        if (tid) events.push(`start:${tid}`);
      });
      client.on("turn/completed", (p: unknown) => {
        const tid = (p as { threadId?: string })?.threadId;
        if (tid) {
          events.push(`done:${tid}`);
          statuses.push((p as { turn?: { status?: unknown } })?.turn?.status);
          done.get(tid)?.();
        }
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
      // A refused turn also "completes"; only one that ran proves anything.
      expect(statuses).toEqual(["completed", "completed"]);
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
        model: await contractModel(client),
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

const registry = join(homedir(), ".claude", "sessions");

/**
 * Why the machine cannot run the registry probe at all, or null if it can.
 *
 * This gates on being ABLE to probe — deliberately not on `peerCapability()`.
 * That function reports whether messaging sockets are bound, which these
 * contracts exist to prove is irrelevant to listing; and it answers
 * "inconclusive → supported" when no sibling session is live, which is the
 * normal state for an isolated run. Gating on it would skip for the wrong
 * reason and pass for the wrong reason.
 *
 * The split that matters: an environment that cannot run `claude agents
 * --json` skips, but anything that RAN and parsed is a contract result and
 * must fail loudly. Upstream removing a guarantee has to stay noisy — that
 * is the whole point of this file.
 *
 * Called only when ENABLED (the `||` below short-circuits), so a default
 * `bun test` never spawns `claude`.
 */
function registryProbeBlocker(): string | null {
  // procStartOf shells out to POSIX `ps`; peer.test.ts skips win32 for the
  // same reason, mirroring peerCapability's own gate.
  if (process.platform === "win32") return "windows (procStart reads POSIX ps)";
  if (!existsSync(registry)) return "no Claude session registry";
  try {
    execFileSync("claude", ["agents", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "`claude agents --json` unavailable (binary missing or too old)";
  }
  return null;
}

const registryBlocked = ENABLED ? registryProbeBlocker() : null;
if (registryBlocked) console.log(`skipping claude session-registry contracts: ${registryBlocked}`);

describe.skipIf(!ENABLED || registryBlocked !== null)("claude session-registry contracts", () => {
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
        // Also never validated — probed 2026-08-13, an entry declaring
        // "0.0.1", "9.9.9" or "not-a-version" lists exactly the same. The
        // version floor is enforced by an older Claude Code declining to bind
        // a messaging socket for its OWN session, not by the registry scan
        // filtering on this field. Sniffed rather than written literal so
        // nothing here reads as a claim about the version under test.
        version: sniffRegistryVersion(),
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

describe.skipIf(!ENABLED || registryBlocked !== null)("claude background-session contracts", () => {
  /** Start a background session as codex-collab does (`spawnClaudeSession`),
   *  on `model`, with one short instruction. Its job id. */
  function startBackground(name: string, model: string, effort?: string): string {
    const out = execFileSync(
      "claude",
      ["--bg", "-n", name, "--permission-mode", SPAWN_PERMISSION_MODE, "--settings", JSON.stringify(SPAWN_SETTINGS), "--model", model, ...(effort ? ["--effort", effort] : []), "Reply with the word OK and nothing else. Use no tools."],
      { cwd: process.cwd(), env: spawnEnv(), encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const id = parseBackgroundId(out);
    if (!id) throw new Error(`no job id in what \`claude --bg\` printed: ${out}`);
    return id;
  }

  /** Leave nothing of a probe behind: the job, and its transcript. */
  function removeJob(id: string, sessionId: string | null): void {
    for (const verb of ["stop", "rm"]) {
      try { execFileSync("claude", [verb, id], { env: spawnEnv(), stdio: "ignore", timeout: 15_000 }); } catch { /* stopped, or gone */ }
    }
    const transcript = sessionId ? transcriptPath(sessionId) : null;
    if (transcript) {
      rmSync(transcript, { force: true });
      rmSync(transcript.replace(/\.jsonl$/, ""), { recursive: true, force: true });
    }
  }

  function jobState(id: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(join(jobsDir(), id, "state.json"), "utf-8")); } catch { return null; }
  }

  function registryEntryOf(id: string): Record<string, unknown> | null {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
        if (entry?.jobId === id) return entry;
      } catch { /* half-written, or not an entry */ }
    }
    return null;
  }

  async function until<T>(look: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const seen = look();
      if (seen) return seen;
      if (Date.now() > end) throw new Error(`waited ${ms / 1000}s for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  test("a background session's registry entry, job state and transcript say what codex-collab reads of them", async () => {
    const name = `contract-bg-${process.pid}`;
    const id = startBackground(name, "sonnet", "low");
    let sessionId: string | null = null;
    try {
      // The registry entry: a background session, naming its job, with what
      // identifies its process.
      const entry = await until(() => registryEntryOf(id), 30_000, "its registry entry");
      expect(entry.kind).toBe("bg");
      expect(typeof entry.pid).toBe("number");
      expect(typeof entry.procStart).toBe("string");
      expect(typeof entry.sessionId).toBe("string");
      sessionId = entry.sessionId as string;
      const pid = entry.pid as number;
      // The job's state names the same session.
      expect(jobSessionId(id)).toBe(sessionId);
      expect(listClaudeSessions({ cwd: process.cwd(), all: true }).find((s) => s.pid === pid)).toEqual(expect.objectContaining({ kind: "bg", jobId: id, sessionId }));

      // Every status it reports is one codex-collab knows, and the turn ends
      // idle, its job done, with nothing counted in flight.
      const statuses = new Set<string>();
      await until(() => {
        const status = sessionStatusNow(pid);
        if (status) statuses.add(status);
        return status === "idle" && jobState(id)?.state === "done";
      }, 90_000, "the turn to end");
      for (const status of statuses) expect(["busy", "idle", "waiting", "shell"]).toContain(status);
      const job = jobState(id)!;
      expect(job.tempo).not.toBe("active");
      expect(job.inFlight).toEqual({ tasks: expect.any(Number), queued: expect.any(Number), kinds: expect.any(Array), drainableMonitors: expect.any(Number) });
      expect(jobHasWorkInFlight(id)).toBe(false);

      // The transcript: what the reply ran on, the alias resolved to a
      // version, and the effort it was sent with.
      const ran = ranOn(sessionId);
      expect(ran?.model).toMatch(/^claude-sonnet-/);
      expect(ran?.effort).toBe("low");

      // `claude stop` retires it: codex-collab's stop sees it gone, with no
      // signal needed.
      const stopped = await stopSpawnedSession({ id, pid, name, startedAt: new Date().toISOString(), lingerSec: 60, procStart: entry.procStart as string, sessionId });
      expect(stopped).toEqual({ gone: true, signalled: false });
    } finally {
      removeJob(id, sessionId);
    }
  }, 180_000);

  test("an API error is in the transcript as codex-collab reads it, and is not taken for a model the session ran on", async () => {
    const id = startBackground(`contract-error-${process.pid}`, "claude-no-such-model-0-0");
    let sessionId: string | null = null;
    try {
      await until(() => jobState(id)?.state === "failed", 90_000, "the job to fail");
      sessionId = jobSessionId(id);
      expect(sessionId).not.toBeNull();
      // Settled: nothing it holds is work.
      expect(jobState(id)?.tempo).not.toBe("active");
      expect(jobHasWorkInFlight(id)).toBe(false);
      // The turn ended on the error, with the API's status and reason.
      expect(turnEndedOnError(sessionId)).toEqual(expect.objectContaining({ status: 404, reason: "model_not_found" }));
      // Claude Code made that reply up; it names no model the session ran on.
      expect(ranOn(sessionId)).toBeNull();
    } finally {
      removeJob(id, sessionId);
    }
  }, 150_000);
});
