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
