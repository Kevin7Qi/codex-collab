import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { applyDiscoverLimit, resolveReadableLogPath, resolveRunLogPath, collectThreadLogPaths, readThreadLog } from "./threads";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createRun } from "../threads";
import type { RunRecord } from "../types";

describe("applyDiscoverLimit", () => {
  test("caps to 5 when discover=true and limit not explicit", () => {
    const opts = { discover: true, limit: 20, explicit: new Set<string>() };
    expect(applyDiscoverLimit(opts)).toBe(5);
  });

  test("uses explicit limit when discover=true and --limit provided", () => {
    const opts = { discover: true, limit: 30, explicit: new Set(["limit"]) };
    expect(applyDiscoverLimit(opts)).toBe(30);
  });

  test("returns original limit when discover=false (no cap)", () => {
    const opts = { discover: false, limit: 20, explicit: new Set<string>() };
    expect(applyDiscoverLimit(opts)).toBe(20);
  });

  test("returns Infinity when discover=false and --all", () => {
    const opts = { discover: false, limit: Infinity, explicit: new Set(["limit"]) };
    expect(applyDiscoverLimit(opts)).toBe(Infinity);
  });
});

// resolveReadableLogPath addresses the migration-edge-case Codex flagged:
// if migration's copyFileSync from {dataDir}/logs to {stateDir}/logs ever fails,
// the run record stores the legacy global path as `logFile` and no workspace-
// local log file exists. With the migration marker stamped, migration never
// retries the copy. `output`/`progress` previously read only the workspace-
// local path → empty/missing. The fallback resolves to the run record's
// logFile when the workspace file is absent so the user can still read the log.
describe("resolveReadableLogPath", () => {
  let stateDir: string;
  let logsDir: string;
  let legacyLogsDir: string;
  let legacyLog: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stateDir = join(tmpdir(), `codex-resolvable-log-${suffix}`);
    logsDir = join(stateDir, "logs");
    legacyLogsDir = join(tmpdir(), `codex-resolvable-legacy-${suffix}`);
    legacyLog = join(legacyLogsDir, "abcd1234.log");
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(legacyLogsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
    if (existsSync(legacyLogsDir)) rmSync(legacyLogsDir, { recursive: true });
  });

  function record(shortId: string, logFile: string): RunRecord {
    return {
      runId: `r-${shortId}`, threadId: `t-${shortId}`, shortId,
      kind: "task", phase: null, status: "completed", sessionId: null,
      logFile, logOffset: 0, prompt: null, model: null,
      startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z",
      elapsed: null, output: null, filesChanged: null, commandsRun: null, error: null,
    };
  }

  test("prefers the workspace-local log when it exists", () => {
    const ws = join(logsDir, "abcd1234.log");
    writeFileSync(ws, "ws content");
    writeFileSync(legacyLog, "legacy content");
    createRun(stateDir, record("abcd1234", legacyLog));
    expect(resolveReadableLogPath(stateDir, logsDir, "abcd1234", legacyLogsDir)).toBe(ws);
  });

  test("falls back to the run record's logFile when the workspace log is absent", () => {
    // The migration-copy-failure scenario: no {logsDir}/<shortId>.log on disk;
    // the run record points at the legacy global location, which still exists.
    writeFileSync(legacyLog, "legacy content");
    createRun(stateDir, record("abcd1234", legacyLog));
    expect(resolveReadableLogPath(stateDir, logsDir, "abcd1234", legacyLogsDir)).toBe(legacyLog);
  });

  test("returns the workspace path (for downstream not-found handling) when neither file exists", () => {
    createRun(stateDir, record("abcd1234", legacyLog)); // logFile points nowhere
    const expected = join(logsDir, "abcd1234.log");
    expect(resolveReadableLogPath(stateDir, logsDir, "abcd1234", legacyLogsDir)).toBe(expected);
  });

  test("returns the workspace path when no run record exists", () => {
    const expected = join(logsDir, "abcd1234.log");
    expect(resolveReadableLogPath(stateDir, logsDir, "abcd1234", legacyLogsDir)).toBe(expected);
  });

  test("refuses fallback paths outside both workspace and legacy logs roots", () => {
    // Confinement: a run record carrying an arbitrary absolute path (corrupted
    // state, adversarial input, file moved aside) must not let `output` or
    // `progress` happily print contents from anywhere on the filesystem.
    const evilDir = join(tmpdir(), `codex-resolvable-evil-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(evilDir, { recursive: true });
    const evilLog = join(evilDir, "outside.log");
    writeFileSync(evilLog, "should not be readable");
    try {
      createRun(stateDir, record("abcd1234", evilLog));
      const expected = join(logsDir, "abcd1234.log");
      expect(resolveReadableLogPath(stateDir, logsDir, "abcd1234", legacyLogsDir)).toBe(expected);
    } finally {
      rmSync(evilDir, { recursive: true });
    }
  });
});

describe("per-run log reading (resolveRunLogPath / collectThreadLogPaths / readThreadLog)", () => {
  let stateDir: string;
  let logsDir: string;

  beforeEach(() => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    stateDir = join(tmpdir(), `codex-per-run-log-${suffix}`);
    logsDir = join(stateDir, "logs");
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  function record(shortId: string, runId: string, logFile: string): RunRecord {
    return {
      runId, threadId: `t-${shortId}`, shortId,
      kind: "task", phase: null, status: "completed", sessionId: null,
      logFile, logOffset: 0, prompt: null, model: null,
      startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z",
      elapsed: null, output: null, filesChanged: null, commandsRun: null, error: null,
    };
  }

  test("resolveRunLogPath resolves the record's own confined logFile", () => {
    const rec = record("aaaa1111", "run-1", "logs/aaaa1111/run-1.log");
    expect(resolveRunLogPath(stateDir, logsDir, rec)).toBe(join(logsDir, "aaaa1111", "run-1.log"));
  });

  test("resolveRunLogPath refuses an escaping logFile and falls back to the thread log", () => {
    const rec = record("aaaa2222", "run-1", "../../../etc/passwd");
    expect(resolveRunLogPath(stateDir, logsDir, rec)).toBe(join(logsDir, "aaaa2222.log"));
  });

  test("collectThreadLogPaths orders legacy shared log before per-run files, per-run sorted by name", () => {
    const shortId = "bbbb1111";
    writeFileSync(join(logsDir, `${shortId}.log`), "legacy\n");
    mkdirSync(join(logsDir, shortId), { recursive: true });
    // base36-timestamp runIds sort chronologically by name
    writeFileSync(join(logsDir, shortId, "run-b-second.log"), "second\n");
    writeFileSync(join(logsDir, shortId, "run-a-first.log"), "first\n");

    expect(collectThreadLogPaths(stateDir, logsDir, shortId)).toEqual([
      join(logsDir, `${shortId}.log`),
      join(logsDir, shortId, "run-a-first.log"),
      join(logsDir, shortId, "run-b-second.log"),
    ]);
    expect(readThreadLog(stateDir, logsDir, shortId)).toBe("legacy\nfirst\nsecond\n");
  });

  test("readThreadLog returns null for a thread with no logs", () => {
    expect(readThreadLog(stateDir, logsDir, "cccc1111")).toBeNull();
  });

  test("migration-edge global log survives alongside newer per-run files", () => {
    // The copy-failed migration case: the only pre-resume history lives in
    // the legacy GLOBAL logs dir (via the synthetic run record's logFile).
    // Resuming the thread creates per-run logs — the global history must
    // still be included, not dropped once per-run files exist.
    const shortId = "eeee1111";
    const globalLogsDir = join(stateDir, "fake-global-logs");
    mkdirSync(globalLogsDir, { recursive: true });
    const globalLog = join(globalLogsDir, `${shortId}.log`);
    writeFileSync(globalLog, "pre-resume history\n");
    createRun(stateDir, record(shortId, "run-0-migrated", globalLog));
    mkdirSync(join(logsDir, shortId), { recursive: true });
    writeFileSync(join(logsDir, shortId, "run-1-resumed.log"), "post-resume\n");
    createRun(stateDir, record(shortId, "run-1-resumed", `logs/${shortId}/run-1-resumed.log`));

    expect(collectThreadLogPaths(stateDir, logsDir, shortId, globalLogsDir)).toEqual([
      globalLog,
      join(logsDir, shortId, "run-1-resumed.log"),
    ]);
  });

  test("collectThreadLogPaths falls back to the migration-edge global log via the run record", () => {
    // No workspace logs at all; the latest run record points at a legacy
    // global-path log (the resolveReadableLogPath edge case).
    const globalDir = join(stateDir, "global-logs");
    mkdirSync(globalDir, { recursive: true });
    const globalLog = join(globalDir, "dddd1111.log");
    writeFileSync(globalLog, "global content\n");
    createRun(stateDir, record("dddd1111", "run-1", globalLog));

    const paths = collectThreadLogPaths(stateDir, logsDir, "dddd1111");
    // The record scan confines to logsDir + the global logs dir; a path
    // under stateDir/global-logs is OUTSIDE both (config.logsDir default),
    // so it must be refused — an empty list, not an escape.
    expect(paths).toEqual([]);
  });
});

describe("extractAgentOutputBlocks", () => {
  const { extractAgentOutputBlocks } = require("./threads") as typeof import("./threads");
  const ts = "2026-07-03T10:00:00.000Z";

  test("extracts each turn's block separately", () => {
    const log = [
      `${ts} [codex] Turn started`,
      `${ts} agent output:`, "first answer", "<<END_AGENT_OUTPUT>>",
      `${ts} [codex] Turn started`,
      `${ts} agent output:`, "second answer", "line two", "<<END_AGENT_OUTPUT>>",
    ].join("\n");
    expect(extractAgentOutputBlocks(log)).toEqual(["first answer", "second answer\nline two"]);
  });

  test("timestamps inside model output do not end a block early", () => {
    const log = [
      `${ts} agent output:`, "before", "not-a-log 2026-07-03T10:00:00.000Z inline", "<<END_AGENT_OUTPUT>>",
    ].join("\n");
    expect(extractAgentOutputBlocks(log)).toEqual(["before\nnot-a-log 2026-07-03T10:00:00.000Z inline"]);
  });

  test("a crash-truncated block (no end marker) is still captured", () => {
    const log = [
      `${ts} agent output:`, "partial output",
    ].join("\n");
    expect(extractAgentOutputBlocks(log)).toEqual(["partial output"]);
  });

  test("a new timestamped entry closes an unterminated block", () => {
    const log = [
      `${ts} agent output:`, "truncated",
      `${ts} [codex] next entry`,
      `${ts} agent output:`, "complete", "<<END_AGENT_OUTPUT>>",
    ].join("\n");
    expect(extractAgentOutputBlocks(log)).toEqual(["truncated", "complete"]);
  });

  test("no blocks in a log without agent output", () => {
    expect(extractAgentOutputBlocks(`${ts} [codex] Turn started\n${ts} command: ls (exit 0)`)).toEqual([]);
  });
});

describe("pickLastOutput (output --last)", () => {
  const { pickLastOutput } = require("./threads") as typeof import("./threads");
  const ts = "2026-07-03T10:00:00.000Z";
  const staleLog = `${ts} agent output:\nOLD ANSWER\n<<END_AGENT_OUTPUT>>`;

  function rec(over: Partial<RunRecord>): RunRecord {
    return {
      runId: "r1", threadId: "t1", shortId: "aaaa1111", kind: "task",
      phase: "finalizing", status: "completed", sessionId: null,
      logFile: "logs/aaaa1111.log", logOffset: 0, prompt: "p", model: "m",
      startedAt: ts, completedAt: ts, elapsed: "1s",
      output: "NEW ANSWER", filesChanged: null, commandsRun: null, error: null,
      ...over,
    } as RunRecord;
  }

  test("completed run returns its own output, not the log's last block", () => {
    const res = pickLastOutput(rec({}), staleLog);
    expect(res).toEqual({ kind: "output", text: "NEW ANSWER", note: null });
  });

  test("a running latest run never falls back to an older turn's block", () => {
    const res = pickLastOutput(rec({ status: "running", output: null, completedAt: null }), staleLog);
    expect(res.kind).toBe("none");
    expect((res as { running: boolean }).running).toBe(true);
  });

  test("an output-less failed run reports no-output instead of the stale block", () => {
    const res = pickLastOutput(rec({ status: "failed", output: null, error: "boom" }), staleLog);
    expect(res.kind).toBe("none");
    expect((res as { reason: string }).reason).toContain("boom");
  });

  test("a failed run WITH partial output returns it, flagged", () => {
    const res = pickLastOutput(rec({ status: "failed", output: "partial", error: "boom" }), staleLog);
    expect(res).toMatchObject({ kind: "output", text: "partial" });
    expect((res as { note: string }).note).toContain("failed");
  });

  test("no ledger record falls back to the newest log block", () => {
    expect(pickLastOutput(null, staleLog)).toEqual({ kind: "output", text: "OLD ANSWER", note: null });
    expect(pickLastOutput(null, "").kind).toBe("none");
  });
});
