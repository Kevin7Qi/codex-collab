// src/threads.ts — Thread index, run ledger, and resume candidate
//
// Two-layer model:
//   1. Thread Index  — maps short IDs to thread metadata ({stateDir}/threads.json)
//   2. Run Ledger    — per-execution records ({stateDir}/runs/{runId}.json)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  openSync, closeSync, unlinkSync, statSync, readdirSync, rmSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { config, validateId } from "./config";
import type { ThreadIndex, ThreadIndexEntry, RunRecord, ThreadMapping } from "./types";

// ─── Advisory file lock ────────────────────────────────────────────────────

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
export function withThreadLock<T>(filePath: string, fn: () => T): T {
  const release = acquireLock(filePath);
  try {
    return fn();
  } finally {
    release();
  }
}

// ─── Short ID generation ───────────────────────────────────────────────────

export function generateShortId(): string {
  return randomBytes(4).toString("hex");
}

// ─── Thread Index ──────────────────────────────────────────────────────────

function threadsFilePath(stateDir: string): string {
  return join(stateDir, "threads.json");
}

export function loadThreadIndex(stateDir: string): ThreadIndex {
  const filePath = threadsFilePath(stateDir);
  if (!existsSync(filePath)) return {};
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    throw new Error(`Cannot read threads file ${filePath}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error("[codex] Warning: threads file has invalid structure. Starting fresh.");
      try {
        renameSync(filePath, `${filePath}.corrupt.${Date.now()}`);
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
      renameSync(filePath, `${filePath}.corrupt.${Date.now()}`);
    } catch (backupErr) {
      console.error(`[codex] Warning: could not back up corrupt threads file: ${backupErr instanceof Error ? backupErr.message : backupErr}`);
    }
    return {};
  }
}

export function saveThreadIndex(stateDir: string, index: ThreadIndex): void {
  const filePath = threadsFilePath(stateDir);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function registerThread(
  stateDir: string,
  threadId: string,
  meta?: Partial<ThreadIndexEntry>,
): string {
  validateId(threadId);
  const filePath = threadsFilePath(stateDir);
  return withThreadLock(filePath, () => {
    const index = loadThreadIndex(stateDir);
    let shortId = generateShortId();
    while (shortId in index) shortId = generateShortId();
    const now = new Date().toISOString();
    index[shortId] = {
      threadId,
      name: meta?.name ?? null,
      model: meta?.model ?? null,
      cwd: meta?.cwd ?? process.cwd(),
      createdAt: meta?.createdAt ?? now,
      updatedAt: meta?.updatedAt ?? now,
    };
    saveThreadIndex(stateDir, index);
    return shortId;
  });
}

/**
 * Resolve a user-provided ID to { shortId, threadId }.
 *
 * Resolution order:
 * 1. Exact short ID match
 * 2. Prefix match on short IDs (error if ambiguous)
 * 3. If starts with "thr_", search index values for matching threadId
 * 4. Otherwise, return null
 */
export function resolveThreadId(
  stateDir: string,
  id: string,
): { shortId: string; threadId: string } | null {
  const index = loadThreadIndex(stateDir);

  // 1. Exact short ID match
  if (index[id]) return { shortId: id, threadId: index[id].threadId };

  // 2. Prefix match
  const prefixMatches = Object.entries(index).filter(([k]) => k.startsWith(id));
  if (prefixMatches.length === 1) {
    return { shortId: prefixMatches[0][0], threadId: prefixMatches[0][1].threadId };
  }
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${id}" — matches: ${prefixMatches.map(([k]) => k).join(", ")}`,
    );
  }

  // 3. Full thread ID lookup (thr_ prefix)
  if (id.startsWith("thr_")) {
    for (const [shortId, entry] of Object.entries(index)) {
      if (entry.threadId === id) return { shortId, threadId: entry.threadId };
    }
  }

  // 4. Not found
  return null;
}

export function findShortId(stateDir: string, threadId: string): string | null {
  const index = loadThreadIndex(stateDir);
  for (const [shortId, entry] of Object.entries(index)) {
    if (entry.threadId === threadId) return shortId;
  }
  return null;
}

