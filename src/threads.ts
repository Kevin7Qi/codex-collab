// src/threads.ts — Thread index, run ledger, and resume candidate
//
// Two-layer model:
//   1. Thread Index  — maps short IDs to thread metadata ({stateDir}/threads.json)
//   2. Run Ledger    — per-execution records ({stateDir}/runs/{runId}.json)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync,
  unlinkSync, readdirSync, rmSync,
  copyFileSync, realpathSync,
} from "fs";
import { randomBytes, createHash } from "crypto";
import { basename, dirname, join, resolve } from "path";
import { config, validateId, resolveWorkspaceDir, isPathInside, STATE_SCHEMA_VERSION, MIGRATION_STATE_FILENAME } from "./config";
import { acquireLockSync, LockTimeoutError } from "./lock";
import type { ThreadIndex, ThreadIndexEntry, RunRecord, RunStatus } from "./types";

// ─── Advisory file lock ────────────────────────────────────────────────────

/**
 * Acquire an advisory file lock on `filePath + ".lock"` (see src/lock.ts for
 * the acquisition/stale-break semantics). Returns a release function.
 */
function acquireLock(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  try {
    return acquireLockSync(lockPath);
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      throw new Error(
        `Cannot acquire lock on ${filePath}: ${e.message}. ` +
        `If this persists, manually delete ${lockPath}`,
      );
    }
    throw new Error(`Cannot create lock file ${lockPath}: ${(e as Error).message}`);
  }
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw bailOnCorruptThreads(filePath, `unparseable JSON (${e instanceof Error ? e.message : e})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw bailOnCorruptThreads(filePath, "invalid structure (not a JSON object)");
  }
  return parsed as ThreadIndex;
}

/**
 * Move a corrupt threads file aside and return an Error explaining the situation.
 * The caller throws — silently returning an empty index on corruption used to
 * make all the user's short IDs vanish for the live invocation while the
 * stderr warning was easy to miss.
 */
function bailOnCorruptThreads(filePath: string, reason: string): Error {
  let backupPath: string | null = `${filePath}.corrupt.${Date.now()}`;
  try {
    renameSync(filePath, backupPath);
  } catch (backupErr) {
    console.error(`[codex] Warning: could not back up corrupt threads file: ${backupErr instanceof Error ? backupErr.message : backupErr}`);
    backupPath = null;
  }
  const where = backupPath
    ? `Moved aside to: ${backupPath}\nInspect or restore it, then retry. Re-running now will start with an empty thread index.`
    : `Could not move it aside automatically — inspect ${filePath} manually.`;
  return new Error(`Threads file corrupted (${reason}).\n${where}`);
}

/** Atomic write of a threads file at an explicit path. Used by saveThreadIndex
 *  and by legacy-global-file maintenance in the migration code below. */
function writeThreadsFileAt(filePath: string, index: ThreadIndex): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

export function saveThreadIndex(stateDir: string, index: ThreadIndex): void {
  writeThreadsFileAt(threadsFilePath(stateDir), index);
}

/**
 * Load the index, apply `mutate`, and save — all under the thread lock.
 * Return false from `mutate` to skip the save (no changes).
 */
export function mutateThreadIndex(
  stateDir: string,
  mutate: (index: ThreadIndex) => boolean | void,
): void {
  withThreadLock(threadsFilePath(stateDir), () => {
    const index = loadThreadIndex(stateDir);
    if (mutate(index) !== false) saveThreadIndex(stateDir, index);
  });
}

export function registerThread(
  stateDir: string,
  threadId: string,
  meta?: Partial<Pick<ThreadIndexEntry, "model" | "cwd" | "preview" | "createdAt" | "updatedAt">>,
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
      createdAt: meta?.createdAt ?? now,
      updatedAt: meta?.updatedAt ?? now,
      model: meta?.model,
      cwd: meta?.cwd,
      preview: meta?.preview,
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
 * 3. Full thread ID lookup (any format — thr_, UUID, etc.)
 * 4. Otherwise, return null
 */
export function resolveThreadId(
  stateDir: string,
  id: string,
): { shortId: string; threadId: string } | null {
  const index = loadThreadIndex(stateDir);

  // 1. Exact short ID match (hasOwn: `index[id]` alone would hit
  // Object.prototype members for IDs like "constructor")
  if (Object.hasOwn(index, id)) return { shortId: id, threadId: index[id].threadId };

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

  // 3. Full thread ID lookup (any format — thr_, UUID, etc.)
  for (const [shortId, entry] of Object.entries(index)) {
    if (entry.threadId === id) return { shortId, threadId: entry.threadId };
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

type ThreadMetaPatch = Partial<Pick<ThreadIndexEntry, "model" | "cwd" | "preview">>;

/** Update display metadata for a thread, keyed by full thread ID (callers
 *  coming off a server response hold the thread ID, not the short ID). */
export function updateThreadMeta(
  stateDir: string,
  threadId: string,
  patch: ThreadMetaPatch,
): void {
  mutateThreadIndex(stateDir, (index) => {
    for (const entry of Object.values(index)) {
      if (entry.threadId === threadId) {
        if (patch.model !== undefined) entry.model = patch.model;
        if (patch.cwd !== undefined) entry.cwd = patch.cwd;
        if (patch.preview !== undefined) entry.preview = patch.preview;
        entry.updatedAt = new Date().toISOString();
        return;
      }
    }
    console.error(`[codex] Warning: cannot update metadata for unknown thread ${threadId.slice(0, 12)}...`);
    return false;
  });
}

/** Update the denormalized display status for a thread, keyed by full thread
 *  ID. The run ledger is the authoritative per-invocation record; this keeps
 *  `threads` listings current without a ledger scan. */
export function updateThreadStatus(
  stateDir: string,
  threadId: string,
  status: NonNullable<ThreadIndexEntry["lastStatus"]>,
): void {
  mutateThreadIndex(stateDir, (index) => {
    for (const entry of Object.values(index)) {
      if (entry.threadId === threadId) {
        entry.lastStatus = status;
        entry.updatedAt = new Date().toISOString();
        return;
      }
    }
    console.error(`[codex] Warning: cannot update status for unknown thread ${threadId.slice(0, 12)}...`);
    return false;
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = runFilePath(stateDir, record.runId);
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/** Records written before the status unification say "cancelled" where the
 *  thread index (and every display surface) says "interrupted". Normalize on
 *  read — a lazy migration; the next updateRun persists the new value. */
function normalizeRunRecord(record: RunRecord): RunRecord {
  if ((record.status as string) === "cancelled") record.status = "interrupted";
  return record;
}

export function loadRun(stateDir: string, runId: string): RunRecord | null {
  const filePath = runFilePath(stateDir, runId);
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (e) {
    console.error(`[codex] Warning: failed to read run file ${runId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    // Basic shape validation
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.runId !== "string" ||
      typeof parsed.threadId !== "string" ||
      typeof parsed.shortId !== "string"
    ) {
      console.error(`[codex] Warning: run file ${runId} has invalid structure`);
      return null;
    }
    return normalizeRunRecord(parsed);
  } catch (e) {
    console.error(`[codex] Warning: failed to parse run file ${runId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

type RunPatch = Partial<Pick<RunRecord,
  "status" | "phase" | "sessionId" | "completedAt" | "elapsed" |
  "output" | "filesChanged" | "commandsRun" | "error" | "logOffset" |
  "pendingApproval"
>>;

/**
 * Update a run record. Throws on missing file, unreadable JSON, or write
 * failure — terminal status updates that fail silently used to leave runs
 * stuck `running` forever. Callers in shutdown paths wrap this in try/catch
 * to log without aborting; callers in success paths must surface the error.
 */
export function updateRun(stateDir: string, runId: string, patch: RunPatch): void {
  const filePath = runFilePath(stateDir, runId);
  if (!existsSync(filePath)) {
    throw new Error(`Cannot update unknown run ${runId} (file ${filePath} missing)`);
  }
  let record: RunRecord;
  try {
    record = normalizeRunRecord(JSON.parse(readFileSync(filePath, "utf-8")));
  } catch (e) {
    throw new Error(`Failed to read run ${runId}: ${e instanceof Error ? e.message : e}`);
  }
  Object.assign(record, patch);
  const tmpPath = filePath + ".tmp";
  try {
    writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (e) {
    throw new Error(`Failed to write run ${runId}: ${e instanceof Error ? e.message : e}`);
  }
}

export function listRuns(stateDir: string, opts?: { sessionId?: string }): RunRecord[] {
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const records: RunRecord[] = [];
  for (const file of files) {
    try {
      const record: RunRecord = normalizeRunRecord(JSON.parse(readFileSync(join(dir, file), "utf-8")));
      if (opts?.sessionId && record.sessionId !== opts.sessionId) continue;
      records.push(record);
    } catch (e) {
      console.error(`[codex] Warning: skipping corrupt/unreadable run file ${file}: ${e instanceof Error ? e.message : e}`);
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

/** Remove all run records for a thread, along with each run's captured
 *  detached-runner output (`logs/detached-<runId>.log` — it can contain
 *  prompts and results, so a local delete must reach it). Called by
 *  `delete` so the ledger can't hold orphaned records for a thread whose
 *  mapping, log, and PID file are gone — bare `follow` selects from run
 *  records and would otherwise attach to (or hang on) a deleted thread's
 *  stale run. */
export function removeRunsForThread(stateDir: string, shortId: string): void {
  for (const r of listRunsForThread(stateDir, shortId)) {
    for (const path of [
      runFilePath(stateDir, r.runId),
      join(stateDir, "logs", `detached-${r.runId}.log`),
    ]) {
      try {
        unlinkSync(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[codex] Warning: could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
}

export function pruneRuns(stateDir: string, maxRuns?: number): void {
  const limit = maxRuns ?? config.maxRunsPerWorkspace;
  const dir = runsDir(stateDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  if (files.length <= limit) return;

  // Load all records with their filenames. Sort by last activity, not start
  // time: a long-running run that started early but is still updating should
  // outlive a short, fully-completed older run.
  const logsRoot = resolve(stateDir, "logs");
  const resolveLogFile = (logFile: string | null): string | null => {
    if (!logFile) return null;
    const abs = resolve(stateDir, logFile);
    if (isPathInside(abs, logsRoot)) return abs;
    console.error(`[codex] Warning: refusing to prune log outside workspace state: ${logFile}`);
    return null;
  };

  type Entry = { file: string; activityAt: string; logFile: string | null; logPath: string | null; running: boolean };
  const entries: Entry[] = [];
  // A record can say "running" forever if its process died without writing a
  // terminal state (SIGKILL, crash, power loss — nothing reconciles the run
  // ledger afterwards). Treat "running" records with no activity for a day
  // as dead so they don't leak past the cap permanently.
  const staleRunningHorizonMs = 24 * 60 * 60 * 1000;
  for (const file of files) {
    try {
      const record: RunRecord = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      const activityAt = record.completedAt ?? record.startedAt;
      const logFile = record.logFile || null;
      const activityMs = new Date(activityAt).getTime();
      const staleRunning = Number.isFinite(activityMs) && Date.now() - activityMs > staleRunningHorizonMs;
      entries.push({
        file,
        activityAt,
        logFile,
        logPath: resolveLogFile(logFile),
        running: record.status === "running" && !staleRunning,
      });
    } catch (e) {
      // Corrupt files count toward the total; delete them first
      console.error(`[codex] Warning: cannot read run file ${file} during prune: ${e instanceof Error ? e.message : e}`);
      entries.push({ file, activityAt: "1970-01-01T00:00:00Z", logFile: null, logPath: null, running: false });
    }
  }

  // Pick eviction candidates from non-running runs only — a running run's
  // JSON is still being updated by recordTerminalRunState; deleting it
  // would lose the run ledger / log for an in-flight invocation. The
  // workspace may briefly exceed the cap if every excess entry is
  // running; the next prune (after one completes) brings it back down.
  const evictable = entries.filter(e => !e.running).sort((a, b) =>
    new Date(a.activityAt).getTime() - new Date(b.activityAt).getTime(),
  );
  const toDelete = Math.max(0, entries.length - limit);
  if (toDelete === 0 || evictable.length === 0) return;
  const victims = evictable.slice(0, toDelete);

  // Logs referenced by surviving runs must NOT be deleted — multiple runs
  // of the same thread share a log file.
  const victimFiles = new Set(victims.map(v => v.file));
  const survivingLogs = new Set<string>();
  for (const e of entries) {
    if (!victimFiles.has(e.file) && e.logPath) survivingLogs.add(e.logPath);
  }
  // Also protect logs referenced by live thread-index entries: a thread can
  // outlive all of its run records (index retention is `clean`'s 7-day
  // policy, run retention is the 50-record cap), and `output`/`progress`
  // still read logs/{shortId}.log for it.
  try {
    const index = JSON.parse(readFileSync(threadsFilePath(stateDir), "utf-8"));
    if (typeof index === "object" && index !== null && !Array.isArray(index)) {
      for (const shortId of Object.keys(index)) {
        survivingLogs.add(resolve(stateDir, "logs", `${shortId}.log`));
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[codex] Warning: could not read thread index during prune: ${e instanceof Error ? e.message : e}`);
    }
  }

  for (const victim of victims) {
    try {
      rmSync(join(dir, victim.file));
    } catch (e) {
      console.error(`[codex] Warning: failed to delete run file ${victim.file} during prune: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // Only the last prune that references a shared log actually removes it.
    // `force: true` swallows ENOENT so we don't race against a parallel prune.
    if (victim.logPath && !survivingLogs.has(victim.logPath)) {
      try {
        rmSync(victim.logPath, { force: true });
      } catch (e) {
        console.error(`[codex] Warning: failed to delete orphan log ${victim.logFile}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

// ─── Migration ────────────────────────────────────────────────────────────

/**
 * Map old thread status values to the new RunStatus type.
 * "running" is mapped to "failed" since stale running entries are dead.
 */
function mapLegacyStatus(lastStatus?: string): RunStatus {
  switch (lastStatus) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "running": return "failed"; // stale — process is gone
    default: return "failed";
  }
}

function mapLegacyThreadStatus(lastStatus?: string): ThreadIndexEntry["lastStatus"] {
  switch (lastStatus) {
    case "completed":
    case "failed":
    case "interrupted":
      return lastStatus;
    case "running":
      return "failed"; // stale legacy process; do not keep it displayed as running
    default:
      return undefined;
  }
}

/** Canonicalize a path for workspace-scope comparisons. When the path does
 *  not exist (deleted dirs, dangling entries), canonicalize the deepest
 *  existing ancestor and re-append the remainder — a plain resolve() would
 *  leave a symlinked prefix (macOS /var → /private/var) unresolved and
 *  break prefix comparisons against canonical roots. */
function canonicalizePath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) return resolved; // filesystem root
    return join(canonicalizePath(parent), basename(resolved));
  }
}

