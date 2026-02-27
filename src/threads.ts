// src/threads.ts — Thread lifecycle and short ID mapping

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import type { ThreadMapping } from "./types";

/**
 * Acquire an advisory file lock using O_CREAT|O_EXCL on a .lock file.
 * Returns a release function. Spins with short sleeps on contention.
 *
 * If the lock cannot be acquired after ~30s, checks the lock file age.
 * Only force-breaks locks older than 60s (likely orphaned by a crashed process).
 */
function acquireLock(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  const maxAttempts = 600; // ~30s at 50ms avg sleep
  const staleLockThresholdMs = 60_000;
  let fd: number | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`Cannot create lock file ${lockPath}: ${(e as Error).message}`);
      }
      Bun.sleepSync(30 + Math.random() * 40);
    }
  }
  if (fd === undefined) {
    // Check if lock is stale (older than threshold)
    try {
      const stat = statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < staleLockThresholdMs) {
        throw new Error(
          `Cannot acquire lock on ${filePath}: lock held for ${Math.round(ageMs / 1000)}s (not yet stale). ` +
          `If this persists, manually delete ${lockPath}`,
        );
      }
      // Lock is stale — force acquire with O_EXCL after unlink
      unlinkSync(lockPath);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Cannot acquire lock")) throw e;
      // statSync/unlinkSync failed (e.g. ENOENT race) — retry once with O_EXCL
    }
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      throw new Error(`Cannot acquire lock on ${filePath} after ${maxAttempts} attempts`);
    }
  }

  return () => {
    try { closeSync(fd!); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: lock fd close failed: ${(e as Error).message}`);
      }
    }
    try { unlinkSync(lockPath); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: lock cleanup failed: ${(e as Error).message}`);
      }
    }
  };
}

/** Acquire the thread file lock, run fn, then release. */
export function withThreadLock<T>(threadsFile: string, fn: () => T): T {
  const release = acquireLock(threadsFile);
  try {
    return fn();
  } finally {
    release();
  }
}

export function generateShortId(): string {
  return randomBytes(4).toString("hex");
}

export function loadThreadMapping(threadsFile: string): ThreadMapping {
  if (!existsSync(threadsFile)) return {};
  let content: string;
  try {
    content = readFileSync(threadsFile, "utf-8");
  } catch (e) {
    throw new Error(`Cannot read threads file ${threadsFile}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("[codex] Warning: threads file has invalid structure. Starting fresh.");
      try {
        renameSync(threadsFile, `${threadsFile}.corrupt.${Date.now()}`);
      } catch (backupErr) {
        console.error(`[codex] Warning: could not back up invalid threads file: ${backupErr instanceof Error ? backupErr.message : backupErr}`);
      }
      return {};
    }
    return parsed;
  } catch (e) {
    console.error(
      `[codex] Warning: threads file is corrupted (${e instanceof Error ? e.message : e}). Thread history may be incomplete.`,
    );
    try {
      renameSync(threadsFile, `${threadsFile}.corrupt.${Date.now()}`);
    } catch (backupErr) {
      console.error(`[codex] Warning: could not back up corrupt threads file: ${backupErr instanceof Error ? backupErr.message : backupErr}`);
    }
    return {};
  }
}

export function saveThreadMapping(threadsFile: string, mapping: ThreadMapping): void {
  const dir = dirname(threadsFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = threadsFile + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(mapping, null, 2), { mode: 0o600 });
  renameSync(tmpPath, threadsFile);
}

export function registerThread(
  threadsFile: string,
  threadId: string,
  meta?: { model?: string; cwd?: string },
): ThreadMapping {
  return withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    let shortId = generateShortId();
    while (shortId in mapping) shortId = generateShortId();
    mapping[shortId] = {
      threadId,
      createdAt: new Date().toISOString(),
      model: meta?.model,
      cwd: meta?.cwd,
    };
    saveThreadMapping(threadsFile, mapping);
    return mapping;
  });
}

export function resolveThreadId(threadsFile: string, idOrPrefix: string): string {
  const mapping = loadThreadMapping(threadsFile);

  // Exact match
  if (mapping[idOrPrefix]) return mapping[idOrPrefix].threadId;

  // Prefix match
  const matches = Object.entries(mapping).filter(([k]) => k.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0][1].threadId;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idOrPrefix}" — matches: ${matches.map(([k]) => k).join(", ")}`,
    );
  }

  throw new Error(`Thread not found: "${idOrPrefix}"`);
}

export function findShortId(threadsFile: string, threadId: string): string | null {
  const mapping = loadThreadMapping(threadsFile);
  for (const [shortId, entry] of Object.entries(mapping)) {
    if (entry.threadId === threadId) return shortId;
  }
  return null;
}

export function updateThreadStatus(
  threadsFile: string,
  threadId: string,
  status: "running" | "completed" | "failed" | "interrupted" | "killed",
): void {
  withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    let found = false;
    for (const entry of Object.values(mapping)) {
      if (entry.threadId === threadId) {
        entry.lastStatus = status;
        entry.updatedAt = new Date().toISOString();
        found = true;
        break;
      }
    }
    if (!found) {
      console.error(`[codex] Warning: cannot update status for unknown thread ${threadId.slice(0, 12)}...`);
      return;
    }
    saveThreadMapping(threadsFile, mapping);
  });
}

export function removeThread(threadsFile: string, shortId: string): void {
  withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    delete mapping[shortId];
    saveThreadMapping(threadsFile, mapping);
  });
}
