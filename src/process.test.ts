import { describe, expect, test } from "bun:test";
import { terminateProcessTree, isProcessAlive, waitForProcessTreeExit } from "./process";
import { spawn } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── terminateProcessTree ──────────────────────────────────────────────────

describe("terminateProcessTree", () => {
  test("kills a spawned process", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    terminateProcessTree(pid);

    // Wait for exit
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(resolve, 2000);
    });

    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("does not throw for non-existent PID", () => {
    expect(() => terminateProcessTree(99999999)).not.toThrow();
  });

  test("a longer grace lets a SIGTERM handler finish before SIGKILL", async () => {
    // The broker's SIGTERM handler reaps its app-server before exiting. At
    // the default 500ms grace it would be killed mid-reap, stranding the
    // process holding codex's sqlite state — the failure this parameter
    // exists to prevent.
    if (process.platform === "win32") return; // taskkill /F has no grace to tune
    const marker = join(tmpdir(), `grace-test-${process.pid}-${Date.now()}`);
    const child = spawn(
      "bash",
      ["-c", `trap 'sleep 1; echo done > "${marker}"; exit 0' TERM; sleep 30 & wait`],
      { stdio: "ignore", detached: true },
    );
    const pid = child.pid!;
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the trap install
      terminateProcessTree(pid, 4000);
      await waitForProcessTreeExit(pid, 6000);
      expect(existsSync(marker)).toBe(true);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      rmSync(marker, { force: true });
    }
  }, 20000);
});

// ─── waitForProcessTreeExit ────────────────────────────────────────────────

