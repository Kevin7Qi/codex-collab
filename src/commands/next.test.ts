// src/commands/next.test.ts — Tests for the next command's liveness logic

import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { isRunAlive } from "./next";
import type { RunRecord } from "../types";

const tmpRoot = join(process.env.TMPDIR ?? "/tmp", "next-test-" + process.pid);
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshPidsDir(): string {
  const dir = join(tmpRoot, `pids-${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  return {
    runId: "run-test", threadId: "thr_x", shortId: "abcd1234", kind: "task",
    phase: "running", status: "running", sessionId: null,
    logFile: "logs/abcd1234/run-test.log", logOffset: 0, prompt: null,
    model: null, startedAt: new Date().toISOString(), completedAt: null,
    elapsed: null, output: null, filesChanged: null, commandsRun: null, error: null,
    ...overrides,
  };
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
  if (typeof result.pid !== "number" || result.pid <= 0) throw new Error("could not obtain dead pid");
  return result.pid;
}

describe("isRunAlive", () => {
  test("a record with a live pid is alive; with a dead pid it is not", () => {
    const pidsDir = freshPidsDir();
    expect(isRunAlive(makeRun({ pid: process.pid }), pidsDir)).toBe(true);
    expect(isRunAlive(makeRun({ pid: deadPid() }), pidsDir)).toBe(false);
  });

  test("a legacy record without a pid and without a PID file is NOT alive", () => {
    // The thread-level display check treats a missing PID file as alive;
    // for next's idle detection that would make a stale crashed record
    // hold the watcher open forever.
    const pidsDir = freshPidsDir();
    expect(isRunAlive(makeRun(), pidsDir)).toBe(false);
  });

  test("a legacy record follows its PID file's liveness", () => {
    const pidsDir = freshPidsDir();
    const run = makeRun();
    writeFileSync(join(pidsDir, run.shortId), String(process.pid), { mode: 0o600 });
    expect(isRunAlive(run, pidsDir)).toBe(true);
    writeFileSync(join(pidsDir, run.shortId), String(deadPid()), { mode: 0o600 });
    expect(isRunAlive(run, pidsDir)).toBe(false);
  });
});

describe("findLiveApproval", () => {
  const { findLiveApproval } = require("./next") as typeof import("./next");

  test("fires only for approvals a live run is actually blocked on", () => {
    const stale = { id: "aaaa1111", kind: "commandExecution", summary: "rm -rf x" };
    const live = { id: "bbbb2222", kind: "commandExecution", summary: "npm publish" };
    const aliveRuns = [
      makeRun({ pendingApproval: { id: "bbbb2222", kind: "commandExecution", summary: "npm publish", requestedAt: new Date().toISOString() } }),
      makeRun({ pendingApproval: null }),
    ];
    expect(findLiveApproval([stale, live], aliveRuns)?.id).toBe("bbbb2222");
    // A killed run's leftover file, with no live run referencing it: nothing fires.
    expect(findLiveApproval([stale], aliveRuns)).toBeUndefined();
    expect(findLiveApproval([stale, live], [])).toBeUndefined();
  });
});