export function updateThreadMeta(
  stateDir: string,
  shortId: string,
  patch: Partial<ThreadIndexEntry>,
): void {
  const filePath = threadsFilePath(stateDir);
  withThreadLock(filePath, () => {
    const index = loadThreadIndex(stateDir);
    if (!index[shortId]) {
      console.error(`[codex] Warning: cannot update metadata for unknown short ID ${shortId}`);
      return;
    }
    const entry = index[shortId];
    if (patch.name !== undefined) entry.name = patch.name;
    if (patch.model !== undefined) entry.model = patch.model;
    if (patch.cwd !== undefined) entry.cwd = patch.cwd;
    entry.updatedAt = new Date().toISOString();
    saveThreadIndex(stateDir, index);
  });
}

export function removeThread(stateDir: string, shortId: string): void {
  const filePath = threadsFilePath(stateDir);
  withThreadLock(filePath, () => {
    const index = loadThreadIndex(stateDir);
    delete index[shortId];
    saveThreadIndex(stateDir, index);
  });
}

// ─── Run Ledger ────────────────────────────────────────────────────────────

function runsDir(stateDir: string): string {
  return join(stateDir, "runs");
}

function runFilePath(stateDir: string, runId: string): string {
  return join(runsDir(stateDir), `${runId}.json`);
}

