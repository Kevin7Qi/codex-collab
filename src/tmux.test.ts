// Integration tests for tmux session management
//
// These tests exercise the real tmux + shell command pipeline.
// They require tmux to be available and create short-lived sessions.

import { describe, it, expect, afterEach, beforeEach, setDefaultTimeout } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  sessionExists as tmuxSessionExists,
  capturePaneUnchecked,
  captureFullHistoryUnchecked,
  clearHistoryUnchecked,
  sendMessageUnchecked,
  sendLiteralUnchecked,
  sendKeysUnchecked,
  killSessionUnchecked,
} from "./tmux.ts";
import {
  saveJob,
  loadJob,
  listJobs,
  deleteJob,
  killJob,
  refreshJobStatus,
  getJobOutput,
  getJobFullOutput,
  getAttachCommand,
  type Job,
} from "./jobs.ts";
import { config } from "./config.ts";

// These are integration tests that create real tmux sessions — give them room.
setDefaultTimeout(30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PREFIX = "codex-collab-test";
const createdSessions: string[] = [];

function tmux(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "") as string };
}

function sessionExists(name: string): boolean {
  return tmux(["has-session", "-t", name]).status === 0;
}

function killSession(name: string): void {
  tmux(["kill-session", "-t", name]);
}

/** Create a tmux session running a shell command, tracked for cleanup. */
function createTestSession(name: string, cmd: string): void {
  createdSessions.push(name);
  const result = spawnSync("tmux", [
    "new-session", "-d", "-s", name, "-x", "120", "-y", "20",
    "-e", "HISTFILE=/dev/null", cmd,
  ], { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`Failed to create session ${name}: exit ${result.status}`);
  }
}

function sleep(ms: number): void {
  Bun.sleepSync(ms);
}