/**
 * Compute the workspace-specific slug-hash suffix for a given cwd.
 * Mirrors the logic in resolveStateDir but returns only the directory name.
 */
function workspaceDirName(cwd: string): string {
  const canonical = canonicalizePath(resolveWorkspaceDir(cwd));
  const slug = basename(canonical).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

/**
 * Read the per-workspace migration marker, returning null if absent or
 * unparseable. Corrupt markers are logged and treated as absent so migration
 * re-runs and re-stamps cleanly (refusing on a corrupt marker would be a
 * soft-DOS for the user).
 */
function readMigrationMarker(stateDir: string): { schemaVersion: number } | null {
  const markerPath = join(stateDir, MIGRATION_STATE_FILENAME);
  if (!existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
    if (parsed && typeof parsed === "object" && typeof parsed.schemaVersion === "number") {
      return parsed as { schemaVersion: number };
    }
    console.error(`[codex] Warning: migration marker at ${markerPath} has unexpected shape; re-running migration.`);
  } catch (e) {
    console.error(`[codex] Warning: migration marker at ${markerPath} unparseable (${e instanceof Error ? e.message : e}); re-running migration.`);
  }
  return null;
}

/**
 * Read the marker and decide what migrateGlobalState should do next.
 * Returns true if migration is already at the current schema (caller should
 * skip), false if migration should proceed. Throws on a marker whose
 * schemaVersion is newer than this binary — refusing to downgrade prevents
 * an older binary from rewriting newer-format state.
 */
function markerSaysSkip(stateDir: string): boolean {
  const marker = readMigrationMarker(stateDir);
  if (!marker) return false;
  if (marker.schemaVersion === STATE_SCHEMA_VERSION) return true;
  if (marker.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new Error(
      `[codex] Refusing to run migration: workspace ${stateDir} was written by a newer schema version (${marker.schemaVersion} > ${STATE_SCHEMA_VERSION}). ` +
      `This binary would downgrade the state. Upgrade codex-collab or move the workspace state aside.`,
    );
  }
  // schemaVersion < current → future migrations slot here; for now, re-run.
  return false;
}

/**
 * Atomically stamp the per-workspace migration marker.
 *
 * Caller MUST hold withThreadLock(markerPath, …). The entire
 * migrateGlobalState body runs under that lock so saveThreadIndex /
 * createRun and this marker write all share serialization without
 * needing a nested (and non-reentrant) acquisition here.
 */
function writeMigrationMarker(stateDir: string): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const markerPath = join(stateDir, MIGRATION_STATE_FILENAME);
  const tmpPath = markerPath + ".tmp";
  const payload = JSON.stringify(
    { schemaVersion: STATE_SCHEMA_VERSION, migratedAt: new Date().toISOString() },
    null,
    2,
  );
  writeFileSync(tmpPath, payload, { mode: 0o600 });
  renameSync(tmpPath, markerPath);
}

