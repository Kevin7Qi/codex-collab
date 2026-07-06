// src/commands/threads.ts — threads, output, progress, delete, clean commands

import {
  registerThread,
  findShortId,
  removeThread,
  loadThreadIndex,
  mutateThreadIndex,
  removeLegacyGlobalThread,
  getLatestRun,
  removeRunsForThread,
  listRuns,
  listRunsForThread,
} from "../threads";
import { getCurrentSessionId } from "../broker";
import { resolveWorkspaceDir, resolveMailboxDir } from "../config";
import { sweepQuestions } from "../questions";
import type { AppServerClient } from "../client";
import type { Thread, RunRecord } from "../types";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
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
  resolveThreadIdAllowRaw,
  progress,
  formatAge,
  isThreadProcessAlive,
  removePidFile,
  withClient,
  tryArchive,
  tryServerDelete,
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

  const mapping = loadThreadIndex(ws.stateDir);
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
    registerThread(ws.stateDir, thread.id, {
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

  const mapping = loadThreadIndex(ws.stateDir);

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
    mutateThreadIndex(ws.stateDir, (fresh) => {
      const now = new Date().toISOString();
      for (const e of stale) {
        const entry = fresh[e.shortId];
        if (entry && entry.lastStatus === "running") {
          entry.lastStatus = "interrupted";
          entry.updatedAt = now;
        }
      }
    });
    for (const e of stale) {
      e.lastStatus = "interrupted";
      removePidFile(ws.pidsDir, e.shortId);
    }
  }

  // --session: only threads this session has run. Membership comes from the
  // run ledger — every invocation records its sessionId — so resumed threads
  // count, not just ones this session created.
  if (options.session) {
    const sessionId = getCurrentSessionId(ws.stateDir);
    const sessionThreads = sessionId
      ? new Set(listRuns(ws.stateDir, { sessionId }).map((r) => r.threadId))
      : new Set<string>();
    entries = entries.filter((e) => sessionThreads.has(e.threadId));
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

/** Resolve one run's own log file: the record's `logFile` (confined to the
 *  workspace or legacy-global logs dirs so a corrupted or adversarial run
 *  record cannot point us at arbitrary filesystem paths), with the shared
 *  thread log as the legacy fallback. Per-run records always
 *  point inside `logs/{shortId}/`; legacy records point at the shared file
 *  or (migration edge) an absolute global path. */
export function resolveRunLogPath(
  stateDir: string,
  logsDir: string,
  run: RunRecord,
  globalLogsDir: string = config.logsDir,
): string {
  if (run.logFile) {
    const candidate = resolve(stateDir, run.logFile);
    const confined = isPathInside(candidate, resolve(logsDir))
      || isPathInside(candidate, resolve(globalLogsDir));
    if (confined) return candidate;
  }
  return join(logsDir, `${run.shortId}.log`);
}

/** All log files for a thread in chronological order: legacy shared logs
 *  (pre-per-run history) first, then the per-run files under
 *  `logs/{shortId}/` — their base36-timestamp runId names make the sorted
 *  directory listing chronological. Legacy history is the workspace
 *  `logs/{shortId}.log` plus any confined log a run record points at
 *  outside the per-run dir — the migration edge where the only copy lives
 *  in the legacy global logs dir. That record-based scan must run even when
 *  per-run files exist: resuming a migrated thread creates per-run logs
 *  without ever copying the global one into the workspace. */
export function collectThreadLogPaths(
  stateDir: string,
  logsDir: string,
  shortId: string,
  globalLogsDir: string = config.logsDir,
): string[] {
  const paths: string[] = [];
  const legacy = join(logsDir, `${shortId}.log`);
  if (existsSync(legacy)) paths.push(legacy);
  const runDir = join(logsDir, shortId);
  for (const run of [...listRunsForThread(stateDir, shortId)].reverse()) { // oldest first
    if (!run.logFile) continue;
    const candidate = resolve(stateDir, run.logFile);
    const confined = isPathInside(candidate, resolve(logsDir))
      || isPathInside(candidate, resolve(globalLogsDir));
    if (!confined || isPathInside(candidate, runDir)) continue; // per-run files come from the dir listing below
    if (!paths.includes(candidate) && existsSync(candidate)) paths.push(candidate);
  }
  if (existsSync(runDir)) {
    for (const name of readdirSync(runDir).sort()) {
      if (name.endsWith(".log")) paths.push(join(runDir, name));
    }
  }
  return paths;
}

/** Concatenated log content for a thread, or null when it has none. */
export function readThreadLog(stateDir: string, logsDir: string, shortId: string): string | null {
  const paths = collectThreadLogPaths(stateDir, logsDir, shortId);
  if (paths.length === 0) return null;
  return paths.map((p) => readFileSync(p, "utf-8")).join("");
}

/** Resolve a positional ID arg to its shortId, or die. */
function resolveLogTarget(
  positional: string[],
  usage: string,
  ws: ReturnType<typeof getWorkspacePaths>,
): { shortId: string } {
  const id = positional[0];
  if (!id) die(usage);
  validateIdOrDie(id);
  const threadId = resolveThreadIdOrDie(ws.stateDir, id);
  const shortId = findShortId(ws.stateDir, threadId);
  if (!shortId) die(`Thread not found: ${id}`);
  return { shortId };
}

/** Extract agent output blocks from a thread log, one string per turn.
 *  Log format: "<ISO-timestamp> agent output:\n<content>\n<<END_AGENT_OUTPUT>>"
 *  Using an explicit end marker avoids false positives when model output
 *  contains timestamps. Exported for tests. */
export function extractAgentOutputBlocks(content: string): string[] {
  const tsPrefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    if (line === "<<END_AGENT_OUTPUT>>") {
      if (current) blocks.push(current.join("\n"));
      current = null;
      continue;
    }
    if (tsPrefix.test(line)) {
      // A new timestamped entry ends any open block (crash-truncated logs
      // can lack the end marker) — keep what was captured.
      if (current) blocks.push(current.join("\n"));
      current = line.includes(" agent output:") ? [] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

/** What `output --last` should print for a thread. Anchored to the latest
 *  RunRecord — the newest *log block* would silently replay an older turn's
 *  answer whenever the latest run hasn't produced output (still running,
 *  failed before any agent message, …). The log-block fallback is only for
 *  threads with no ledger records (pre-ledger history). Exported for tests. */
export type LastOutput =
  | { kind: "output"; text: string; note: string | null }
  | { kind: "none"; reason: string; running: boolean };

export function pickLastOutput(rec: RunRecord | null, logContent: string): LastOutput {
  if (rec) {
    if (rec.status === "running") {
      return { kind: "none", reason: "Run still in progress — no final output yet", running: true };
    }
    if (rec.output) {
      const note = rec.status === "completed"
        ? null
        : `latest run ${rec.status}${rec.error ? ` (${rec.error})` : ""} — output may be partial`;
      return { kind: "output", text: rec.output, note };
    }
    return {
      kind: "none",
      reason: `The latest run produced no output (status: ${rec.status}${rec.error ? `: ${rec.error}` : ""})`,
      running: false,
    };
  }
  const blocks = extractAgentOutputBlocks(logContent);
  if (blocks.length === 0) {
    return { kind: "none", reason: "No agent output in the thread log", running: false };
  }
  return { kind: "output", text: blocks[blocks.length - 1], note: null };
}

export async function handleOutput(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const { shortId } = resolveLogTarget(positional, "Usage: codex-collab output <id>", ws);
  // The log may not exist yet for a just-started run — for --last the run
  // record is authoritative, so only the log-reading modes require the file.
  const content = readThreadLog(ws.stateDir, ws.logsDir, shortId);
  if (options.last) {
    const res = pickLastOutput(getLatestRun(ws.stateDir, shortId), content ?? "");
    if (res.kind === "none") {
      const hint = res.running
        ? `Watch it: codex-collab follow ${shortId}`
        : `Full history: codex-collab output ${shortId}`;
      die(`${res.reason}\n${hint}`);
    }
    if (res.note) console.error(`[codex] Note: ${res.note}`);
    console.log(res.text);
    return;
  }
  if (content === null) die(`No log file for thread`);
  if (options.contentOnly) {
    const blocks = extractAgentOutputBlocks(content);
    for (const block of blocks) console.log(block);
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
  const { shortId } = resolveLogTarget(positional, "Usage: codex-collab progress <id>", ws);
  const content = readThreadLog(ws.stateDir, ws.logsDir, shortId);
  if (content === null) {
    console.log("No activity yet.");
    return;
  }

  // Show last 20 lines
  const lines = content.trim().split("\n");
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

  const { threadId, shortId } = resolveThreadIdAllowRaw(ws.stateDir, id);

  // If the thread is currently running, stop it first before archiving
  const localStatus = shortId ? loadThreadIndex(ws.stateDir)[shortId]?.lastStatus : undefined;
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

  let serverResult: "archived" | "deleted" | "already_done" | "failed" = "failed";
  try {
    serverResult = await withClient(async (client) => {
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

      // --purge: permanent server-side thread/delete — NOT recoverable with
      // `codex unarchive`. Default: archive, which is.
      return options.purge ? tryServerDelete(client, threadId) : tryArchive(client, threadId);
    }, options.dir);
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not found")) {
      console.error(`[codex] Warning: could not ${options.purge ? "delete" : "archive"} on server: ${e.message}`);
    }
  }

  // A failed PURGE keeps local state: the permanent deletion definitively
  // did not happen, and wiping the short-id mapping here would break the
  // retry we just suggested (`delete <id>` needs it). Archive failures are
  // lower stakes — the thread stays discoverable server-side — so plain
  // delete still cleans up locally as before.
  if (options.purge && serverResult === "failed") {
    die(`Server delete failed — local state kept so you can retry.\nArchive instead with: codex-collab delete ${id}`);
  }

  if (shortId) {
    removePidFile(ws.pidsDir, shortId);
    const logPath = join(ws.logsDir, `${shortId}.log`);
    if (existsSync(logPath)) unlinkSync(logPath);
    // Per-run log files live under logs/{shortId}/ and die with the thread.
    rmSync(join(ws.logsDir, shortId), { recursive: true, force: true });
    removeThread(ws.stateDir, shortId);
    // Run records must go with the thread: a stale `running` record whose
    // PID file is gone reads as alive and would make bare `follow` hang.
    removeRunsForThread(ws.stateDir, shortId);
    try {
      removeLegacyGlobalThread(options.dir, threadId);
    } catch (e) {
      console.error(`[codex] Warning: could not remove legacy thread entry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (serverResult === "failed") {
    progress(`Deleted local data for thread ${id} (server archive failed — the thread may still exist server-side)`);
  } else if (options.purge) {
    progress(`Permanently deleted thread ${id} (server + local)`);
  } else {
    progress(`Deleted thread ${id} (archived server-side; recover with: codex unarchive ${threadId})`);
  }
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

/** Delete files older than maxAgeMs in the given directory. With `recurse`,
 *  descend one level into subdirectories (per-run log dirs under logs/) and
 *  remove any left empty. Returns count deleted. */
function deleteOldFiles(dir: string, maxAgeMs: number, recurse = false): number {
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  let deleted = 0;
  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    try {
      if (statSync(path).isDirectory()) {
        if (recurse) {
          deleted += deleteOldFiles(path, maxAgeMs);
          try {
            rmdirSync(path); // only succeeds when empty
          } catch { /* still has fresh logs */ }
        }
        continue;
      }
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

  const logsDeleted = deleteOldFiles(ws.logsDir, sevenDaysMs, true);
  const approvalsDeleted = deleteOldFiles(ws.approvalsDir, oneDayMs);
  const killSignalsDeleted = deleteOldFiles(ws.killSignalsDir, oneDayMs);
  const pidsDeleted = deleteOldFiles(ws.pidsDir, oneDayMs);
  // Ask-channel mailbox: answered questions delete themselves; this catches
  // expired ones (kept for the audit trail) and orphans from killed askers.
  const questionsDeleted = sweepQuestions(resolveMailboxDir(options.dir), oneDayMs);

  // Clean stale thread mappings — use log file mtime as proxy for last
  // activity so recently-used threads aren't pruned just because they
  // were created more than 7 days ago.
  let mappingsRemoved = 0;
  mutateThreadIndex(ws.stateDir, (mapping) => {
    const now = Date.now();
    for (const [shortId, entry] of Object.entries(mapping)) {
      try {
        let lastActivity = new Date(entry.createdAt).getTime();
        if (Number.isNaN(lastActivity)) lastActivity = 0;
        // Legacy shared log AND per-run log files both count as activity.
        for (const logPath of collectThreadLogPaths(ws.stateDir, ws.logsDir, shortId)) {
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
    return mappingsRemoved > 0;
  });

  const parts: string[] = [];
  if (logsDeleted > 0) parts.push(`${logsDeleted} log files deleted`);
  if (approvalsDeleted > 0)
    parts.push(`${approvalsDeleted} approval files deleted`);
  if (killSignalsDeleted > 0)
    parts.push(`${killSignalsDeleted} kill signal files deleted`);
  if (pidsDeleted > 0)
    parts.push(`${pidsDeleted} stale PID files deleted`);
  if (questionsDeleted > 0)
    parts.push(`${questionsDeleted} old question files deleted`);
  if (mappingsRemoved > 0)
    parts.push(`${mappingsRemoved} stale mappings removed`);

  if (parts.length === 0) {
    console.log("Nothing to clean.");
  } else {
    console.log(`Cleaned: ${parts.join(", ")}.`);
  }
}