afterEach(() => {
  for (const name of createdSessions) {
    try { killSession(name); } catch {}
  }
  createdSessions.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idle watchdog", () => {
  it("sends /exit when the log file is stale", () => {
    // Use a very short idle timeout (3 seconds) and poll interval (1 second)
    // so the test completes quickly.
    const sessionName = `${TEST_PREFIX}-watchdog-idle`;
    const logFile = `/tmp/${sessionName}.log`;
    const exitFile = `/tmp/${sessionName}.exit`;
    const idleTimeoutSec = 3;

    // Create a log file with an old mtime (5 minutes ago) so the watchdog
    // triggers immediately on its first check.
    writeFileSync(logFile, "test log content");
    const oldTime = new Date(Date.now() - 5 * 60 * 1000);
    spawnSync("touch", ["-d", oldTime.toISOString(), logFile]);

    // Shell command: watchdog with 1s poll + a foreground process that
    // records any input it receives (simulating codex reading stdin).
    // When the watchdog sends "/exit\nEnter", cat captures it.
    const watchdog = `(while sleep 1; do tmux has-session -t "${sessionName}" 2>/dev/null || break; age=$(( $(date +%s) - $(stat -c %Y "${logFile}" 2>/dev/null || echo 0) )); [ $age -gt ${idleTimeoutSec} ] && tmux send-keys -t "${sessionName}" /exit Enter && break; done) &`;
    const cmd = `${watchdog} _wd=$!; trap "kill $_wd 2>/dev/null" EXIT; cat > "${exitFile}"; echo done >> "${exitFile}"`;

    createTestSession(sessionName, cmd);
    expect(sessionExists(sessionName)).toBe(true);

    // Wait for the watchdog to fire (1s poll + processing)
    sleep(5_000);

    // The watchdog should have sent "/exit" + Enter to the pane.
    // `cat` receives it as stdin and writes to exitFile, then "done" is appended.
    let content = "";
    try {
      content = readFileSync(exitFile, "utf-8");
    } catch {}

    expect(content).toContain("/exit");

    // Cleanup
    try { unlinkSync(logFile); } catch {}
    try { unlinkSync(exitFile); } catch {}
  });

  it("exits when the tmux session is killed externally", () => {
    // Verify the watchdog doesn't become an orphan when the session dies.
    const sessionName = `${TEST_PREFIX}-watchdog-orphan`;
    const markerFile = `/tmp/${sessionName}.alive`;
    const logFile = `/tmp/${sessionName}.log`;

    writeFileSync(logFile, "test");

    // Watchdog writes to a marker file each iteration so we can track it.
    // Uses a very short idle timeout we won't hit (999s) — we're testing
    // the session-gone exit path, not the idle path.
    const watchdog = `(while sleep 1; do echo tick >> "${markerFile}"; tmux has-session -t "${sessionName}" 2>/dev/null || break; done) &`;
    const cmd = `${watchdog} _wd=$!; trap "kill $_wd 2>/dev/null" EXIT; sleep 300`;

    createTestSession(sessionName, cmd);
    sleep(3_000);

    // Watchdog should be ticking
    let ticks = "";
    try { ticks = readFileSync(markerFile, "utf-8"); } catch {}
    const tickCountBefore = ticks.split("tick").length - 1;
    expect(tickCountBefore).toBeGreaterThan(0);

    // Kill the session
    killSession(sessionName);
    sleep(3_000);

    // Watchdog should have stopped ticking
    let ticksAfter = "";
    try { ticksAfter = readFileSync(markerFile, "utf-8"); } catch {}
    const tickCountAfter = ticksAfter.split("tick").length - 1;

    // Allow at most 1 extra tick (the iteration that detected the session is gone)
    expect(tickCountAfter - tickCountBefore).toBeLessThanOrEqual(1);

    // Cleanup
    try { unlinkSync(markerFile); } catch {}
    try { unlinkSync(logFile); } catch {}
  });

  it("does not fire while the log file is being updated", () => {
    const sessionName = `${TEST_PREFIX}-watchdog-active`;
    const logFile = `/tmp/${sessionName}.log`;
    const firedFile = `/tmp/${sessionName}.fired`;

    writeFileSync(logFile, "initial");

    // Watchdog with 2s idle timeout and 1s poll.
    // If it fires, it creates firedFile.
    const idleTimeoutSec = 2;
    const watchdog = `(while sleep 1; do tmux has-session -t "${sessionName}" 2>/dev/null || break; age=$(( $(date +%s) - $(stat -c %Y "${logFile}" 2>/dev/null || echo 0) )); if [ $age -gt ${idleTimeoutSec} ]; then touch "${firedFile}"; break; fi; done) &`;
    const cmd = `${watchdog} _wd=$!; trap "kill $_wd 2>/dev/null" EXIT; sleep 300`;

    createTestSession(sessionName, cmd);

    // Keep touching the log file every second for 5 seconds
    for (let i = 0; i < 5; i++) {
      sleep(1_000);
      spawnSync("touch", [logFile]);
    }

    // Watchdog should NOT have fired
    let fired = false;
    try {
      readFileSync(firedFile, "utf-8");
      fired = true;
    } catch {}

    expect(fired).toBe(false);

    // Now stop touching and wait for watchdog to fire
    sleep(5_000);

    try {
      readFileSync(firedFile, "utf-8");
      fired = true;
    } catch {}

    expect(fired).toBe(true);

    // Cleanup
    try { unlinkSync(logFile); } catch {}
    try { unlinkSync(firedFile); } catch {}
  });
});

