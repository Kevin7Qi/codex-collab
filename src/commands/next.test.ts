// src/commands/next.test.ts — Tests for the next command's liveness logic

import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";
import { formatApprovalEvent, formatQuestionEvent, isRunAlive } from "./next";
import type { QuestionRecord, RunRecord } from "../types";

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

describe("event formatting", () => {
  const question: QuestionRecord = {
    id: "q86a9a94",
    question: "SPEC.md says JSON.\nThe goal text says YAML.\nWhich wins?",
    askedAt: new Date(Date.now() - 30_000).toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    workspaceDir: "/tmp/my project",
    pid: 1234,
  };

  test("question event carries the FULL body — no follow-up round-trip", () => {
    const text = formatQuestionEvent(question);
    expect(text).toContain("Question q86a9a94  expires in 2m");
    expect(text).toContain("SPEC.md says JSON.\nThe goal text says YAML.\nWhich wins?");
    // The -d hint is shell-quoted — the path has a space and must survive copy-paste.
    expect(text).toContain(`answer q86a9a94 "<text>" -d '/tmp/my project'`);
  });

  test("untrusted text is sanitized at the output boundary", () => {
    const text = formatQuestionEvent({ ...question, question: "evil\x1b[2Jquestion" });
    expect(text).toContain("evil[2Jquestion");
    expect(text).not.toContain("\x1b");
  });

  test("approval event names the kind, payload, and both responses", () => {
    const text = formatApprovalEvent(
      { id: "aaaa1111", kind: "commandExecution", summary: "rm -rf node_modules" },
      "/tmp/ws",
    );
    expect(text).toContain("Approval aaaa1111 (commandExecution)");
    expect(text).toContain("  rm -rf node_modules");
    expect(text).toContain("approve aaaa1111 -d '/tmp/ws'  (or: decline aaaa1111)");
  });

  test("missing kind/summary degrade gracefully", () => {
    const text = formatApprovalEvent({ id: "aaaa1111", kind: null, summary: null }, "/tmp/ws");
    expect(text).toContain("Approval aaaa1111\n");
    expect(text).toContain("(no details)");
  });
});