/**
 * Migrate thread entries and logs from the old global layout to per-workspace layout.
 *
 * Gated by a per-workspace marker at {stateDir}/migration-state.json so the
 * merge runs once per workspace; subsequent commands return at the marker
 * gate. The whole merge body holds withThreadLock(markerPath) to serialize
 * concurrent first-touch invocations against each other's `<file>.tmp`
 * writes.
 *
 * @param cwd - The current working directory to migrate state for
 * @param globalDataDir - Override for the global data directory (for testing). Defaults to config.dataDir.
 */
export function migrateGlobalState(cwd: string, globalDataDir?: string): void {
  const dataDir = globalDataDir ?? config.dataDir;
  const globalThreadsFile = join(dataDir, "threads.json");
  const stateDir = join(dataDir, "workspaces", workspaceDirName(cwd));
  const markerPath = join(stateDir, MIGRATION_STATE_FILENAME);

  // Steady-state fast path: read the marker without taking the lock. The
  // race window against a concurrent first-touch is resolved by re-checking
  // the marker after acquiring the lock below.
  if (markerSaysSkip(stateDir)) return;

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  withThreadLock(markerPath, () => {
    // Re-check under the lock — another process may have just finished.
    if (markerSaysSkip(stateDir)) return;

    runMigration(cwd, dataDir, globalThreadsFile, stateDir);
  });
}

