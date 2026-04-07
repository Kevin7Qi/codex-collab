// src/commands/threads.ts — threads, output, progress, delete, clean commands

import { config, validateId } from "../config";
import {
  legacyResolveThreadId as resolveThreadId,
  legacyFindShortId as findShortId,
  legacyRemoveThread as removeThread,
  loadThreadMapping,
  saveThreadMapping,
  updateThreadStatus,
  withThreadLock,
} from "../threads";
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  die,
  parseOptions,
  validateIdOrDie,
  progress,
  formatAge,
  isProcessAlive,
  removePidFile,
  withClient,
  tryArchive,
} from "./shared";

// ---------------------------------------------------------------------------
// threads (list)
// ---------------------------------------------------------------------------

export async function handleThreads(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const mapping = loadThreadMapping(config.threadsFile);

  // Build entries sorted by updatedAt (most recent first), falling back to createdAt
  let entries = Object.entries(mapping)
    .map(([shortId, entry]) => ({ shortId, ...entry }))
    .sort((a, b) => {
      const ta = new Date(a.updatedAt ?? a.createdAt).getTime();
      const tb = new Date(b.updatedAt ?? b.createdAt).getTime();
      return tb - ta;
    });

  // Detect stale "running" status: if the owning process is dead, mark as interrupted.
  for (const e of entries) {
    if (e.lastStatus === "running" && !isProcessAlive(e.shortId)) {
      updateThreadStatus(config.threadsFile, e.threadId, "interrupted");
      e.lastStatus = "interrupted";
      removePidFile(e.shortId);
    }
  }

  if (options.limit !== Infinity) entries = entries.slice(0, options.limit);

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

/** Resolve a positional ID arg to a log file path, or die with an error. */
function resolveLogPath(positional: string[], usage: string): string {
  const id = positional[0];
  if (!id) die(usage);
  validateIdOrDie(id);
  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);
  if (!shortId) die(`Thread not found: ${id}`);
  return join(config.logsDir, `${shortId}.log`);
}

export async function handleOutput(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const logPath = resolveLogPath(positional, "Usage: codex-collab output <id>");
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
  const { positional } = parseOptions(args);
  const logPath = resolveLogPath(positional, "Usage: codex-collab progress <id>");
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
  const { positional } = parseOptions(args);
  const id = positional[0];
  if (!id) die("Usage: codex-collab delete <id>");
  validateIdOrDie(id);

  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);

  // If the thread is currently running, stop it first before archiving
  const localStatus = shortId ? loadThreadMapping(config.threadsFile)[shortId]?.lastStatus : undefined;
  if (localStatus === "running") {
    const signalPath = join(config.killSignalsDir, threadId);
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
    });
  } catch (e) {
    if (e instanceof Error && !e.message.includes("not found")) {
      console.error(`[codex] Warning: could not archive on server: ${e.message}`);
    }
  }

  if (shortId) {
    removePidFile(shortId);
    const logPath = join(config.logsDir, `${shortId}.log`);
    if (existsSync(logPath)) unlinkSync(logPath);
    removeThread(config.threadsFile, shortId);
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

export async function handleClean(_args: string[]): Promise<void> {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const logsDeleted = deleteOldFiles(config.logsDir, sevenDaysMs);
  const approvalsDeleted = deleteOldFiles(config.approvalsDir, oneDayMs);
  const killSignalsDeleted = deleteOldFiles(config.killSignalsDir, oneDayMs);
  const pidsDeleted = deleteOldFiles(config.pidsDir, oneDayMs);

  // Clean stale thread mappings — use log file mtime as proxy for last
  // activity so recently-used threads aren't pruned just because they
  // were created more than 7 days ago.
  let mappingsRemoved = 0;
  withThreadLock(config.threadsFile, () => {
    const mapping = loadThreadMapping(config.threadsFile);
    const now = Date.now();
    for (const [shortId, entry] of Object.entries(mapping)) {
      try {
        let lastActivity = new Date(entry.createdAt).getTime();
        if (Number.isNaN(lastActivity)) lastActivity = 0;
        const logPath = join(config.logsDir, `${shortId}.log`);
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
      saveThreadMapping(config.threadsFile, mapping);
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