describe("waitForProcessTreeExit", () => {
  test("returns true immediately for a PID that is already gone", async () => {
    const started = Date.now();
    expect(await waitForProcessTreeExit(99999999, 2000)).toBe(true);
    // Nothing to wait for, so it must not burn the deadline.
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("returns false when the tree outlives the deadline", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
    const pid = child.pid!;
    try {
      expect(await waitForProcessTreeExit(pid, 200)).toBe(false);
    } finally {
      terminateProcessTree(pid);
    }
  });

  test("returns true once a terminated tree is actually gone", async () => {
    // The point of the helper: terminateProcessTree only SENDS signals, so a
    // caller that respawns on the next line races the dying process. Awaiting
    // this makes "terminated" mean "exited".
    const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
    const pid = child.pid!;
    child.unref();

    terminateProcessTree(pid);
    expect(await waitForProcessTreeExit(pid, 3000)).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("terminating a parent takes its child with it", async () => {
    // The premise the broker fallback rests on, and the one thing that differs
    // by platform: Unix reaches the child through the process group, Windows
    // through `taskkill /T`. Assert the OUTCOME so both mechanisms are covered
    // — this is the only Windows-executed test of that guarantee.
    const pidFile = join(tmpdir(), `child-pid-${process.pid}-${Date.now()}`);
    const parent = spawn(
      "bun",
      ["-e", `const c = Bun.spawn(["sleep", "60"]); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`],
      { stdio: "ignore", detached: process.platform !== "win32" },
    );
    const parentPid = parent.pid!;
    try {
      let childPid = 0;
      for (let i = 0; i < 100 && !childPid; i++) {
        if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, "utf-8").trim());
        if (!childPid) await new Promise((r) => setTimeout(r, 50));
      }
      expect(childPid).toBeGreaterThan(0);

      terminateProcessTree(parentPid, 2000);
      await waitForProcessTreeExit(parentPid, 5000);

      let childAlive = true;
      for (let i = 0; i < 40 && childAlive; i++) {
        childAlive = isProcessAlive(childPid);
        if (childAlive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(childAlive).toBe(false);
    } finally {
      try { process.kill(parentPid, "SIGKILL"); } catch {}
      rmSync(pidFile, { force: true });
    }
  }, 30000);

  test("reports a single terminated process as gone on every platform", async () => {
    // Windows has no process groups, so waitForProcessTreeExit degrades to a
    // one-PID check there. Pin that it still answers correctly — the Unix
    // group probe must not be the only path that works.
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid!;
    terminateProcessTree(pid);
    expect(await waitForProcessTreeExit(pid, 5000)).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);
  }, 20000);

  test("waits for a group member that outlives the leader", async () => {
    // The app-server is a group MEMBER, not the leader we hold a PID for.
    // Probing only the leader would report "gone" while the process still
    // holding codex's sqlite state is alive — the exact race being closed.
    if (process.platform === "win32") return; // no process groups
    const leader = spawn(
      "bash",
      ["-c", "sleep 30 & sleep 0.2"],
      { stdio: "ignore", detached: true },
    );
    const pgid = leader.pid!;
    try {
      // Leader exits after ~200ms; the backgrounded child keeps the group
      // alive, so a 1s wait must still report the tree as present.
      expect(await waitForProcessTreeExit(pgid, 1000)).toBe(false);
    } finally {
      terminateProcessTree(pgid);
    }
  });
});

// ─── isProcessAlive ────────────────────────────────────────────────────────

describe("isProcessAlive", () => {
  test("returns true for own process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });

  test("treats EPERM as alive (PID 1 on Linux as non-root)", () => {
    // PID 1 (init/systemd) is always alive but owned by root.
    // As non-root, kill(1, 0) throws EPERM — should still report alive.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(isProcessAlive(1)).toBe(true);
    }
  });
});

describe("escalation reaches a group that outlived its leader", () => {
  test("a descendant ignoring SIGTERM is still SIGKILLed after the grace", async () => {
    // The app-server is a detached group LEADER whose tool subprocesses are
    // members, so "leader exited, group did not" is the normal shape of a
    // stuck tree — and gating escalation on the leader's own liveness strands
    // exactly the descendant the escalation exists to reap.
    if (process.platform === "win32") return; // no process groups
    const pidFile = join(tmpdir(), `grouped-child-${process.pid}-${Date.now()}`);
    // Leader backgrounds a TERM-ignoring child into its own group, records the
    // child's pid, then exits — leaving the group alive without its leader.
    const leader = spawn(
      "bash",
      ["-c", `bun -e 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)' & echo $! > "${pidFile}"; exit 0`],
      { stdio: "ignore", detached: true },
    );
    const pgid = leader.pid!;
    let childPid = 0;
    try {
      for (let i = 0; i < 100 && !childPid; i++) {
        if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, "utf-8").trim());
        if (!childPid) await new Promise((r) => setTimeout(r, 50));
      }
      expect(childPid).toBeGreaterThan(0);
      // Let the leader exit and the child install its handler.
      await new Promise((r) => setTimeout(r, 600));
      expect(isProcessAlive(pgid)).toBe(false); // leader really is gone
      expect(isProcessAlive(childPid)).toBe(true); // group really is not

      terminateProcessTree(pgid, 300);

      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        alive = isProcessAlive(childPid);
        if (alive) await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive).toBe(false);
    } finally {
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch {} }
      try { process.kill(-pgid, "SIGKILL"); } catch {}
      rmSync(pidFile, { force: true });
    }
  }, 30000);
});

describe("delayed SIGKILL identity check", () => {
  test("a process that exits during the grace is not escalated against", async () => {
    // The escalation timer outlives its target. Without an identity check it
    // would SIGKILL whatever inherited the PID — a real hazard once the grace
    // is seconds rather than milliseconds.
    if (process.platform === "win32") return; // taskkill is immediate, no timer
    const child = spawn("bash", ["-c", "exit 0"], { stdio: "ignore", detached: true });
    const pid = child.pid!;
    await new Promise<void>((r) => child.on("exit", () => r()));
    // Schedule an escalation against an already-dead PID; it must not throw
    // and must not signal anything when the timer fires.
    expect(() => terminateProcessTree(pid, 150)).not.toThrow();
    await new Promise((r) => setTimeout(r, 400));
    expect(isProcessAlive(process.pid)).toBe(true); // we are still here
  }, 20000);
});