export function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function createRun(stateDir: string, record: RunRecord): void {
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = runFilePath(stateDir, record.runId);
  writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function loadRun(stateDir: string, runId: string): RunRecord | null {
  const filePath = runFilePath(stateDir, runId);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function updateRun(stateDir: string, runId: string, patch: Partial<RunRecord>): void {
  const filePath = runFilePath(stateDir, runId);
  if (!existsSync(filePath)) {
    console.error(`[codex] Warning: cannot update unknown run ${runId}`);
    return;
  }
  try {
    const record: RunRecord = JSON.parse(readFileSync(filePath, "utf-8"));
    Object.assign(record, patch);
    writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error(`[codex] Warning: failed to update run ${runId}: ${e instanceof Error ? e.message : e}`);
  }
}

export function listRuns(stateDir: string, opts?: { sessionId?: string }): RunRecord[] {
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const records: RunRecord[] = [];
  for (const file of files) {
    try {
      const record: RunRecord = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      if (opts?.sessionId && record.sessionId !== opts.sessionId) continue;
      records.push(record);
    } catch {
      // Skip corrupt run files
    }
  }
  // Sort by startedAt descending (newest first)
  records.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return records;
}

export function listRunsForThread(stateDir: string, shortId: string): RunRecord[] {
  return listRuns(stateDir).filter(r => r.shortId === shortId);
}

export function getLatestRun(stateDir: string, shortId: string): RunRecord | null {
  const runs = listRunsForThread(stateDir, shortId);
  return runs.length > 0 ? runs[0] : null;
}

export function pruneRuns(stateDir: string, maxRuns?: number): void {
  const limit = maxRuns ?? config.maxRunsPerWorkspace;
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  if (files.length <= limit) return;

  // Load all records with their filenames
  const entries: { file: string; startedAt: string }[] = [];
  for (const file of files) {
    try {
      const record: RunRecord = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      entries.push({ file, startedAt: record.startedAt });
    } catch {
      // Corrupt files count toward the total; delete them first
      entries.push({ file, startedAt: "1970-01-01T00:00:00Z" });
    }
  }

  // Sort ascending by startedAt (oldest first)
  entries.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  // Delete oldest until count <= limit
  const toDelete = entries.length - limit;
  for (let i = 0; i < toDelete; i++) {
    try {
      rmSync(join(dir, entries[i].file));
    } catch {
      // Ignore deletion failures (race, already removed)
    }
  }
}

// ─── Resume Candidate ──────────────────────────────────────────────────────

export function getResumeCandidate(
  stateDir: string,
  sessionId: string | null,
): { available: boolean; threadId?: string; shortId?: string; name?: string } {
  const allRuns = listRuns(stateDir);
  const completed = allRuns.filter(r => r.kind === "task" && r.status === "completed");
  if (completed.length === 0) return { available: false };

  // Prefer runs from the current session
  let candidate: RunRecord | undefined;
  if (sessionId) {
    candidate = completed.find(r => r.sessionId === sessionId);
  }
  if (!candidate) {
    candidate = completed[0]; // listRuns returns newest first
  }

  const index = loadThreadIndex(stateDir);
  const entry = index[candidate.shortId];
  return {
    available: true,
    threadId: candidate.threadId,
    shortId: candidate.shortId,
    name: entry?.name ?? undefined,
  };
}

// ─── Legacy API (backward-compatible) ──────────────────────────────────────
// These functions preserve the old signatures used by cli.ts, turns.ts, etc.
// They delegate to the new thread index functions using the parent directory
// of the threadsFile as the stateDir.

/** @deprecated Use loadThreadIndex instead. */
export function loadThreadMapping(threadsFile: string): ThreadMapping {
  // The old API expected threadsFile = {dir}/threads.json
  // We read the file directly to maintain exact backward compat
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

/** @deprecated Use saveThreadIndex instead. */
export function saveThreadMapping(threadsFile: string, mapping: ThreadMapping): void {
  const dir = dirname(threadsFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = threadsFile + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(mapping, null, 2), { mode: 0o600 });
  renameSync(tmpPath, threadsFile);
}

/**
 * @deprecated Use updateThreadMeta (new signature) instead.
 * Old signature: updateThreadMeta(threadsFile, threadId, meta) where threadId is the full ID.
 */
export function legacyUpdateThreadMeta(
  threadsFile: string,
  threadId: string,
  meta: { model?: string; cwd?: string; preview?: string },
): void {
  withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    for (const entry of Object.values(mapping)) {
      if (entry.threadId === threadId) {
        if (meta.model !== undefined) entry.model = meta.model;
        if (meta.cwd !== undefined) entry.cwd = meta.cwd;
        if (meta.preview !== undefined) entry.preview = meta.preview;
        entry.updatedAt = new Date().toISOString();
        saveThreadMapping(threadsFile, mapping);
        return;
      }
    }
    console.error(`[codex] Warning: cannot update metadata for unknown thread ${threadId.slice(0, 12)}...`);
  });
}

/** @deprecated Use run ledger status tracking instead. */
export function updateThreadStatus(
  threadsFile: string,
  threadId: string,
  status: "running" | "completed" | "failed" | "interrupted",
): void {
  withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    let found = false;
    for (const entry of Object.values(mapping)) {
      if (entry.threadId === threadId) {
        found = true;
        entry.lastStatus = status;
        entry.updatedAt = new Date().toISOString();
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

/**
 * @deprecated Legacy registerThread that returns the full mapping.
 * New code should use the new registerThread (returns shortId string).
 */
export function legacyRegisterThread(
  threadsFile: string,
  threadId: string,
  meta?: { model?: string; cwd?: string; preview?: string },
): ThreadMapping {
  validateId(threadId);
  return withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    let shortId = generateShortId();
    while (shortId in mapping) shortId = generateShortId();
    mapping[shortId] = {
      threadId,
      createdAt: new Date().toISOString(),
      model: meta?.model,
      cwd: meta?.cwd,
      preview: meta?.preview,
    };
    saveThreadMapping(threadsFile, mapping);
    return mapping;
  });
}

/**
 * @deprecated Legacy resolveThreadId that returns threadId string or throws.
 * New code should use the new resolveThreadId (returns object or null).
 */
export function legacyResolveThreadId(threadsFile: string, idOrPrefix: string): string {
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

/**
 * @deprecated Legacy findShortId that takes threadsFile.
 * New code should use the new findShortId (takes stateDir).
 */
export function legacyFindShortId(threadsFile: string, threadId: string): string | null {
  const mapping = loadThreadMapping(threadsFile);
  for (const [shortId, entry] of Object.entries(mapping)) {
    if (entry.threadId === threadId) return shortId;
  }
  return null;
}

/**
 * @deprecated Legacy removeThread that takes threadsFile.
 * New code should use the new removeThread (takes stateDir).
 */
export function legacyRemoveThread(threadsFile: string, shortId: string): void {
  withThreadLock(threadsFile, () => {
    const mapping = loadThreadMapping(threadsFile);
    delete mapping[shortId];
    saveThreadMapping(threadsFile, mapping);
  });
}
