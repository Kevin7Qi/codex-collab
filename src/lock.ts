// src/lock.ts — Advisory file locks shared by threads.ts (sync) and broker.ts (async)
//
// Semantics shared by both variants:
// - Acquisition creates `lockPath` with O_CREAT|O_EXCL and spins with
//   30-70ms jitter on contention.
// - A lock older than the stale threshold (likely orphaned by a crashed
//   process) is broken via rename to a unique tombstone. rename is atomic,
//   so when several contenders decide the same lock is stale exactly one
//   wins the break — the unlink-then-recreate approach this replaces let
//   two contenders both "acquire" (the second unlink removed the first
//   winner's fresh lock).
// - The stale check runs inside the retry loop, so a crashed holder costs
//   one retry interval, not the full spin, before recovery.
// - release() only unlinks the lock file while it is still the one this
//   process created (verified via inode), so a release after a stale-break
//   cannot delete the breaker's live lock.

import { openSync, closeSync, unlinkSync, statSync, fstatSync, renameSync } from "fs";
import { randomBytes } from "crypto";

export interface LockOptions {
  /** Max acquisition attempts (default 600 ≈ 30s at 50ms average sleep). */
  maxAttempts?: number;
  /** Age beyond which a held lock is considered orphaned (default 60s). */
  staleThresholdMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 600;
const DEFAULT_STALE_THRESHOLD_MS = 60_000;

/** Acquisition gave up while another process legitimately held the lock. */
export class LockTimeoutError extends Error {
  constructor(lockPath: string, heldForMs: number | null) {
    super(
      heldForMs !== null
        ? `lock held for ${Math.round(heldForMs / 1000)}s (not yet stale)`
        : "lock is contended",
    );
    this.name = "LockTimeoutError";
  }
}

/** Open the lock file exclusively. Returns the fd, or null when it exists.
 *  Unexpected filesystem errors propagate. */
function tryOpen(lockPath: string): number | null {
  try {
    return openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
}

/** Age of the lock file in ms, or null if it cannot be statted. */
function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Break the lock iff it is older than the stale threshold. Rename-to-
 *  tombstone guarantees a single winner; losers see ENOENT and just retry. */
function tryBreakStaleLock(lockPath: string, staleThresholdMs: number): void {
  const age = lockAgeMs(lockPath);
  if (age === null || age < staleThresholdMs) return;
  const tombstone = `${lockPath}.stale-${process.pid}-${randomBytes(3).toString("hex")}`;
  try {
    renameSync(lockPath, tombstone);
  } catch {
    return; // another contender broke it (or the holder released) — retry normally
  }
  try {
    unlinkSync(tombstone);
  } catch {
    // Leaving a tombstone behind is harmless — it has a unique name.
  }
}

function makeRelease(fd: number, lockPath: string): () => void {
  return () => {
    // Verify the lock file on disk is still the one we created before
    // unlinking — after a stale-break it belongs to the breaking process.
    let stillOurs = true;
    try {
      const held = fstatSync(fd);
      const onDisk = statSync(lockPath);
      stillOurs = held.ino === onDisk.ino && held.dev === onDisk.dev;
    } catch {
      stillOurs = false; // gone or unreadable — nothing for us to unlink
    }
    try {
      closeSync(fd);
    } catch (e) {
      console.error(`[codex] Warning: lock fd close failed: ${(e as Error).message}`);
    }
    if (!stillOurs) return;
    try {
      unlinkSync(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: lock cleanup failed: ${(e as Error).message}`);
      }
    }
  };
}

/**
 * Acquire the lock, blocking the thread between attempts (Bun.sleepSync).
 * Returns a release function. Throws LockTimeoutError when a live holder
 * outlasts the spin; propagates unexpected filesystem errors.
 */
export function acquireLockSync(lockPath: string, opts?: LockOptions): () => void {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleThresholdMs = opts?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  for (let i = 0; i < maxAttempts; i++) {
    const fd = tryOpen(lockPath);
    if (fd !== null) return makeRelease(fd, lockPath);
    tryBreakStaleLock(lockPath, staleThresholdMs);
    Bun.sleepSync(30 + Math.random() * 40);
  }
  throw new LockTimeoutError(lockPath, lockAgeMs(lockPath));
}

/**
 * Acquire the lock without blocking the event loop between attempts —
 * signal handlers and timers keep running during contention (the sync
 * variant's Bun.sleepSync spin blocks them for up to the full 30s).
 */
export async function acquireLockAsync(lockPath: string, opts?: LockOptions): Promise<() => void> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleThresholdMs = opts?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  for (let i = 0; i < maxAttempts; i++) {
    const fd = tryOpen(lockPath);
    if (fd !== null) return makeRelease(fd, lockPath);
    tryBreakStaleLock(lockPath, staleThresholdMs);
    await Bun.sleep(30 + Math.random() * 40);
  }
  throw new LockTimeoutError(lockPath, lockAgeMs(lockPath));
}
