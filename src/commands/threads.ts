// src/commands/threads.ts — threads, output, progress, delete, clean commands

import {
  legacyRegisterThread as registerThread,
  legacyFindShortId as findShortId,
  legacyRemoveThread as removeThread,
  loadThreadMapping,
  saveThreadMapping,
  withThreadLock,
  removeLegacyGlobalThread,
  getLatestRun,
} from "../threads";
import { resolveWorkspaceDir } from "../config";
import type { AppServerClient } from "../client";
import type { Thread } from "../types";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { config, isPathInside } from "../config";
import {
  die,
  parseOptions,
  validateIdOrDie,
  resolveThreadIdOrDie,
  progress,
  formatAge,
  isThreadProcessAlive,
  removePidFile,
  withClient,
  tryArchive,
  getWorkspacePaths,
  fetchAllPages,
  type WorkspacePaths,
} from "./shared";

// ---------------------------------------------------------------------------
// Thread discovery from app-server
// ---------------------------------------------------------------------------

const DISCOVER_DEFAULT_LIMIT = 5;

/**
 * Compute display limit for the threads list. When --discover is set and
 * --limit was not explicitly provided, cap at DISCOVER_DEFAULT_LIMIT.
 */
export function applyDiscoverLimit(options: {
  discover: boolean;
  limit: number;
  explicit: Set<string>;
}): number {
  if (options.discover && !options.explicit.has("limit")) {
    return DISCOVER_DEFAULT_LIMIT;
  }
  return options.limit;
}

/**
 * Query the app server for threads matching the workspace cwd and register
 * any that are not already in the local index. Returns the number of newly
 * discovered threads.
 */
/** User-facing source kinds for thread discovery. Excludes internal subagent
 *  sources which are implementation details of the Codex runtime. */
const DISCOVERY_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"];

async function discoverThreads(client: AppServerClient, ws: WorkspacePaths, cwd: string): Promise<number> {
  const workspaceRoot = resolveWorkspaceDir(cwd);
  const serverThreads = await fetchAllPages<Thread>(client, "thread/list", {
    cwd: workspaceRoot,
    limit: 50,
    sourceKinds: DISCOVERY_SOURCE_KINDS,
  });
  if (serverThreads.length === 0) return 0;

  const mapping = loadThreadMapping(ws.threadsFile);
  const knownThreadIds = new Set(Object.values(mapping).map(e => e.threadId));
  let discovered = 0;

  for (const thread of serverThreads) {
    if (knownThreadIds.has(thread.id)) continue;
    // Server timestamps are epoch seconds (not milliseconds)
    const createdAt = thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : new Date().toISOString();
    const updatedAt = thread.updatedAt ? new Date(thread.updatedAt * 1000).toISOString() : createdAt;
    // thread/list exposes only the provider ("openai"), not a model name —
    // storing it as `model` made discovered threads display a provider where
    // local threads show a model. Leave model unset instead.
    registerThread(ws.threadsFile, thread.id, {
      cwd: thread.cwd ?? cwd,
      preview: thread.preview ?? thread.name ?? undefined,
      createdAt,
      updatedAt,
    });
    discovered++;
  }

  return discovered;
}

// ---------------------------------------------------------------------------
// threads (list)
// ---------------------------------------------------------------------------

