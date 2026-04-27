import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  generateShortId,
  loadThreadIndex,
  saveThreadIndex,
  registerThread,
  resolveThreadId,
  findShortId,
  updateThreadMeta,
  removeThread,
  generateRunId,
  createRun,
  loadRun,
  updateRun,
  listRuns,
  listRunsForThread,
  getLatestRun,
  pruneRuns,
  getResumeCandidate,
  migrateGlobalState,
} from "./threads";
import type { RunRecord, ThreadMapping } from "./types";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `codex-collab-test-threads-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ─── generateShortId ───────────────────────────────────────────────────────

describe("generateShortId", () => {
  test("returns 8-char hex string", () => {
    const id = generateShortId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateShortId()));
    expect(ids.size).toBe(100);
  });
});

// ─── Thread Index ──────────────────────────────────────────────────────────

describe("thread index", () => {
  test("load returns empty object for missing file", () => {
    const index = loadThreadIndex(testDir);
    expect(index).toEqual({});
  });

  test("save and load round-trips", () => {
    const index = {
      abc12345: {
        threadId: "thr_long_id",
        name: null,
        model: "gpt-5",
        cwd: "/proj",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    };
    saveThreadIndex(testDir, index);
    const loaded = loadThreadIndex(testDir);
    expect(loaded.abc12345.threadId).toBe("thr_long_id");
    expect(loaded.abc12345.model).toBe("gpt-5");
  });

  test("loadThreadIndex throws on corrupt JSON instead of silently dropping mapping", () => {
    // Write a malformed file directly to threads.json
    writeFileSync(join(testDir, "threads.json"), "{ bro\nken json", { mode: 0o600 });
    expect(() => loadThreadIndex(testDir)).toThrow(/corrupted/i);
    // Original file is moved aside, not deleted — user can inspect
    const corruptBackup = readdirSync(testDir).find(f => f.startsWith("threads.json.corrupt."));
    expect(corruptBackup).toBeDefined();
  });

  test("loadThreadIndex throws on non-object structure (array)", () => {
    writeFileSync(join(testDir, "threads.json"), JSON.stringify(["not", "an", "object"]));
    expect(() => loadThreadIndex(testDir)).toThrow(/invalid structure/i);
  });

  test("registerThread adds to index and returns shortId", () => {
    const shortId = registerThread(testDir, "thr_new_id", { model: "gpt-5", cwd: "/proj" });
    expect(shortId).toMatch(/^[0-9a-f]{8}$/);
    const index = loadThreadIndex(testDir);
    expect(index[shortId].threadId).toBe("thr_new_id");
    expect(index[shortId].model).toBe("gpt-5");
    expect(index[shortId].cwd).toBe("/proj");
    expect(index[shortId].name).toBeNull();
  });

  test("registerThread regenerates on collision", () => {
    // Seed an existing entry
    saveThreadIndex(testDir, {
      deadbeef: {
        threadId: "thr_existing",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const shortId = registerThread(testDir, "thr_new");
    expect(shortId).not.toBe("deadbeef");
    const index = loadThreadIndex(testDir);
    expect(Object.keys(index).length).toBe(2);
    expect(index.deadbeef.threadId).toBe("thr_existing");
  });

  test("resolveThreadId — exact short ID match", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_long_id",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = resolveThreadId(testDir, "abc12345");
    expect(result).toEqual({ shortId: "abc12345", threadId: "thr_long_id" });
  });

  test("resolveThreadId — prefix match", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_long_id",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = resolveThreadId(testDir, "abc1");
    expect(result).toEqual({ shortId: "abc12345", threadId: "thr_long_id" });
  });

  test("resolveThreadId — ambiguous prefix throws", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_1",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      abc12399: {
        threadId: "thr_2",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(() => resolveThreadId(testDir, "abc12")).toThrow(/ambiguous/i);
  });

  test("resolveThreadId — full threadId lookup", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_full_thread_id_here",
        name: "my thread",
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = resolveThreadId(testDir, "thr_full_thread_id_here");
    expect(result).toEqual({ shortId: "abc12345", threadId: "thr_full_thread_id_here" });
  });

  test("resolveThreadId — UUID-style threadId lookup", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "019d680c-7b23-7f22-ab99-6584214a2bed",
        name: "uuid thread",
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const result = resolveThreadId(testDir, "019d680c-7b23-7f22-ab99-6584214a2bed");
    expect(result).toEqual({ shortId: "abc12345", threadId: "019d680c-7b23-7f22-ab99-6584214a2bed" });
  });

  test("resolveThreadId — returns null for unknown", () => {
    saveThreadIndex(testDir, {});
    const result = resolveThreadId(testDir, "ffffffff");
    expect(result).toBeNull();
  });

  test("findShortId — returns short ID for known thread", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_long_id",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(findShortId(testDir, "thr_long_id")).toBe("abc12345");
  });

  test("findShortId — returns null for unknown thread", () => {
    saveThreadIndex(testDir, {});
    expect(findShortId(testDir, "thr_nope")).toBeNull();
  });

  test("updateThreadMeta patches entry", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_1",
        name: null,
        model: "old-model",
        cwd: "/old",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    updateThreadMeta(testDir, "abc12345", { name: "my thread", model: "new-model" });
    const index = loadThreadIndex(testDir);
    expect(index.abc12345.name).toBe("my thread");
    expect(index.abc12345.model).toBe("new-model");
    expect(index.abc12345.cwd).toBe("/old"); // unchanged
    expect(index.abc12345.updatedAt).not.toBe("2026-01-01T00:00:00Z");
  });

  test("removeThread deletes from index", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_1",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      def67890: {
        threadId: "thr_2",
        name: null,
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    removeThread(testDir, "abc12345");
    const index = loadThreadIndex(testDir);
    expect(index.abc12345).toBeUndefined();
    expect(index.def67890).toBeDefined();
  });
});

// ─── Run Ledger ────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: overrides.runId ?? generateRunId(),
    threadId: "thr_test",
    shortId: "abc12345",
    kind: "task",
    phase: null,
    status: "completed",
    sessionId: null,
    logFile: "/tmp/test.log",
    logOffset: 0,
    prompt: "test prompt",
    model: "gpt-5",
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsed: null,
    output: null,
    filesChanged: null,
    commandsRun: null,
    error: null,
    ...overrides,
  };
}

describe("generateRunId", () => {
  test("matches expected format", () => {
    const id = generateRunId();
    expect(id).toMatch(/^run-[0-9a-z]+-[0-9a-f]{6}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRunId()));
    expect(ids.size).toBe(50);
  });
});

describe("run ledger", () => {
  test("createRun and loadRun round-trip", () => {
    const run = makeRun();
    createRun(testDir, run);
    const loaded = loadRun(testDir, run.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(run.runId);
    expect(loaded!.threadId).toBe("thr_test");
  });

  test("loadRun returns null for missing run", () => {
    expect(loadRun(testDir, "run-nonexistent")).toBeNull();
  });

  test("updateRun patches fields", () => {
    const run = makeRun();
    createRun(testDir, run);
    updateRun(testDir, run.runId, { status: "failed", error: "boom" });
    const loaded = loadRun(testDir, run.runId);
    expect(loaded!.status).toBe("failed");
    expect(loaded!.error).toBe("boom");
    expect(loaded!.threadId).toBe("thr_test"); // unchanged
  });

  test("updateRun throws on unknown run instead of silently no-op", () => {
    expect(() => updateRun(testDir, "run-does-not-exist", { status: "completed" }))
      .toThrow(/unknown run/i);
  });

  test("listRuns returns all runs sorted by startedAt descending", () => {
    const r1 = makeRun({ startedAt: "2026-01-01T00:00:00Z" });
    const r2 = makeRun({ startedAt: "2026-01-02T00:00:00Z" });
    const r3 = makeRun({ startedAt: "2026-01-03T00:00:00Z" });
    createRun(testDir, r1);
    createRun(testDir, r2);
    createRun(testDir, r3);
    const runs = listRuns(testDir);
    expect(runs.length).toBe(3);
    expect(runs[0].runId).toBe(r3.runId);
    expect(runs[2].runId).toBe(r1.runId);
  });

  test("listRuns with sessionId filter", () => {
    const r1 = makeRun({ sessionId: "sess-a" });
    const r2 = makeRun({ sessionId: "sess-b" });
    const r3 = makeRun({ sessionId: "sess-a" });
    createRun(testDir, r1);
    createRun(testDir, r2);
    createRun(testDir, r3);
    const runs = listRuns(testDir, { sessionId: "sess-a" });
    expect(runs.length).toBe(2);
    expect(runs.every(r => r.sessionId === "sess-a")).toBe(true);
  });

  test("listRuns returns empty for nonexistent directory", () => {
    const emptyDir = join(testDir, "nonexistent-sub");
    expect(listRuns(emptyDir)).toEqual([]);
  });

  test("listRunsForThread filters by shortId", () => {
    const r1 = makeRun({ shortId: "aaa11111", startedAt: "2026-01-01T00:00:00Z" });
    const r2 = makeRun({ shortId: "bbb22222", startedAt: "2026-01-02T00:00:00Z" });
    const r3 = makeRun({ shortId: "aaa11111", startedAt: "2026-01-03T00:00:00Z" });
    createRun(testDir, r1);
    createRun(testDir, r2);
    createRun(testDir, r3);
    const runs = listRunsForThread(testDir, "aaa11111");
    expect(runs.length).toBe(2);
    expect(runs.every(r => r.shortId === "aaa11111")).toBe(true);
  });

  test("getLatestRun returns newest run for thread", () => {
    const r1 = makeRun({ shortId: "aaa11111", startedAt: "2026-01-01T00:00:00Z" });
    const r2 = makeRun({ shortId: "aaa11111", startedAt: "2026-01-03T00:00:00Z" });
    createRun(testDir, r1);
    createRun(testDir, r2);
    const latest = getLatestRun(testDir, "aaa11111");
    expect(latest!.runId).toBe(r2.runId);
  });

  test("getLatestRun returns null for thread with no runs", () => {
    expect(getLatestRun(testDir, "zzz99999")).toBeNull();
  });

  test("pruneRuns removes oldest runs", () => {
    const runs: RunRecord[] = [];
    for (let i = 0; i < 10; i++) {
      const r = makeRun({
        startedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      });
      runs.push(r);
      createRun(testDir, r);
    }
    pruneRuns(testDir, 3);
    const remaining = listRuns(testDir);
    expect(remaining.length).toBe(3);
    // Should keep the 3 newest (Jan 8, 9, 10)
    expect(remaining[0].startedAt).toContain("2026-01-10");
    expect(remaining[1].startedAt).toContain("2026-01-09");
    expect(remaining[2].startedAt).toContain("2026-01-08");
  });

  test("pruneRuns is a no-op when under limit", () => {
    createRun(testDir, makeRun());
    createRun(testDir, makeRun());
    pruneRuns(testDir, 5);
    expect(listRuns(testDir).length).toBe(2);
  });

  test("pruneRuns handles empty directory", () => {
    // Should not throw
    pruneRuns(testDir, 5);
  });

  test("pruneRuns prefers completedAt over startedAt for sort", () => {
    // Older startedAt but later completedAt: a long-running run that started
    // first but finished last. Should NOT be pruned ahead of a short run that
    // started later but finished earlier.
    const longRunningButRecent = makeRun({
      runId: "run-long",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-10T00:00:00Z",
    });
    const shortAndOldest = makeRun({
      runId: "run-short-1",
      startedAt: "2026-01-02T00:00:00Z",
      completedAt: "2026-01-02T00:01:00Z",
    });
    const shortAndOlder = makeRun({
      runId: "run-short-2",
      startedAt: "2026-01-03T00:00:00Z",
      completedAt: "2026-01-03T00:01:00Z",
    });
    createRun(testDir, longRunningButRecent);
    createRun(testDir, shortAndOldest);
    createRun(testDir, shortAndOlder);
    pruneRuns(testDir, 2);
    const remaining = listRuns(testDir).map(r => r.runId);
    expect(remaining).toContain("run-long"); // most recent activity
    expect(remaining).not.toContain("run-short-1"); // earliest activity → pruned
  });

  test("pruneRuns deletes orphan log files when no surviving run references them", () => {
    const log1 = join(testDir, "logs", "thread1.log");
    const log2 = join(testDir, "logs", "thread2.log");
    mkdirSync(join(testDir, "logs"), { recursive: true });
    writeFileSync(log1, "old log");
    writeFileSync(log2, "kept log");

    const oldRun = makeRun({
      runId: "run-old",
      shortId: "thread1",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
      logFile: log1,
    });
    const newRun = makeRun({
      runId: "run-new",
      shortId: "thread2",
      startedAt: "2026-01-05T00:00:00Z",
      completedAt: "2026-01-05T00:01:00Z",
      logFile: log2,
    });
    createRun(testDir, oldRun);
    createRun(testDir, newRun);

    pruneRuns(testDir, 1);
    expect(existsSync(log1)).toBe(false); // orphan log removed
    expect(existsSync(log2)).toBe(true);  // referenced log kept
  });

  test("pruneRuns keeps shared log when another run still references it", () => {
    const sharedLog = join(testDir, "logs", "shared.log");
    mkdirSync(join(testDir, "logs"), { recursive: true });
    writeFileSync(sharedLog, "shared log");

    const r1 = makeRun({
      runId: "run-a",
      shortId: "shared",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
      logFile: sharedLog,
    });
    const r2 = makeRun({
      runId: "run-b",
      shortId: "shared",
      startedAt: "2026-01-05T00:00:00Z",
      completedAt: "2026-01-05T00:01:00Z",
      logFile: sharedLog,
    });
    createRun(testDir, r1);
    createRun(testDir, r2);

    pruneRuns(testDir, 1);
    // Only run-b survives, but it still references the shared log → keep it.
    expect(existsSync(sharedLog)).toBe(true);
  });
});

// ─── Resume Candidate ──────────────────────────────────────────────────────

describe("getResumeCandidate", () => {
  test("returns { available: false } when no runs exist", () => {
    const result = getResumeCandidate(testDir, null);
    expect(result).toEqual({ available: false });
  });

  test("returns { available: false } when no completed tasks exist", () => {
    createRun(testDir, makeRun({ kind: "task", status: "failed" }));
    createRun(testDir, makeRun({ kind: "review", status: "completed" }));
    const result = getResumeCandidate(testDir, null);
    expect(result).toEqual({ available: false });
  });

  test("returns latest completed task", () => {
    const old = makeRun({
      shortId: "old11111",
      threadId: "thr_old",
      kind: "task",
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
    });
    const recent = makeRun({
      shortId: "new22222",
      threadId: "thr_new",
      kind: "task",
      status: "completed",
      startedAt: "2026-01-05T00:00:00Z",
    });
    createRun(testDir, old);
    createRun(testDir, recent);

    const result = getResumeCandidate(testDir, null);
    expect(result.available).toBe(true);
    expect(result.threadId).toBe("thr_new");
    expect(result.shortId).toBe("new22222");
  });

  test("prefers current session over any session", () => {
    const otherSession = makeRun({
      shortId: "aaa11111",
      threadId: "thr_other",
      kind: "task",
      status: "completed",
      sessionId: "sess-other",
      startedAt: "2026-01-05T00:00:00Z",
    });
    const currentSession = makeRun({
      shortId: "bbb22222",
      threadId: "thr_current",
      kind: "task",
      status: "completed",
      sessionId: "sess-me",
      startedAt: "2026-01-01T00:00:00Z",
    });
    createRun(testDir, otherSession);
    createRun(testDir, currentSession);

    const result = getResumeCandidate(testDir, "sess-me");
    expect(result.available).toBe(true);
    expect(result.threadId).toBe("thr_current");
    expect(result.shortId).toBe("bbb22222");
  });

  test("falls back to any session if no current-session match", () => {
    const otherSession = makeRun({
      shortId: "aaa11111",
      threadId: "thr_other",
      kind: "task",
      status: "completed",
      sessionId: "sess-other",
      startedAt: "2026-01-05T00:00:00Z",
    });
    createRun(testDir, otherSession);

    const result = getResumeCandidate(testDir, "sess-me");
    expect(result.available).toBe(true);
    expect(result.threadId).toBe("thr_other");
  });

  test("includes thread name from index", () => {
    saveThreadIndex(testDir, {
      abc12345: {
        threadId: "thr_named",
        name: "My Named Thread",
        model: null,
        cwd: "/",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    createRun(testDir, makeRun({
      shortId: "abc12345",
      threadId: "thr_named",
      kind: "task",
      status: "completed",
    }));

    const result = getResumeCandidate(testDir, null);
    expect(result.available).toBe(true);
    expect(result.name).toBe("My Named Thread");
  });
});

// ─── migrateGlobalState ───────────────────────────────────────────────────

/**
 * Helper: compute the workspace state dir that migrateGlobalState will use.
 * Mirrors workspaceDirName logic in threads.ts.
 */
function computeWsStateDir(globalDataDir: string, cwd: string): string {
  const { basename, resolve } = require("path");
  const { createHash } = require("crypto");
  const { realpathSync, spawnSync } = require("child_process") ? {} as any : {};
  // Use the same logic as resolveWorkspaceDir: try git, fallback to resolve
  const { spawnSync: spawn } = require("child_process");
  const result = spawn("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  const wsRoot = (result.status === 0 && result.stdout) ? result.stdout.trim() : resolve(cwd);
  let canonical: string;
  try {
    canonical = require("fs").realpathSync(wsRoot);
  } catch {
    canonical = resolve(wsRoot);
  }
  const slug = basename(canonical).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(globalDataDir, "workspaces", `${slug}-${hash}`);
}

function writeGlobalThreads(globalDataDir: string, mapping: ThreadMapping): void {
  const file = join(globalDataDir, "threads.json");
  mkdirSync(globalDataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(mapping, null, 2));
}

function writeGlobalLog(globalDataDir: string, shortId: string, content: string): void {
  const logsDir = join(globalDataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, `${shortId}.log`), content);
}

describe("migrateGlobalState", () => {
  let globalDir: string;
  let cwdDir: string;

  beforeEach(() => {
    globalDir = join(tmpdir(), `codex-collab-test-migrate-global-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    cwdDir = join(tmpdir(), `codex-collab-test-migrate-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(cwdDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(globalDir)) rmSync(globalDir, { recursive: true });
    if (existsSync(cwdDir)) rmSync(cwdDir, { recursive: true });
  });

  test("migrates matching entries from global to per-workspace", () => {
    const wsRoot = cwdDir; // not a git repo, so resolveWorkspaceDir returns resolve(cwd)
    writeGlobalThreads(globalDir, {
      aaa11111: {
        threadId: "thr_alpha",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        model: "gpt-5",
        cwd: wsRoot,
        preview: "Do the thing",
        lastStatus: "completed",
      },
      bbb22222: {
        threadId: "thr_beta",
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
        model: "o3",
        cwd: wsRoot,
        lastStatus: "failed",
      },
    });

    migrateGlobalState(cwdDir, globalDir);

    const wsStateDir = computeWsStateDir(globalDir, cwdDir);
    const index = loadThreadIndex(wsStateDir);
    expect(Object.keys(index)).toHaveLength(2);
    expect(index.aaa11111.threadId).toBe("thr_alpha");
    expect(index.aaa11111.model).toBe("gpt-5");
    expect(index.aaa11111.name).toBeNull();
    expect(index.bbb22222.threadId).toBe("thr_beta");
    expect(index.bbb22222.model).toBe("o3");

    // Verify synthetic run records exist
    const runs = listRuns(wsStateDir);
    expect(runs).toHaveLength(2);

    const alphaRun = runs.find(r => r.shortId === "aaa11111");
    expect(alphaRun).toBeDefined();
    expect(alphaRun!.status).toBe("completed");
    expect(alphaRun!.kind).toBe("task");
    expect(alphaRun!.prompt).toBe("Do the thing");
    expect(alphaRun!.model).toBe("gpt-5");
    expect(alphaRun!.completedAt).toBe("2026-01-02T00:00:00Z");

    const betaRun = runs.find(r => r.shortId === "bbb22222");
    expect(betaRun).toBeDefined();
    expect(betaRun!.status).toBe("failed");
    expect(betaRun!.completedAt).toBe("2026-01-04T00:00:00Z");
  });

  test("copies log files to per-workspace logs dir", () => {
    const wsRoot = cwdDir;
    writeGlobalThreads(globalDir, {
      aaa11111: {
        threadId: "thr_alpha",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "completed",
      },
    });
    writeGlobalLog(globalDir, "aaa11111", "line 1\nline 2\n");

    migrateGlobalState(cwdDir, globalDir);

    const wsStateDir = computeWsStateDir(globalDir, cwdDir);
    const wsLogFile = join(wsStateDir, "logs", "aaa11111.log");
    expect(existsSync(wsLogFile)).toBe(true);
    expect(readFileSync(wsLogFile, "utf-8")).toBe("line 1\nline 2\n");

    // Verify global log file still exists (copy, not move)
    expect(existsSync(join(globalDir, "logs", "aaa11111.log"))).toBe(true);

    // Verify run record references the log file
    const runs = listRuns(wsStateDir);
    expect(runs[0].logFile).toBe(wsLogFile);
  });

  test("no-ops if per-workspace state already exists", () => {
    const wsRoot = cwdDir;
    writeGlobalThreads(globalDir, {
      aaa11111: {
        threadId: "thr_alpha",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "completed",
      },
    });

    // Pre-create per-workspace state with different content
    const wsStateDir = computeWsStateDir(globalDir, cwdDir);
    saveThreadIndex(wsStateDir, {
      existing1: {
        threadId: "thr_existing",
        name: "Existing Thread",
        model: "gpt-5",
        cwd: wsRoot,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      },
    });

    migrateGlobalState(cwdDir, globalDir);

    // Verify per-workspace state was NOT overwritten
    const index = loadThreadIndex(wsStateDir);
    expect(Object.keys(index)).toHaveLength(1);
    expect(index.existing1.threadId).toBe("thr_existing");
    expect(index.aaa11111).toBeUndefined();
  });

  test("no-ops if global state doesn't exist", () => {
    // globalDir exists but has no threads.json
    migrateGlobalState(cwdDir, globalDir);

    const wsStateDir = computeWsStateDir(globalDir, cwdDir);
    expect(existsSync(join(wsStateDir, "threads.json"))).toBe(false);
  });

  test("filters entries by workspace cwd", () => {
    const wsRoot = cwdDir;
    const otherDir = join(tmpdir(), `codex-collab-test-other-${Date.now()}`);
    mkdirSync(otherDir, { recursive: true });

    try {
      writeGlobalThreads(globalDir, {
        aaa11111: {
          threadId: "thr_match",
          createdAt: "2026-01-01T00:00:00Z",
          cwd: wsRoot,
          lastStatus: "completed",
        },
        bbb22222: {
          threadId: "thr_subdir",
          createdAt: "2026-01-02T00:00:00Z",
          cwd: join(wsRoot, "subdir"),
          lastStatus: "completed",
        },
        ccc33333: {
          threadId: "thr_other",
          createdAt: "2026-01-03T00:00:00Z",
          cwd: otherDir,
          lastStatus: "completed",
        },
        ddd44444: {
          threadId: "thr_nocwd",
          createdAt: "2026-01-04T00:00:00Z",
          lastStatus: "completed",
        },
      });

      migrateGlobalState(cwdDir, globalDir);

      const wsStateDir = computeWsStateDir(globalDir, cwdDir);
      const index = loadThreadIndex(wsStateDir);

      // Only entries with matching cwd or subdirectory cwd should be migrated
      expect(Object.keys(index)).toHaveLength(2);
      expect(index.aaa11111).toBeDefined();
      expect(index.bbb22222).toBeDefined();
      expect(index.ccc33333).toBeUndefined();
      expect(index.ddd44444).toBeUndefined();
    } finally {
      if (existsSync(otherDir)) rmSync(otherDir, { recursive: true });
    }
  });

  test("maps legacy status values correctly", () => {
    const wsRoot = cwdDir;
    writeGlobalThreads(globalDir, {
      aaa11111: {
        threadId: "thr_completed",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "completed",
      },
      bbb22222: {
        threadId: "thr_running",
        createdAt: "2026-01-01T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "running",
      },
      ccc33333: {
        threadId: "thr_interrupted",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "interrupted",
      },
      ddd44444: {
        threadId: "thr_failed",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-04T00:00:00Z",
        cwd: wsRoot,
        lastStatus: "failed",
      },
    });

    migrateGlobalState(cwdDir, globalDir);

    const wsStateDir = computeWsStateDir(globalDir, cwdDir);
    const runs = listRuns(wsStateDir);

    const byShortId = Object.fromEntries(runs.map(r => [r.shortId, r]));
    expect(byShortId.aaa11111.status).toBe("completed");
    expect(byShortId.bbb22222.status).toBe("failed");      // stale running -> failed
    expect(byShortId.ccc33333.status).toBe("cancelled");    // interrupted -> cancelled
    expect(byShortId.ddd44444.status).toBe("failed");
  });

  test("does not throw or destroy the legacy file when global threads.json is corrupt", () => {
    // A corrupt legacy file would otherwise propagate through every CLI
    // invocation (since migrateGlobalState runs from getWorkspacePaths) and
    // — pre-fix — be renamed aside, breaking migration for OTHER workspaces.
    writeFileSync(join(globalDir, "threads.json"), "{ this is not, valid json", { mode: 0o600 });

    expect(() => migrateGlobalState(cwdDir, globalDir)).not.toThrow();

    // The corrupt file must remain in place so other workspaces still see it.
    expect(existsSync(join(globalDir, "threads.json"))).toBe(true);
    // No `.corrupt.<ts>` backup file should have been created.
    const backups = readdirSync(globalDir).filter(f => f.startsWith("threads.json.corrupt."));
    expect(backups).toEqual([]);
  });
});
