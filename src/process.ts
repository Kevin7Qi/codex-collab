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
 * Kill a process and its children.
 *
 * - Unix: sends SIGTERM first; if the process is still alive, schedules
 *   SIGKILL after 100 ms.
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
  } catch {
    // Group kill failed (ESRCH or EPERM) — fall through to individual.
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
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process already gone — nothing to do.
        }
      }
    }, 100);
  }
}

function terminateWindows(pid: number): void {
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      timeout: 5000,
      windowsHide: true,
      shell: true,
    });
  } catch {
    // Best-effort — process may already be gone.
  }
}

function isEsrch(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ESRCH"
  );
}
