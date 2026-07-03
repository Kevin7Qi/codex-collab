// src/commands/follow.test.ts — bare-follow run selection

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pickDefaultRun, nextUnseenRun } from "./follow";
import { createRun } from "../threads";
import type { RunRecord, RunStatus } from "../types";

const tmpRoot = join(process.env.TMPDIR ?? "/tmp", "follow-test-" + process.pid);

function freshDirs(name: string): { stateDir: string; pidsDir: string } {
  const stateDir = join(tmpRoot, name);
  const pidsDir = join(stateDir, "pids");
  mkdirSync(pidsDir, { recursive: true });
  return { stateDir, pidsDir };
}

function record(runId: string, shortId: string, status: RunStatus, startedAt: string): RunRecord {
  return {
    runId, threadId: `thread-${shortId}`, shortId, kind: "task",
    phase: "running", status, sessionId: null,
    logFile: `logs/${shortId}.log`, logOffset: 0, prompt: "p", model: "m",
    startedAt, completedAt: null, elapsed: null,
    output: null, filesChanged: null, commandsRun: null, error: null,
  };
}

describe("pickDefaultRun", () => {
  test("prefers the newest running run with a live process", () => {
    const { stateDir, pidsDir } = freshDirs("live-run");
    createRun(stateDir, record("r-old", "aaaa0001", "completed", "2026-07-02T10:00:00.000Z"));
    createRun(stateDir, record("r-live", "aaaa0002", "running", "2026-07-02T09:00:00.000Z"));
    // Live PID for the running one (this test process)
    writeFileSync(join(pidsDir, "aaaa0002"), String(process.pid));

    // The completed run is NEWER, but the live running run wins.
    expect(pickDefaultRun(stateDir, pidsDir)?.runId).toBe("r-live");
  });

  test("skips a stale running record whose process is dead", () => {
    const { stateDir, pidsDir } = freshDirs("stale-run");
    createRun(stateDir, record("r-stale", "bbbb0001", "running", "2026-07-02T11:00:00.000Z"));
    createRun(stateDir, record("r-done", "bbbb0002", "completed", "2026-07-02T10:00:00.000Z"));
    // Dead PID for the "running" record (bun test never has PID ~2^22-ish reserved)
    writeFileSync(join(pidsDir, "bbbb0001"), "99999999");

    // No live running run → newest run overall (the stale one — replay shows
    // its content, and follow's own dead-runner check reports the crash).
    expect(pickDefaultRun(stateDir, pidsDir)?.runId).toBe("r-stale");
  });

  test("falls back to the newest run when nothing is running", () => {
    const { stateDir, pidsDir } = freshDirs("replay");
    createRun(stateDir, record("r-1", "cccc0001", "completed", "2026-07-02T10:00:00.000Z"));
    createRun(stateDir, record("r-2", "cccc0002", "failed", "2026-07-02T11:00:00.000Z"));

    expect(pickDefaultRun(stateDir, pidsDir)?.runId).toBe("r-2");
  });

  test("returns null when the workspace has no runs", () => {
    const { stateDir, pidsDir } = freshDirs("empty");
    expect(pickDefaultRun(stateDir, pidsDir)).toBeNull();
  });
});

describe("nextUnseenRun (watch mode)", () => {
  test("returns unseen runs oldest-first so none are skipped under concurrency", () => {
    const { stateDir } = freshDirs("watch-order");
    createRun(stateDir, record("r-1", "dddd0001", "completed", "2026-07-02T10:00:00.000Z"));
    createRun(stateDir, record("r-2", "dddd0002", "completed", "2026-07-02T11:00:00.000Z"));
    createRun(stateDir, record("r-3", "dddd0003", "running", "2026-07-02T12:00:00.000Z"));

    const seen = new Set<string>();
    // Two runs finished while we were attached elsewhere: both must surface,
    // in start order — not just the newest.
    expect(nextUnseenRun(stateDir, seen, null)?.runId).toBe("r-1");
    seen.add("r-1");
    expect(nextUnseenRun(stateDir, seen, null)?.runId).toBe("r-2");
    seen.add("r-2");
    expect(nextUnseenRun(stateDir, seen, null)?.runId).toBe("r-3");
    seen.add("r-3");
    expect(nextUnseenRun(stateDir, seen, null)).toBeNull();
  });

  test("scoped watch only surfaces runs of that thread", () => {
    const { stateDir } = freshDirs("watch-scoped");
    createRun(stateDir, record("r-mine", "eeee0001", "completed", "2026-07-02T10:00:00.000Z"));
    createRun(stateDir, record("r-other", "eeee0002", "running", "2026-07-02T11:00:00.000Z"));

    const seen = new Set<string>();
    expect(nextUnseenRun(stateDir, seen, "eeee0001")?.runId).toBe("r-mine");
    seen.add("r-mine");
    // The other thread's run never appears in a scoped watch
    expect(nextUnseenRun(stateDir, seen, "eeee0001")).toBeNull();
  });
});

