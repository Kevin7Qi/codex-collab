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
 * Wait for a terminated process tree to actually be gone.
 *
 * `terminateProcessTree` only *sends* signals — it returns while the tree is
 * still shutting down. That matters because codex's app-server holds an
 * exclusive lock on the shared sqlite state under CODEX_HOME while it exits:
 * spawning a replacement inside that window dies with a state-runtime error.
 * Waiting first turns "terminate, immediately respawn" into a safe sequence.
 *
 * Polls the process GROUP on Unix — callers spawn detached, so the pid is the
 * group leader and the app-server is a group member that can outlive it.
 *
 * On Windows it polls that ONE pid, which is weaker than the name suggests and
 * adequate only because the tree cannot outlive it there: `connectDirect`
 * detaches on Unix only, so the app-server is a plain child, and the matching
 * `terminateProcessTree` is a synchronous `taskkill /T /F` that has already
 * taken the whole tree down by the time this is called. If either of those
 * changes, this needs a real tree walk on Windows.
 *
 * Best effort by design: returns false on timeout instead of throwing, because
 * proceeding without the guarantee still beats failing outright.
 */
export async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  const treeAlive = (): boolean => {
    if (isWindows) return isProcessAlive(pid);
    try {
      process.kill(-pid, 0);
      return true;
    } catch (e) {
      // EPERM: the group exists but is not ours to signal — treat as alive.
      if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
      // ESRCH on the group only means `pid` leads no group; the process
      // itself may still be running, so fall through to the direct check.
    }
    return isProcessAlive(pid);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!treeAlive()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return !treeAlive();
}

/**
 * True when the process group led by `pid` still has a live member.
 *
 * The group outliving its leader is the normal case here, not an edge one: the
 * app-server is spawned detached as a group leader and its tool subprocesses
 * are members, so a leader that exits on SIGTERM can leave members behind.
 * A pgid stays reserved while any member lives, so a live group is never a
 * recycled id — which is why escalating against one needs no identity check.
 */
function groupAlive(pid: number): boolean {
  if (isWindows) return false; // no process groups; taskkill /T covers the tree
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    // EPERM: the group exists but is not ours to signal — treat as alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best-effort identity token for a running PID — its start time.
 *
 * PIDs are recycled. A delayed SIGKILL that fires after its target already
 * exited would otherwise land on whatever process inherited the number, and
 * the wider the grace the likelier that is. One-second resolution, so a PID
 * reused within the same second still matches; that is a far smaller window
 * than the grace itself.
 */
function processStartToken(pid: number): string | null {
  if (isWindows) return null;
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (r.error || r.status !== 0) return null;
    const t = (r.stdout ?? "").trim();
    return t === "" ? null : t;
  } catch {
    return null;
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
 *   SIGKILL after `graceMs` (default 500 ms — long enough for the app-server
 *   to flush stdout). The SIGKILL timer is unref'd so it never blocks
 *   process exit.
 * - Windows: uses `taskkill /PID <pid> /T /F`.
 *
 * Pass a longer `graceMs` when the target's SIGTERM handler has real work to
 * do before it can exit. The broker is the case that matters: its handler
 * closes the app-server it spawned and waits for that process group to go
 * away, so escalating at the default would kill the broker mid-shutdown and
 * strand the very process the caller is waiting on.
 *
 * `graceMs` is Unix-only and ignored on Windows: `taskkill /F` terminates
 * without running handlers, so there is no shutdown to protect. Nothing is
 * stranded either — the app-server is a plain child there (connectDirect only
 * detaches on Unix), so `/T` takes the whole tree down together.
 *
 * If the process is already dead (ESRCH), this is a no-op.
 */
export function terminateProcessTree(pid: number, graceMs = 500): void {
  if (isWindows) {
    terminateWindows(pid);
  } else {
    terminateUnix(pid, graceMs);
  }
}

// ─── internal ──────────────────────────────────────────────────────────────

function terminateUnix(pid: number, graceMs = 500): void {
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

  // If anything survives the grace period, escalate to SIGKILL. What we are
  // escalating against is the GROUP, so the leader's own liveness is not the
  // question — a leader that exits while a descendant ignores SIGTERM leaves
  // a group that still needs killing.
  if (isProcessAlive(pid) || groupAlive(pid)) {
    // Inside the liveness check: this shells out to `ps` synchronously, and
    // a PID that is already gone needs no identity to compare against later.
    const identity = processStartToken(pid);
    const timer = setTimeout(() => {
      // Re-verify before escalating. The target usually exits during the
      // grace, and killing a recycled PID would take out an unrelated
      // process — a real risk once the grace is measured in seconds.
      //
      // Only a LIVE leader can be a recycled pid, so only it needs the
      // identity check. If the leader is gone but its group is not, the pgid
      // is still reserved by the surviving members and is safe to signal —
      // suppressing there would strand exactly the descendants this escalation
      // exists to reap.
      if (isProcessAlive(pid)) {
        if (identity !== null && processStartToken(pid) !== identity) return;
      } else if (!groupAlive(pid)) {
        return;
      }
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
    }, graceMs);
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