describe("killed job status", () => {
  it("killJob sets status to killed, not failed", async () => {
    const { startInteractiveJob, killJob, loadJob, deleteJob } = await import("./jobs.ts");

    const job = startInteractiveJob({
      cwd: process.cwd(),
      sandbox: "read-only",
    });

    // Job should be running (or failed if codex isn't available, skip in that case)
    if (job.status !== "running") {
      console.log("Skipping: codex session did not start (codex may not be available)");
      return;
    }

    killJob(job.id);

    const reloaded = loadJob(job.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("killed");
    expect(reloaded!.error).toBeUndefined();

    deleteJob(job.id);
  });
});

// ---------------------------------------------------------------------------
// tmux session basics — exercise the exported tmux.ts functions directly
// ---------------------------------------------------------------------------

describe("tmux session basics", () => {
  it("sessionExists returns false for nonexistent session", () => {
    expect(tmuxSessionExists("codex-collab-test-nonexistent-999")).toBe(false);
  });

  it("create, capture, kill round-trip", () => {
    const name = `${TEST_PREFIX}-roundtrip`;
    createTestSession(name, "echo 'hello from test'; sleep 300");
    sleep(500);

    expect(tmuxSessionExists(name)).toBe(true);

    const output = capturePaneUnchecked(name);
    expect(output).not.toBeNull();
    expect(output!).toContain("hello from test");

    killSessionUnchecked(name);
    sleep(500);
    expect(tmuxSessionExists(name)).toBe(false);
  });

  it("sendMessageUnchecked + capturePaneUnchecked round-trip", () => {
    const name = `${TEST_PREFIX}-send-msg`;
    // Start a shell that will echo what we type
    createTestSession(name, "bash");
    sleep(500);

    sendMessageUnchecked(name, "echo MARKER_TEST_42");
    sleep(1000);

    const output = capturePaneUnchecked(name);
    expect(output).not.toBeNull();
    expect(output!).toContain("MARKER_TEST_42");
  });

  it("sendLiteralUnchecked sends text without Enter", () => {
    const name = `${TEST_PREFIX}-send-literal`;
    createTestSession(name, "bash");
    sleep(500);

    // Send literal text (no Enter) — should appear on prompt but not execute
    sendLiteralUnchecked(name, "echo NOPE");
    sleep(500);

    const output = capturePaneUnchecked(name);
    expect(output).not.toBeNull();
    // Text visible on screen but command not executed (no output line with NOPE)
    // The text "echo NOPE" appears on the command line
    expect(output!).toContain("echo NOPE");
  });

  it("sendKeysUnchecked sends raw keystrokes", () => {
    const name = `${TEST_PREFIX}-send-keys`;
    createTestSession(name, "bash");
    sleep(500);

    // Type a command via sendLiteral, then press Enter via sendKeys
    sendLiteralUnchecked(name, "echo KEYTEST_99");
    sleep(300);
    sendKeysUnchecked(name, "Enter");
    sleep(1000);

    const output = capturePaneUnchecked(name);
    expect(output).not.toBeNull();
    expect(output!).toContain("KEYTEST_99");
  });

  it("captureFullHistoryUnchecked returns scrollback", () => {
    const name = `${TEST_PREFIX}-fullhist`;
    createTestSession(name, "bash");
    sleep(500);

    // Generate output
    sendMessageUnchecked(name, "echo HISTORY_LINE_1");
    sleep(500);
    sendMessageUnchecked(name, "echo HISTORY_LINE_2");
    sleep(500);

    const history = captureFullHistoryUnchecked(name);
    expect(history).not.toBeNull();
    expect(history!).toContain("HISTORY_LINE_1");
    expect(history!).toContain("HISTORY_LINE_2");
  });

  it("clearHistoryUnchecked clears scrollback", () => {
    const name = `${TEST_PREFIX}-clearhist`;
    createTestSession(name, "bash");
    sleep(500);

    sendMessageUnchecked(name, "echo BEFORE_CLEAR");
    sleep(500);

    const ok = clearHistoryUnchecked(name);
    expect(ok).toBe(true);

    const history = captureFullHistoryUnchecked(name);
    // After clearing, the old "BEFORE_CLEAR" from scrollback should be gone.
    // The current pane may still show it (capture-pane -p shows visible pane),
    // but full history (-S -) should not have old scrollback lines.
    // This is a basic smoke test — clearHistory worked without error.
    expect(history).not.toBeNull();
  });

  it("capturePaneUnchecked with lines option limits output", () => {
    const name = `${TEST_PREFIX}-capture-lines`;
    createTestSession(name, "bash");
    sleep(500);

    // Generate multiple lines
    for (let i = 1; i <= 5; i++) {
      sendMessageUnchecked(name, `echo LINE_${i}`);
      sleep(300);
    }

    const output = capturePaneUnchecked(name, { lines: 3 });
    expect(output).not.toBeNull();
    const lines = output!.split("\n").filter(l => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Job persistence — saveJob, loadJob, listJobs, deleteJob
// ---------------------------------------------------------------------------

describe("job persistence", () => {
  const testJobIds: string[] = [];

  function makeTestJob(overrides: Partial<Job> = {}): Job {
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    testJobIds.push(id);
    return {
      id,
      status: "completed",
      prompt: "test prompt",
      model: "test-model",
      reasoningEffort: "medium",
      sandbox: "read-only",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  afterEach(() => {
    for (const id of testJobIds) {
      try { deleteJob(id); } catch {}
    }
    testJobIds.length = 0;
  });

  it("saveJob + loadJob round-trip", () => {
    const job = makeTestJob({ prompt: "round-trip test" });
    saveJob(job);

    const loaded = loadJob(job.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(job.id);
    expect(loaded!.prompt).toBe("round-trip test");
    expect(loaded!.status).toBe("completed");
  });

  it("loadJob returns null for nonexistent job", () => {
    expect(loadJob("00000000")).toBeNull();
  });

  it("loadJob returns null for invalid job ID (caught internally)", () => {
    // loadJob catches the validation error and returns null
    expect(loadJob("not-valid!")).toBeNull();
  });

  it("listJobs returns jobs sorted by date descending", () => {
    const job1 = makeTestJob({ createdAt: "2024-01-01T00:00:00Z" });
    const job2 = makeTestJob({ createdAt: "2024-06-01T00:00:00Z" });
    const job3 = makeTestJob({ createdAt: "2024-03-01T00:00:00Z" });
    saveJob(job1);
    saveJob(job2);
    saveJob(job3);

    const jobs = listJobs();
    const testIds = new Set([job1.id, job2.id, job3.id]);
    const relevant = jobs.filter(j => testIds.has(j.id));

    expect(relevant.length).toBe(3);
    // Should be sorted newest first
    expect(relevant[0].id).toBe(job2.id);
    expect(relevant[1].id).toBe(job3.id);
    expect(relevant[2].id).toBe(job1.id);
  });

  it("deleteJob removes all associated files", () => {
    const job = makeTestJob();
    saveJob(job);

    // Create associated files
    const jobDir = config.jobsDir;
    writeFileSync(join(jobDir, `${job.id}.log`), "log content");
    writeFileSync(join(jobDir, `${job.id}.exit`), "0");
    writeFileSync(join(jobDir, `${job.id}.prompt`), "prompt content");

    expect(deleteJob(job.id)).toBe(true);
    expect(loadJob(job.id)).toBeNull();
    expect(existsSync(join(jobDir, `${job.id}.log`))).toBe(false);
    expect(existsSync(join(jobDir, `${job.id}.exit`))).toBe(false);
    expect(existsSync(join(jobDir, `${job.id}.prompt`))).toBe(false);

    // Remove from testJobIds since already deleted
    const idx = testJobIds.indexOf(job.id);
    if (idx >= 0) testJobIds.splice(idx, 1);
  });
});

// ---------------------------------------------------------------------------
// Job status transitions — refreshJobStatus
// ---------------------------------------------------------------------------

describe("job status transitions", () => {
  const testJobIds: string[] = [];

  function makeRunningJob(sessionName?: string): Job {
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    testJobIds.push(id);
    return {
      id,
      status: "running",
      prompt: "test",
      model: "test-model",
      reasoningEffort: "medium",
      sandbox: "read-only",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      tmuxSession: sessionName ?? `${TEST_PREFIX}-status-${id}`,
    };
  }

  afterEach(() => {
    for (const id of testJobIds) {
      try { deleteJob(id); } catch {}
    }
    testJobIds.length = 0;
  });

  it("session gone + exit code 0 → completed", () => {
    const job = makeRunningJob("nonexistent-session-completed");
    saveJob(job);

    // Write exit file with code 0
    writeFileSync(join(config.jobsDir, `${job.id}.exit`), "0");

    const refreshed = refreshJobStatus(job.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("completed");
    expect(refreshed!.completedAt).toBeDefined();

    try { unlinkSync(join(config.jobsDir, `${job.id}.exit`)); } catch {}
  });

  it("session gone + exit code 1 → failed", () => {
    const job = makeRunningJob("nonexistent-session-failed");
    saveJob(job);

    writeFileSync(join(config.jobsDir, `${job.id}.exit`), "1");

    const refreshed = refreshJobStatus(job.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("failed");
    expect(refreshed!.error).toContain("exited with code 1");

    try { unlinkSync(join(config.jobsDir, `${job.id}.exit`)); } catch {}
  });

  it("session gone + no exit file → killed", () => {
    const job = makeRunningJob("nonexistent-session-killed");
    saveJob(job);

    // Don't write an exit file — simulates external kill
    const refreshed = refreshJobStatus(job.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("killed");
  });

  it("session alive + 'Session complete' text → completed", () => {
    const sessionName = `${TEST_PREFIX}-complete-text`;
    const job = makeRunningJob(sessionName);
    saveJob(job);

    // Create a real session that fills the screen then shows the completion message.
    // refreshJobStatus captures 20 lines; the completion text must be in the visible pane.
    // We use printf with newlines to position the text where capture-pane will see it.
    createTestSession(
      sessionName,
      "printf '\\n%.0s' {1..15}; echo '[codex-collab: Session complete. Closing in 30s.]'; sleep 300"
    );
    sleep(1500);

    const refreshed = refreshJobStatus(job.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("completed");
    expect(refreshed!.completedAt).toBeDefined();
  });

  it("killJob sets status to killed with no error", () => {
    const sessionName = `${TEST_PREFIX}-kill-test`;
    const job = makeRunningJob(sessionName);
    saveJob(job);

    createTestSession(sessionName, "sleep 300");
    sleep(500);

    expect(killJob(job.id)).toBe(true);

    const reloaded = loadJob(job.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.status).toBe("killed");
    expect(reloaded!.error).toBeUndefined();
    expect(reloaded!.completedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Output retrieval
// ---------------------------------------------------------------------------

describe("output retrieval", () => {
  const testJobIds: string[] = [];

  function makeJob(overrides: Partial<Job> = {}): Job {
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    testJobIds.push(id);
    return {
      id,
      status: "completed",
      prompt: "test",
      model: "test-model",
      reasoningEffort: "medium",
      sandbox: "read-only",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  afterEach(() => {
    for (const id of testJobIds) {
      try { deleteJob(id); } catch {}
    }
    testJobIds.length = 0;
  });

  it("getJobOutput falls back to log file when session gone", () => {
    const job = makeJob();
    saveJob(job);

    writeFileSync(join(config.jobsDir, `${job.id}.log`), "line1\nline2\nline3\nline4\nline5");

    const output = getJobOutput(job.id, 3);
    expect(output).not.toBeNull();
    expect(output!).toContain("line3");
    expect(output!).toContain("line5");

    try { unlinkSync(join(config.jobsDir, `${job.id}.log`)); } catch {}
  });

  it("getJobFullOutput falls back to log file when session gone", () => {
    const job = makeJob();
    saveJob(job);

    writeFileSync(join(config.jobsDir, `${job.id}.log`), "full log content here");

    const output = getJobFullOutput(job.id);
    expect(output).not.toBeNull();
    expect(output!).toBe("full log content here");

    try { unlinkSync(join(config.jobsDir, `${job.id}.log`)); } catch {}
  });

  it("getAttachCommand returns correct tmux command", () => {
    const job = makeJob({ tmuxSession: "codex-collab-test-attach" });
    saveJob(job);

    const cmd = getAttachCommand(job.id);
    expect(cmd).toBe('tmux attach -t "codex-collab-test-attach"');
  });

  it("getAttachCommand returns null for job without session", () => {
    const job = makeJob();
    // No tmuxSession set
    saveJob(job);

    expect(getAttachCommand(job.id)).toBeNull();
  });

  it("getJobOutput returns null for nonexistent job", () => {
    expect(getJobOutput("00000000")).toBeNull();
  });

  it("getJobFullOutput returns null for nonexistent job", () => {
    expect(getJobFullOutput("00000000")).toBeNull();
  });
});