describe("replayBound (shared thread log)", () => {
  test("bounds a run's replay at the next run's logOffset on the same thread", () => {
    const { stateDir } = freshDirs("replay-bound");
    const r1 = { ...record("r-1", "ffff0001", "completed", "2026-07-03T10:00:00.000Z"), logOffset: 0 };
    const r2 = { ...record("r-2", "ffff0001", "completed", "2026-07-03T11:00:00.000Z"), logOffset: 500 };
    const r3 = { ...record("r-3", "ffff0001", "running", "2026-07-03T12:00:00.000Z"), logOffset: 900 };
    createRun(stateDir, r1);
    createRun(stateDir, r2);
    createRun(stateDir, r3);

    const { replayBound } = require("./follow") as typeof import("./follow");
    // r1's replay must stop where r2 begins — not swallow r2+r3's entries
    expect(replayBound(stateDir, r1)).toBe(500);
    expect(replayBound(stateDir, r2)).toBe(900);
    // The newest run owns the log tail
    expect(replayBound(stateDir, r3)).toBeNull();
  });

  test("runs on other threads don't bound this one", () => {
    const { stateDir } = freshDirs("replay-bound-other");
    const mine = { ...record("r-a", "aaaa9001", "completed", "2026-07-03T10:00:00.000Z"), logOffset: 0 };
    const other = { ...record("r-b", "bbbb9001", "completed", "2026-07-03T11:00:00.000Z"), logOffset: 700 };
    createRun(stateDir, mine);
    createRun(stateDir, other);

    const { replayBound } = require("./follow") as typeof import("./follow");
    expect(replayBound(stateDir, mine)).toBeNull();
  });
});

describe("replayBound: zero-byte runs (equal logOffset)", () => {
  test("a run that wrote nothing is bounded at its own offset by the next run", () => {
    const { stateDir } = freshDirs("replay-bound-empty");
    // r-empty died before the dispatcher wrote any bytes; r-next starts at
    // the identical offset. r-empty's replay must be zero-length — not the
    // log tail, which would render r-next's content twice.
    const rEmpty = { ...record("r-empty", "abcd7001", "failed", "2026-07-03T10:00:00.000Z"), logOffset: 500 };
    const rNext = { ...record("r-next", "abcd7001", "completed", "2026-07-03T11:00:00.000Z"), logOffset: 500 };
    createRun(stateDir, rEmpty);
    createRun(stateDir, rNext);

    const { replayBound } = require("./follow") as typeof import("./follow");
    expect(replayBound(stateDir, rEmpty)).toBe(500);
    expect(replayBound(stateDir, rNext)).toBeNull(); // the later run owns the tail
  });
});

describe("seedSeenRuns (watch startup)", () => {
  test("history is seeded; live concurrent runs stay unseen", () => {
    const { stateDir, pidsDir } = freshDirs("seed-seen");
    createRun(stateDir, record("r-old", "1111aaaa", "completed", "2026-07-03T09:00:00.000Z"));
    createRun(stateDir, record("r-picked", "2222aaaa", "running", "2026-07-03T10:00:00.000Z"));
    createRun(stateDir, record("r-live2", "3333aaaa", "running", "2026-07-03T10:00:01.000Z"));
    createRun(stateDir, record("r-stale", "4444aaaa", "running", "2026-07-03T10:00:02.000Z"));
    // r-picked and r-live2 have live runners; r-stale's is dead
    writeFileSync(join(pidsDir, "2222aaaa"), String(process.pid));
    writeFileSync(join(pidsDir, "3333aaaa"), String(process.pid));
    writeFileSync(join(pidsDir, "4444aaaa"), "99999999");

    const { seedSeenRuns } = require("./follow") as typeof import("./follow");
    const seen = seedSeenRuns(stateDir, pidsDir, "r-picked");

    expect(seen.has("r-old")).toBe(true);    // history: don't replay
    expect(seen.has("r-stale")).toBe(true);  // dead runner: not active work
    expect(seen.has("r-live2")).toBe(false); // concurrent live run MUST display later
    expect(seen.has("r-picked")).toBe(false); // the run being attached first
  });
});

