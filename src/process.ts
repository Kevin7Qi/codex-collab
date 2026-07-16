/**
 * Platform-aware process tree termination utilities.
 *
 * Used by the broker for cleanup and by the kill command for interrupt fallback.
 */

import { spawnSync } from "child_process";

const isWindows = process.platform === "win32";

/** Check whether a process with the given PID is still running. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we lack permission to signal it
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/**
 * Best-effort check that `pid` names a Bun process (the broker server runs
 * under bun). Guards PID-recycling misclassification when deciding whether a
 * version-mismatched broker is still alive WITHOUT touching its socket (a
 * probe connect would reset its idle timer). Asymmetric failure handling: a
 * false "yes" only costs a direct connection, while a false "no" would let
 * the spawn path clear artifacts under a live broker — so indeterminate
 * answers (ps unavailable, Windows) return true.
 */
export function processLooksLikeBun(pid: number): boolean {
  if (isWindows) return true; // tasklist filtering is slow and localized — accept the PID check alone
  try {
    const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (r.error) return true; // ps itself failed — indeterminate
    if (r.status !== 0) return false; // no such process
    const comm = (r.stdout ?? "").trim().toLowerCase();
    return comm === "" ? true : comm.includes("bun");
  } catch {
    return true;
  }
}

/**
 * Kill a process and its children.
 *
 * - Unix: sends SIGTERM first; if the process is still alive, schedules
 *   SIGKILL after 500 ms (long enough for the app-server to flush stdout).
 *   The SIGKILL timer is unref'd so it never blocks process exit.
 * - Windows: uses `taskkill /PID <pid> /T /F`.
 *
 * If the process is already dead (ESRCH), this is a no-op.
 */
export function terminateProcessTree(pid: number): void {
  if (isWindows) {
    terminateWindows(pid);
  } else {
    terminateUnix(pid);
  }
}

// ─── internal ──────────────────────────────────────────────────────────────

function terminateUnix(pid: number): void {
  // Try the process group first (negative pid), then the process itself.
  // ESRCH on the group kill does NOT mean the process is dead — it just
  // means the pid is not a process-group leader.
  let sent = false;
  try {
    process.kill(-pid, "SIGTERM");
    sent = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      console.error(`[codex] Warning: group kill failed: ${(e as Error).message}`);
    }
  }

  if (!sent) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: unknown) {
      if (isEsrch(err)) return; // process truly gone
      throw err;
    }
  }

  // If still alive after a short grace period, escalate to SIGKILL.
  if (isProcessAlive(pid)) {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") {
          console.error(`[codex] Warning: group SIGKILL failed: ${(e as Error).message}`);
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch (e2) {
          const code2 = (e2 as NodeJS.ErrnoException).code;
          if (code2 !== "ESRCH" && code2 !== "EPERM") {
            console.error(`[codex] Warning: SIGKILL failed: ${(e2 as Error).message}`);
          }
        }
      }
    }, 500);
    // Don't keep the event loop alive waiting for an escalation that may
    // never be needed — caller may exit before the timer fires.
    timer.unref?.();
  }
}

function terminateWindows(pid: number): void {
  try {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status !== 0) {
      const stderr = r.stderr?.toString().trim();
      console.error(`[codex] Warning: taskkill exited with code ${r.status}${stderr ? `: ${stderr}` : ""}`);
    }
  } catch (e) {
    console.error(`[codex] Warning: process termination failed: ${(e as Error).message}`);
  }
}

function isEsrch(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ESRCH"
  );
}