export async function handleThreads(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);

  // If --discover, query the app-server and merge server-side threads
  if (options.discover) {
    try {
      await withClient(async (client) => {
        const count = await discoverThreads(client, ws, options.dir);
        if (count > 0 && !options.json) {
          progress(`Discovered ${count} thread(s) from server`);
        }
      }, options.dir);
    } catch (e) {
      console.error(`[codex] Warning: thread discovery failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error("[codex] Showing local threads only.");
    }
  }

  const mapping = loadThreadMapping(ws.threadsFile);

  // Build entries sorted by updatedAt (most recent first), falling back to createdAt
  let entries = Object.entries(mapping)
    .map(([shortId, entry]) => ({ shortId, ...entry }))
    .sort((a, b) => {
      const ta = new Date(a.updatedAt ?? a.createdAt).getTime();
      const tb = new Date(b.updatedAt ?? b.createdAt).getTime();
      return tb - ta;
    });

  // Detect stale "running" status: if the owning process is dead, mark as
  // interrupted. Batched under one lock — a per-entry updateThreadStatus
  // would acquire the lock and rewrite the whole index once per stale entry.
  const stale = entries.filter(
    (e) => e.lastStatus === "running" && !isThreadProcessAlive(ws.pidsDir, e.shortId),
  );
  if (stale.length > 0) {
    withThreadLock(ws.threadsFile, () => {
      const fresh = loadThreadMapping(ws.threadsFile);
      const now = new Date().toISOString();
      for (const e of stale) {
        const entry = fresh[e.shortId];
        if (entry && entry.lastStatus === "running") {
          entry.lastStatus = "interrupted";
          entry.updatedAt = now;
        }
      }
      saveThreadMapping(ws.threadsFile, fresh);
    });
    for (const e of stale) {
      e.lastStatus = "interrupted";
      removePidFile(ws.pidsDir, e.shortId);
    }
  }

  const displayLimit = applyDiscoverLimit(options);
  if (displayLimit !== Infinity) entries = entries.slice(0, displayLimit);

  if (options.json) {
    const enriched = entries.map(e => ({
      shortId: e.shortId,
      threadId: e.threadId,
      status: e.lastStatus ?? "unknown",
      model: e.model ?? null,
      cwd: e.cwd ?? null,
      preview: e.preview ?? null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt ?? e.createdAt,
    }));
    console.log(JSON.stringify(enriched, null, 2));
  } else {
    if (entries.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const e of entries) {
      const status = e.lastStatus ?? "idle";
      const ts = new Date(e.updatedAt ?? e.createdAt).getTime() / 1000;
      const age = formatAge(ts);
      const model = e.model ? ` (${e.model})` : "";
      const preview = e.preview ? ` ${e.preview.slice(0, 50)}` : "";
      console.log(
        `  ${e.shortId}  ${status.padEnd(12)} ${age.padEnd(8)} ${e.cwd ?? ""}${model}${preview}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

/**
 * Resolve a thread's log path for reading, preferring the workspace-local
 * file but falling back to the run record's `logFile` if the workspace file
 * is absent.
 *
 * This handles the migration edge case: if `migrateGlobalState`'s
 * `copyFileSync` from the legacy `{dataDir}/logs` to `{stateDir}/logs` ever
 * fails (rare — transient I/O or restrictive source perms), the run record's
 * `logFile` falls back to the legacy global path while no workspace-local
 * file is created. With the migration marker stamped, migration won't retry
 * the copy — so without this fallback, `output` and `progress` would return
 * an empty/missing-file diagnostic even though the log content still exists
 * at the legacy path. (Run records created by normal turns store `logFile`
 * as a workspace-relative `logs/<shortId>.log` — see commands/shared.ts's
 * createRun call; legacy/migration synthetic records may instead carry an
 * absolute global path. `resolve(stateDir, …)` handles both cases.)
 *
 * The fallback is confined to the workspace `logsDir` or the legacy
 * `globalLogsDir` (defaults to `~/.codex-collab/logs`) so a corrupted or
 * adversarial run record cannot point us at arbitrary filesystem paths
 * (mirrors the confinement in pruneRuns' resolveLogFile).
 */
export function resolveReadableLogPath(
  stateDir: string,
  logsDir: string,
  shortId: string,
  globalLogsDir: string = config.logsDir,
): string {
  const wsLog = join(logsDir, `${shortId}.log`);
  if (existsSync(wsLog)) return wsLog;
  const latest = getLatestRun(stateDir, shortId);
  if (latest && latest.logFile) {
    const fallback = resolve(stateDir, latest.logFile);
    const confined = isPathInside(fallback, resolve(logsDir))
      || isPathInside(fallback, resolve(globalLogsDir));
    if (confined && existsSync(fallback)) return fallback;
  }
  return wsLog; // let the caller's existing not-found handling fire
}

/** Resolve a positional ID arg to a log file path, or die with an error. */
function resolveLogPath(positional: string[], usage: string, ws: ReturnType<typeof getWorkspacePaths>): string {
  const id = positional[0];
  if (!id) die(usage);
  validateIdOrDie(id);
  const threadId = resolveThreadIdOrDie(ws.threadsFile, id);
  const shortId = findShortId(ws.threadsFile, threadId);
  if (!shortId) die(`Thread not found: ${id}`);
  return resolveReadableLogPath(ws.stateDir, ws.logsDir, shortId);
}

export async function handleOutput(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const logPath = resolveLogPath(positional, "Usage: codex-collab output <id>", ws);
  if (!existsSync(logPath)) die(`No log file for thread`);
  const content = readFileSync(logPath, "utf-8");
  if (options.contentOnly) {
    // Extract agent output blocks from the log.
    // Log format: "<ISO-timestamp> agent output:\n<content>\n<<END_AGENT_OUTPUT>>"
    // Using an explicit end marker avoids false positives when model output contains timestamps.
    const tsPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
    const lines = content.split("\n");
    let inAgentOutput = false;
    for (const line of lines) {
      if (line === "<<END_AGENT_OUTPUT>>") {
        inAgentOutput = false;
        continue;
      }
      if (tsPrefix.test(line)) {
        inAgentOutput = line.includes(" agent output:");
        continue;
      }
      if (inAgentOutput) {
        console.log(line);
      }
    }
  } else {
    console.log(content);
  }
}

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

export async function handleProgress(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const logPath = resolveLogPath(positional, "Usage: codex-collab progress <id>", ws);
  if (!existsSync(logPath)) {
    console.log("No activity yet.");
    return;
  }

  // Show last 20 lines
  const lines = readFileSync(logPath, "utf-8").trim().split("\n");
  console.log(lines.slice(-20).join("\n"));
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export async function handleDelete(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const id = positional[0];
  if (!id) die("Usage: codex-collab delete <id>");
  validateIdOrDie(id);

  const threadId = resolveThreadIdOrDie(ws.threadsFile, id);
  const shortId = findShortId(ws.threadsFile, threadId);

  // If the thread is currently running, stop it first before archiving
  const localStatus = shortId ? loadThreadMapping(ws.threadsFile)[shortId]?.lastStatus : undefined;
  if (localStatus === "running") {
    const signalPath = join(ws.killSignalsDir, threadId);
    try {
      writeFileSync(signalPath, "", { mode: 0o600 });
    } catch (e) {
      console.error(
        `[codex] Warning: could not write kill signal: ${e instanceof Error ? e.message : String(e)}. ` +
        `The running process may not detect the delete.`,
      );
    }
  }

  let archiveResult: "archived" | "already_done" | "failed" = "failed";
  try {
    archiveResult = await withClient(async (client) => {
      // Interrupt active turn before archiving (only if running)
      if (localStatus === "running") {
        try {
          const { thread } = await client.request<{
            thread: {
              id: string;
              status: { type: string };
              turns: Array<{ id: string; status: string }>;
            };
          }>("thread/read", { threadId, includeTurns: true });

          if (thread.status.type === "active") {
            const activeTurn = thread.turns?.find(
              (t) => t.status === "inProgress",
            );
            if (activeTurn) {
              await client.request("turn/interrupt", {
                threadId,
                turnId: activeTurn.id,
              });
            }
          }
        } catch (e) {
          if (e instanceof Error && !e.message.includes("not found") && !e.message.includes("archived")) {
            console.error(`[codex] Warning: could not read/interrupt thread during delete: ${e.message}`);
          }
        }
      }

      return tryArchive(client, threadId);
    }, options.dir);
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not found")) {
      console.error(`[codex] Warning: could not archive on server: ${e.message}`);
    }
  }

  if (shortId) {
    removePidFile(ws.pidsDir, shortId);
    const logPath = join(ws.logsDir, `${shortId}.log`);
    if (existsSync(logPath)) unlinkSync(logPath);
    removeThread(ws.threadsFile, shortId);
    try {
      removeLegacyGlobalThread(options.dir, threadId);
    } catch (e) {
      console.error(`[codex] Warning: could not remove legacy thread entry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (archiveResult === "failed") {
    progress(`Deleted local data for thread ${id} (server archive failed)`);
  } else {
    progress(`Deleted thread ${id}`);
  }
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

/** Delete files older than maxAgeMs in the given directory. Returns count deleted. */
function deleteOldFiles(dir: string, maxAgeMs: number): number {
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  let deleted = 0;
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    try {
      if (now - Bun.file(path).lastModified > maxAgeMs) {
        unlinkSync(path);
        deleted++;
      }
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not delete ${path}: ${e.message}`);
      }
    }
  }
  return deleted;
}

export async function handleClean(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const logsDeleted = deleteOldFiles(ws.logsDir, sevenDaysMs);
  const approvalsDeleted = deleteOldFiles(ws.approvalsDir, oneDayMs);
  const killSignalsDeleted = deleteOldFiles(ws.killSignalsDir, oneDayMs);
  const pidsDeleted = deleteOldFiles(ws.pidsDir, oneDayMs);

  // Clean stale thread mappings — use log file mtime as proxy for last
  // activity so recently-used threads aren't pruned just because they
  // were created more than 7 days ago.
  let mappingsRemoved = 0;
  withThreadLock(ws.threadsFile, () => {
    const mapping = loadThreadMapping(ws.threadsFile);
    const now = Date.now();
    for (const [shortId, entry] of Object.entries(mapping)) {
      try {
        let lastActivity = new Date(entry.createdAt).getTime();
        if (Number.isNaN(lastActivity)) lastActivity = 0;
        const logPath = join(ws.logsDir, `${shortId}.log`);
        if (existsSync(logPath)) {
          lastActivity = Math.max(lastActivity, Bun.file(logPath).lastModified);
        }
        if (now - lastActivity > sevenDaysMs) {
          delete mapping[shortId];
          mappingsRemoved++;
        }
      } catch (e) {
        console.error(`[codex] Warning: skipping mapping ${shortId}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (mappingsRemoved > 0) {
      saveThreadMapping(ws.threadsFile, mapping);
    }
  });

  const parts: string[] = [];
  if (logsDeleted > 0) parts.push(`${logsDeleted} log files deleted`);
  if (approvalsDeleted > 0)
    parts.push(`${approvalsDeleted} approval files deleted`);
  if (killSignalsDeleted > 0)
    parts.push(`${killSignalsDeleted} kill signal files deleted`);
  if (pidsDeleted > 0)
    parts.push(`${pidsDeleted} stale PID files deleted`);
  if (mappingsRemoved > 0)
    parts.push(`${mappingsRemoved} stale mappings removed`);

  if (parts.length === 0) {
    console.log("Nothing to clean.");
  } else {
    console.log(`Cleaned: ${parts.join(", ")}.`);
  }
}