describe("pickWatchStartRun (start order with multiple live runs)", () => {
  test("picks the OLDEST live run so a blocked older run isn't hidden", () => {
    const { stateDir, pidsDir } = freshDirs("watch-start-order");
    createRun(stateDir, record("r-done", "5555bbbb", "completed", "2026-07-03T08:00:00.000Z"));
    createRun(stateDir, record("r-live-old", "6666bbbb", "running", "2026-07-03T09:00:00.000Z"));
    createRun(stateDir, record("r-live-new", "7777bbbb", "running", "2026-07-03T10:00:00.000Z"));
    writeFileSync(join(pidsDir, "6666bbbb"), String(process.pid));
    writeFileSync(join(pidsDir, "7777bbbb"), String(process.pid));

    const { pickWatchStartRun } = require("./follow") as typeof import("./follow");
    expect(pickWatchStartRun(stateDir, pidsDir)?.runId).toBe("r-live-old");
  });

  test("falls back to newest run overall when nothing is live", () => {
    const { stateDir, pidsDir } = freshDirs("watch-start-replay");
    createRun(stateDir, record("r-1", "8888bbbb", "completed", "2026-07-03T08:00:00.000Z"));
    createRun(stateDir, record("r-2", "9999bbbb", "failed", "2026-07-03T09:00:00.000Z"));

    const { pickWatchStartRun } = require("./follow") as typeof import("./follow");
    expect(pickWatchStartRun(stateDir, pidsDir)?.runId).toBe("r-2");
  });
});

describe("orphaned run records (deleted threads)", () => {
  test("bare-follow pickers skip runs whose thread is gone from the index", () => {
    const { stateDir, pidsDir } = freshDirs("orphan-runs");
    const threadsFile = join(stateDir, "threads.json");
    // Thread index knows only 'kept1111'; 'gone2222' was deleted but its
    // stale running record survived (pre-fix delete) with no PID file —
    // which reads as "alive" and would hang a bare follow forever.
    writeFileSync(threadsFile, JSON.stringify({
      kept1111: { threadId: "t-kept", createdAt: "2026-07-03T09:00:00.000Z" },
    }));
    createRun(stateDir, record("r-kept", "kept1111", "completed", "2026-07-03T09:00:00.000Z"));
    createRun(stateDir, record("r-orphan", "gone2222", "running", "2026-07-03T10:00:00.000Z"));

    const { pickDefaultRun, pickWatchStartRun, nextUnseenRun } = require("./follow") as typeof import("./follow");
    expect(pickDefaultRun(stateDir, pidsDir, threadsFile)?.runId).toBe("r-kept");
    expect(pickWatchStartRun(stateDir, pidsDir, threadsFile)?.runId).toBe("r-kept");
    expect(nextUnseenRun(stateDir, new Set(), null, threadsFile)?.runId).toBe("r-kept");
  });
});

describe("delete removes the thread's run records", () => {
  test("removeRunsForThread clears only that thread's records", () => {
    const { stateDir } = freshDirs("delete-runs");
    createRun(stateDir, record("r-a1", "aaaa4001", "completed", "2026-07-03T09:00:00.000Z"));
    createRun(stateDir, record("r-a2", "aaaa4001", "running", "2026-07-03T10:00:00.000Z"));
    createRun(stateDir, record("r-b1", "bbbb4001", "completed", "2026-07-03T11:00:00.000Z"));

    const { removeRunsForThread, listRuns } = require("../threads") as typeof import("../threads");
    removeRunsForThread(stateDir, "aaaa4001");
    expect(listRuns(stateDir).map(r => r.runId)).toEqual(["r-b1"]);
  });
});
