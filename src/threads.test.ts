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
} from "./threads";
import type { RunRecord } from "./types";
import { rmSync, existsSync, mkdirSync } from "fs";
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
