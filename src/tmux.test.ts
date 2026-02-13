// Integration tests for tmux session management
//
// These tests exercise the real tmux + shell command pipeline.
// They require tmux to be available and create short-lived sessions.

import { describe, it, expect, afterEach, setDefaultTimeout } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

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
    "new-session", "-d", "-s", name, "-x", "120", "-y", "20", cmd,
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