/** Core migration body. Caller MUST hold withThreadLock(markerPath, …). */
function runMigration(cwd: string, dataDir: string, globalThreadsFile: string, stateDir: string): void {
  // 1. Check if global threads.json exists. No legacy file = nothing to do;
  // stamp the marker so the next command short-circuits at the gate above.
  if (!existsSync(globalThreadsFile)) {
    writeMigrationMarker(stateDir);
    return;
  }

  // 2. Load any existing workspace index.
  const index: ThreadIndex = loadThreadIndex(stateDir);

  // 3. Load the global thread mapping directly. We deliberately do NOT use
  // loadThreadIndex-style corruption handling here — it renames the file
  // aside on corruption, which
  // would (a) destroy the legacy state for OTHER workspaces that haven't
  // migrated yet, and (b) cascade through every CLI invocation since
  // migration runs from getWorkspacePaths. On corruption we skip migration
  // and leave the file in place so the user can inspect/repair it.
  let globalMapping: ThreadIndex;
  let content: string;
  try {
    content = readFileSync(globalThreadsFile, "utf-8");
  } catch (e) {
    // I/O errors (EACCES, EISDIR, EIO) usually mean a fixable configuration
    // problem — surface louder so users know history isn't actually lost.
    const code = (e as NodeJS.ErrnoException).code;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[codex] Migration blocked by ${code ?? "I/O error"} on ${globalThreadsFile}: ${msg}. Fix permissions/path and re-run any codex-collab command to retry migration.`);
    return;
  }
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // Terminal corruption (unlike a fixable I/O error above): stamp the
      // marker so this doesn't re-log and re-lock on every command. The file
      // is left in place for inspection; remove the per-workspace marker to
      // retry after repairing it.
      console.error(`[codex] Skipping migration: legacy global threads file is not a JSON object (${globalThreadsFile}); leaving it in place. Remove ${join(stateDir, MIGRATION_STATE_FILENAME)} to retry after repair.`);
      writeMigrationMarker(stateDir);
      return;
    }
    globalMapping = parsed;
  } catch (e) {
    console.error(`[codex] Skipping migration: legacy global threads file is unparseable (${e instanceof Error ? e.message : String(e)}); leaving it in place. Remove ${join(stateDir, MIGRATION_STATE_FILENAME)} to retry after repair.`);
    writeMigrationMarker(stateDir);
    return;
  }
  if (Object.keys(globalMapping).length === 0) {
    writeMigrationMarker(stateDir);
    return;
  }

  // 4. Filter entries where cwd matches or is within the workspace root.
  // Canonicalize the stored cwd too: wsRoot is canonical (git physical path
  // or realpath'd fallback), while legacy entries recorded raw process.cwd()
  // values that may be symlinked forms of the same directory (e.g. macOS
  // /var vs /private/var).
  const wsRoot = resolveWorkspaceDir(cwd);
  const matchingEntries: [string, ThreadIndexEntry][] = [];
  for (const [shortId, entry] of Object.entries(globalMapping)) {
    if (entry.cwd && isPathInside(canonicalizePath(entry.cwd), wsRoot)) {
      matchingEntries.push([shortId, entry]);
    }
  }

  if (matchingEntries.length === 0) {
    writeMigrationMarker(stateDir);
    return;
  }

  // 5. Merge per-workspace thread index and run records
  const globalLogsDir = join(dataDir, "logs");
  const wsLogsDir = join(stateDir, "logs");
  let migrated = 0;
  let updated = 0;
  let createdRuns = 0;

  for (const [shortId, entry] of matchingEntries) {
    const existingShortId = Object.entries(index).find(([, e]) => e.threadId === entry.threadId)?.[0];
    let targetShortId = existingShortId ?? shortId;
    if (!existingShortId && index[targetShortId]?.threadId && index[targetShortId].threadId !== entry.threadId) {
      targetShortId = generateShortId();
      while (targetShortId in index) targetShortId = generateShortId();
      console.error(`[codex] Warning: legacy short ID ${shortId} collided during migration; assigned ${targetShortId}`);
    }

    const previous = index[targetShortId];
    const nextEntry = {
      threadId: entry.threadId,
      model: previous?.model ?? entry.model,
      cwd: previous?.cwd ?? entry.cwd ?? cwd,
      createdAt: previous?.createdAt ?? entry.createdAt,
      updatedAt: previous?.updatedAt ?? entry.updatedAt ?? entry.createdAt,
      preview: previous?.preview ?? entry.preview,
      // Preserve already-migrated/live workspace state as-is (like every field
      // above). Only normalize the *legacy* entry's status, and only when this
      // thread has no per-workspace entry yet (genuine first migration).
      // Re-running mapLegacyThreadStatus over previous.lastStatus would flip a
      // legitimately live "running" thread to "failed" on the next command,
      // corrupting state and re-firing the migration log line every turn.
      lastStatus: previous?.lastStatus ?? mapLegacyThreadStatus(entry.lastStatus),
    };
    const changed = !previous ||
      previous.threadId !== nextEntry.threadId ||
      previous.model !== nextEntry.model ||
      previous.cwd !== nextEntry.cwd ||
      previous.createdAt !== nextEntry.createdAt ||
      previous.updatedAt !== nextEntry.updatedAt ||
      previous.preview !== nextEntry.preview ||
      previous.lastStatus !== nextEntry.lastStatus;
    if (changed) {
      index[targetShortId] = nextEntry;
      if (previous) updated++;
      else migrated++;
    }

    // Copy log file if it exists
    const globalLogFile = join(globalLogsDir, `${shortId}.log`);
    const wsLogFile = join(wsLogsDir, `${targetShortId}.log`);
    let logFile = "";
    if (existsSync(globalLogFile)) {
      if (!existsSync(wsLogsDir)) mkdirSync(wsLogsDir, { recursive: true, mode: 0o700 });
      try {
        if (!existsSync(wsLogFile)) copyFileSync(globalLogFile, wsLogFile);
        logFile = wsLogFile;
      } catch (e) {
        console.error(`[codex] Warning: could not copy log file ${globalLogFile}: ${(e as Error).message}`);
        logFile = globalLogFile; // fall back to original path
      }
    }

    if (listRunsForThread(stateDir, targetShortId).length > 0) continue;

    // Determine terminal status
    const status = mapLegacyStatus(entry.lastStatus);
    const isTerminal = status === "completed" || status === "failed" || status === "interrupted";

    // Create synthetic RunRecord
    const record: RunRecord = {
      runId: generateRunId(),
      threadId: entry.threadId,
      shortId: targetShortId,
      kind: "task",
      phase: null,
      status,
      sessionId: null,
      logFile,
      logOffset: 0,
      prompt: entry.preview ?? null,
      model: entry.model ?? null,
      startedAt: entry.createdAt,
      completedAt: isTerminal && entry.updatedAt ? entry.updatedAt : null,
      elapsed: null,
      output: null,
      filesChanged: null,
      commandsRun: null,
      error: null,
    };
    createRun(stateDir, record);
    createdRuns++;
  }

  // 6. Save the per-workspace thread index
  if (migrated > 0 || updated > 0) saveThreadIndex(stateDir, index);

  // 7. Log migration result
  if (migrated > 0 || updated > 0 || createdRuns > 0) {
    console.error(`[codex] Migrated ${migrated} thread(s), refreshed ${updated} thread(s), created ${createdRuns} run record(s) from global state to workspace ${wsRoot}`);
  }

  // 8. Stamp the marker so subsequent commands skip the entire merge.
  writeMigrationMarker(stateDir);
}

/**
 * Remove a migrated thread from the legacy global mapping after `delete`.
 * Without this, the next command re-runs migration and resurrects the local
 * workspace entry. Only remove entries that match both threadId and workspace
 * root so deleting in one workspace cannot disturb unrelated legacy entries.
 */
export function removeLegacyGlobalThread(
  cwd: string,
  threadId: string,
  globalDataDir?: string,
): boolean {
  const dataDir = globalDataDir ?? config.dataDir;
  const globalThreadsFile = join(dataDir, "threads.json");
  if (!existsSync(globalThreadsFile)) return false;

  const wsRoot = resolveWorkspaceDir(cwd);
  return withThreadLock(globalThreadsFile, () => {
    let globalMapping: ThreadIndex;
    try {
      const parsed = JSON.parse(readFileSync(globalThreadsFile, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.error(`[codex] Warning: cannot remove legacy thread ${threadId}: global threads file is not a JSON object`);
        return false;
      }
      globalMapping = parsed;
    } catch (e) {
      console.error(`[codex] Warning: cannot remove legacy thread ${threadId}: ${e instanceof Error ? e.message : e}`);
      return false;
    }

    let changed = false;
    for (const [shortId, entry] of Object.entries(globalMapping)) {
      if (entry.threadId === threadId && entry.cwd && isPathInside(canonicalizePath(entry.cwd), wsRoot)) {
        delete globalMapping[shortId];
        changed = true;
      }
    }

    if (changed) writeThreadsFileAt(globalThreadsFile, globalMapping);
    return changed;
  });
}

