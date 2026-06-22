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
