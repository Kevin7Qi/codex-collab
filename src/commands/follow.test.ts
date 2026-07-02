// src/commands/follow.test.ts — bare-follow run selection

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pickDefaultRun } from "./follow";
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
