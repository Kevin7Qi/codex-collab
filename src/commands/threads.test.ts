import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { applyDiscoverLimit, resolveReadableLogPath } from "./threads";
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
