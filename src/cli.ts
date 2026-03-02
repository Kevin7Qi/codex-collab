#!/usr/bin/env bun

// src/cli.ts — codex-collab CLI (app server protocol)

import {
  config,
  validateId,
  type ReasoningEffort,
  type SandboxMode,
  type ApprovalPolicy,
} from "./config";
import { connect, type AppServerClient } from "./protocol";
import {
  registerThread,
  resolveThreadId,
  findShortId,
  loadThreadMapping,
  removeThread,
  saveThreadMapping,
  updateThreadStatus,
  withThreadLock,
} from "./threads";
import { runTurn, runReview } from "./turns";
import { EventDispatcher } from "./events";
import {
  autoApproveHandler,
  InteractiveApprovalHandler,
  type ApprovalHandler,
} from "./approvals";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { resolve, join } from "path";
import type {
  ReviewTarget,
  Thread,
  ThreadStartResponse,
  Model,
  TurnResult,
} from "./types";

// ---------------------------------------------------------------------------
// Signal handlers — clean up spawned app-server and update thread status
// ---------------------------------------------------------------------------

let activeClient: AppServerClient | undefined;
let activeThreadId: string | undefined;
let activeShortId: string | undefined;
let shuttingDown = false;

async function handleShutdownSignal(exitCode: number): Promise<void> {
  if (shuttingDown) {
    process.exit(exitCode);
  }
  shuttingDown = true;
  console.error("[codex] Shutting down...");

  // Update thread status and clean up PID file synchronously before async
  // cleanup — ensures the mapping is written even if client.close() hangs.
  if (activeThreadId) {
    try {
      updateThreadStatus(config.threadsFile, activeThreadId, "interrupted");
    } catch (e) {
      console.error(`[codex] Warning: could not update thread status during shutdown: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (activeShortId) {
    removePidFile(activeShortId);
  }

  try {
    if (activeClient) {
      await activeClient.close();
    }
  } catch (e) {
    console.error(`[codex] Warning: cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => handleShutdownSignal(130));
process.on("SIGTERM", () => handleShutdownSignal(143));

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Options;
}

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
  dir: string;
  contentOnly: boolean;
  json: boolean;
  timeout: number;
  limit: number;
  reviewMode: string | null;
  reviewRef: string | null;
  base: string;
  resumeId: string | null;
  /** Flags explicitly provided on the command line. */
  explicit: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const options: Options = {
    reasoning: config.defaultReasoningEffort,
    model: config.model,
    sandbox: config.defaultSandbox,
    approval: config.defaultApprovalPolicy,
    dir: process.cwd(),
    contentOnly: false,
    json: false,
    timeout: config.defaultTimeout,
    limit: config.jobsListLimit,
    reviewMode: null,
    reviewRef: null,
    base: "main",
    resumeId: null,
    explicit: new Set<string>(),
  };

  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      showHelp();
      process.exit(0);
    } else if (arg === "-r" || arg === "--reasoning") {
      if (i + 1 >= args.length) {
        console.error("Error: --reasoning requires a value");
        process.exit(1);
      }
      const level = args[++i] as ReasoningEffort;
      if (!config.reasoningEfforts.includes(level)) {
        console.error(`Error: Invalid reasoning level: ${level}`);
        console.error(
          `Valid options: ${config.reasoningEfforts.join(", ")}`
        );
        process.exit(1);
      }
      options.reasoning = level;
      options.explicit.add("reasoning");
    } else if (arg === "-m" || arg === "--model") {
      if (i + 1 >= args.length) {
        console.error("Error: --model requires a value");
        process.exit(1);
      }
      const model = args[++i];
      if (/[^a-zA-Z0-9._\-\/:]/.test(model)) {
        console.error(`Error: Invalid model name: ${model}`);
        process.exit(1);
      }
      options.model = model;
      options.explicit.add("model");
    } else if (arg === "-s" || arg === "--sandbox") {
      if (i + 1 >= args.length) {
        console.error("Error: --sandbox requires a value");
        process.exit(1);
      }
      const mode = args[++i] as SandboxMode;
      if (!config.sandboxModes.includes(mode)) {
        console.error(`Error: Invalid sandbox mode: ${mode}`);
        console.error(
          `Valid options: ${config.sandboxModes.join(", ")}`
        );
        process.exit(1);
      }
      options.sandbox = mode;
      options.explicit.add("sandbox");
    } else if (arg === "--approval") {
      if (i + 1 >= args.length) {
        console.error("Error: --approval requires a value");
        process.exit(1);
      }
      const policy = args[++i] as ApprovalPolicy;
      if (!config.approvalPolicies.includes(policy)) {
        console.error(`Error: Invalid approval policy: ${policy}`);
        console.error(
          `Valid options: ${config.approvalPolicies.join(", ")}`
        );
        process.exit(1);
      }
      options.approval = policy;
      options.explicit.add("approval");
    } else if (arg === "-d" || arg === "--dir") {
      if (i + 1 >= args.length) {
        console.error("Error: --dir requires a value");
        process.exit(1);
      }
      options.dir = resolve(args[++i]);
      options.explicit.add("dir");
    } else if (arg === "--content-only") {
      options.contentOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) {
        console.error("Error: --timeout requires a value");
        process.exit(1);
      }
      const val = Number(args[++i]);
      if (!Number.isFinite(val) || val <= 0) {
        console.error(`Error: Invalid timeout: ${args[i]}`);
        process.exit(1);
      }
      options.timeout = val;
    } else if (arg === "--limit") {
      if (i + 1 >= args.length) {
        console.error("Error: --limit requires a value");
        process.exit(1);
      }
      const val = Number(args[++i]);
      if (!Number.isFinite(val) || val < 1) {
        console.error(`Error: Invalid limit: ${args[i]}`);
        process.exit(1);
      }
      options.limit = Math.floor(val);
    } else if (arg === "--mode") {
      if (i + 1 >= args.length) {
        console.error("Error: --mode requires a value");
        process.exit(1);
      }
      const mode = args[++i];
      if (!VALID_REVIEW_MODES.includes(mode as any)) {
        console.error(`Error: Invalid review mode: ${mode}`);
        console.error(`Valid options: ${VALID_REVIEW_MODES.join(", ")}`);
        process.exit(1);
      }
      options.reviewMode = mode;
    } else if (arg === "--ref") {
      if (i + 1 >= args.length) {
        console.error("Error: --ref requires a value");
        process.exit(1);
      }
      options.reviewRef = validateGitRef(args[++i], "ref");
    } else if (arg === "--base") {
      if (i + 1 >= args.length) {
        console.error("Error: --base requires a value");
        process.exit(1);
      }
      options.base = validateGitRef(args[++i], "base branch");
    } else if (arg === "--resume") {
      if (i + 1 >= args.length) {
        console.error("Error: --resume requires a value");
        process.exit(1);
      }
      options.resumeId = args[++i];
    } else if (arg === "--all") {
      options.limit = Infinity;
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option: ${arg}`);
      console.error("Run codex-collab --help for usage");
      process.exit(1);
    } else {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, options };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid review modes for --mode flag. */
const VALID_REVIEW_MODES = ["pr", "uncommitted", "commit", "custom"] as const;

/** Shell metacharacters that must not appear in git refs. */
const UNSAFE_REF_CHARS = /[;|&`$()<>\\'"{\s]/;

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function validateGitRef(value: string, label: string): string {
  if (UNSAFE_REF_CHARS.test(value)) die(`Invalid ${label}: ${value}`);
  return value;
}

/** Validate ID, using die() for CLI-friendly error output. */
function validateIdOrDie(id: string): string {
  try {
    return validateId(id);
  } catch {
    die(`Invalid ID: "${id}"`);
  }
}

function progress(text: string): void {
  console.log(`[codex] ${text}`);
}

function getApprovalHandler(policy: ApprovalPolicy): ApprovalHandler {
  if (policy === "never") return autoApproveHandler;
  return new InteractiveApprovalHandler(config.approvalsDir, progress);
}

/** Connect to app server, run fn, then close the client (even on error). */
async function withClient<T>(fn: (client: AppServerClient) => Promise<T>): Promise<T> {
  const client = await connect();
  activeClient = client;
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch (e) {
      console.error(`[codex] Warning: cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    activeClient = undefined;
  }
}

function createDispatcher(shortId: string, opts: Options): EventDispatcher {
  return new EventDispatcher(
    shortId,
    config.logsDir,
    opts.contentOnly ? () => {} : progress,
  );
}

/** Try to archive a thread on the server. Returns status string. */
async function tryArchive(client: AppServerClient, threadId: string): Promise<"archived" | "already_done" | "failed"> {
  try {
    await client.request("thread/archive", { threadId });
    return "archived";
  } catch (e) {
    if (e instanceof Error && (e.message.includes("not found") || e.message.includes("archived"))) {
      return "already_done";
    }
    console.error(`[codex] Warning: could not archive thread: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

function resolveReviewTarget(positional: string[], opts: Options): ReviewTarget {
  const mode = opts.reviewMode ?? "pr";

  if (positional.length > 0) {
    if (opts.reviewMode !== null && opts.reviewMode !== "custom") {
      die(`--mode ${opts.reviewMode} does not accept positional arguments.\nUse --mode custom "instructions" for custom reviews.`);
    }
    return { type: "custom", instructions: positional.join(" ") };
  }

  if (mode === "custom") {
    die('Custom review mode requires instructions.\nUsage: codex-collab review "instructions"');
  }

  switch (mode) {
    case "pr":
      return { type: "baseBranch", branch: opts.base };
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "commit":
      return { type: "commit", sha: opts.reviewRef ?? "HEAD" };
    default:
      die(`Unknown review mode: ${mode}. Use: ${VALID_REVIEW_MODES.join(", ")}`);
  }
}

/** Per-turn parameter overrides: all values for new threads, explicit-only for resume. */
function turnOverrides(opts: Options) {
  if (!opts.resumeId) {
    return { cwd: opts.dir, model: opts.model, effort: opts.reasoning, approvalPolicy: opts.approval };
  }
  const o: Record<string, unknown> = {};
  if (opts.explicit.has("dir")) o.cwd = opts.dir;
  if (opts.explicit.has("model")) o.model = opts.model;
  if (opts.explicit.has("reasoning")) o.effort = opts.reasoning;
  if (opts.explicit.has("approval")) o.approvalPolicy = opts.approval;
  return o;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function formatAge(unixTimestamp: number): string {
  const seconds = Math.round(Date.now() / 1000 - unixTimestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Write a PID file for the current process so cmdJobs can detect stale "running" status. */
function writePidFile(shortId: string): void {
  try {
    writeFileSync(join(config.pidsDir, shortId), String(process.pid), { mode: 0o600 });
  } catch (e) {
    console.error(`[codex] Warning: could not write PID file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Remove the PID file for a thread. */
function removePidFile(shortId: string): void {
  try {
    unlinkSync(join(config.pidsDir, shortId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[codex] Warning: could not remove PID file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Check if the process that owns a thread is still alive.
 *  Returns true (assume alive) when the PID file is missing — the thread may
 *  have been started before PID tracking existed, or PID file write may have
 *  failed.  Only returns false when we have a PID and can confirm the process
 *  is gone (ESRCH). */
function isProcessAlive(shortId: string): boolean {
  const pidPath = join(config.pidsDir, shortId);
  let pid: number;
  try {
    pid = Number(readFileSync(pidPath, "utf-8").trim());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // no PID file → assume alive
    console.error(`[codex] Warning: could not read PID file for ${shortId}: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`[codex] Warning: PID file for ${shortId} contains invalid value`);
    return false;
  }
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // process confirmed dead
    if (code === "EPERM") return true; // process exists but we can't signal it
    // Unexpected error — assume alive to avoid incorrectly marking live threads as dead
    console.error(`[codex] Warning: could not check process for ${shortId}: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Start or resume a thread, returning threadId, shortId, and effective config. */
async function startOrResumeThread(
  client: AppServerClient,
  opts: Options,
  extraStartParams?: Record<string, unknown>,
): Promise<{ threadId: string; shortId: string; effective: ThreadStartResponse }> {
  if (opts.resumeId) {
    const threadId = resolveThreadId(config.threadsFile, opts.resumeId);
    const shortId = findShortId(config.threadsFile, threadId) ?? opts.resumeId;
    const resumeParams: Record<string, unknown> = {
      threadId,
      persistExtendedHistory: false,
    };
    // Only forward flags that were explicitly provided on the command line
    if (opts.explicit.has("model")) resumeParams.model = opts.model;
    if (opts.explicit.has("dir")) resumeParams.cwd = opts.dir;
    if (opts.explicit.has("approval")) resumeParams.approvalPolicy = opts.approval;
    if (opts.explicit.has("sandbox")) resumeParams.sandbox = opts.sandbox;
    // Forced overrides from caller (e.g., review forces sandbox to read-only)
    if (extraStartParams) Object.assign(resumeParams, extraStartParams);
    const effective = await client.request<ThreadStartResponse>("thread/resume", resumeParams);
    return { threadId, shortId, effective };
  }

  const startParams: Record<string, unknown> = {
    model: opts.model,
    cwd: opts.dir,
    approvalPolicy: opts.approval,
    sandbox: opts.sandbox,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    ...extraStartParams,
  };
  const effective = await client.request<ThreadStartResponse>(
    "thread/start",
    startParams,
  );
  const threadId = effective.thread.id;
  registerThread(config.threadsFile, threadId, {
    model: opts.model,
    cwd: opts.dir,
  });
  const shortId = findShortId(config.threadsFile, threadId);
  if (!shortId) die(`Internal error: thread ${threadId.slice(0, 12)}... registered but not found in mapping`);
  return { threadId, shortId, effective };
}

/** Print turn result and return the appropriate exit code. */
function printResult(
  result: TurnResult,
  shortId: string,
  label: string,
  contentOnly: boolean,
): number {
  if (!contentOnly) {
    progress(`${label} ${result.status} (${formatDuration(result.durationMs)}${result.filesChanged.length > 0 ? `, ${pluralize(result.filesChanged.length, "file")} changed` : ""})`);
    if (result.output) console.log("\n--- Result ---");
  }

  if (result.output) console.log(result.output);
  if (result.error) console.error(`\nError: ${result.error}`);
  if (!contentOnly) console.error(`\nThread: ${shortId}`);

  return result.status === "completed" ? 0 : 1;
}

async function cmdRun(positional: string[], opts: Options) {
  if (positional.length === 0) {
    die("No prompt provided\nUsage: codex-collab run \"prompt\" [options]");
  }

  const prompt = positional.join(" ");

  const exitCode = await withClient(async (client) => {
    const { threadId, shortId, effective } = await startOrResumeThread(client, opts);

    if (opts.contentOnly) {
      console.error(`[codex] Running (thread ${shortId})...`);
    } else {
      if (opts.resumeId) {
        progress(`Resumed thread ${shortId} (${effective.model})`);
      } else {
        progress(`Thread ${shortId} started (${effective.model}, ${opts.sandbox})`);
      }
      progress("Turn started");
    }

    updateThreadStatus(config.threadsFile, threadId, "running");
    activeThreadId = threadId;
    activeShortId = shortId;
    writePidFile(shortId);

    const dispatcher = createDispatcher(shortId, opts);

    try {
      const result = await runTurn(
        client,
        threadId,
        [{ type: "text", text: prompt }],
        {
          dispatcher,
          approvalHandler: getApprovalHandler(effective.approvalPolicy),
          timeoutMs: opts.timeout * 1000,
          ...turnOverrides(opts),
        },
      );

      updateThreadStatus(config.threadsFile, threadId, result.status as "completed" | "failed" | "interrupted");
      return printResult(result, shortId, "Turn", opts.contentOnly);
    } catch (e) {
      updateThreadStatus(config.threadsFile, threadId, "failed");
      throw e;
    } finally {
      activeThreadId = undefined;
      activeShortId = undefined;
      removePidFile(shortId);
    }
  });

  process.exit(exitCode);
}

async function cmdReview(positional: string[], opts: Options) {
  const target = resolveReviewTarget(positional, opts);

  const exitCode = await withClient(async (client) => {
    const { threadId, shortId, effective } = await startOrResumeThread(
      client, opts, { sandbox: "read-only" },
    );

    if (opts.contentOnly) {
      console.error(`[codex] Reviewing (thread ${shortId})...`);
    } else {
      if (opts.resumeId) {
        progress(`Resumed thread ${shortId} for review`);
      } else {
        progress(`Thread ${shortId} started for review (${effective.model}, read-only)`);
      }
    }

    updateThreadStatus(config.threadsFile, threadId, "running");
    activeThreadId = threadId;
    activeShortId = shortId;
    writePidFile(shortId);

    const dispatcher = createDispatcher(shortId, opts);

    // Note: effort (reasoning level) is not forwarded to reviews — the review/start
    // protocol does not accept an effort parameter (unlike turn/start).
    try {
      const result = await runReview(client, threadId, target, {
        dispatcher,
        approvalHandler: getApprovalHandler(effective.approvalPolicy),
        timeoutMs: opts.timeout * 1000,
        ...turnOverrides(opts),
      });

      updateThreadStatus(config.threadsFile, threadId, result.status as "completed" | "failed" | "interrupted");
      return printResult(result, shortId, "Review", opts.contentOnly);
    } catch (e) {
      updateThreadStatus(config.threadsFile, threadId, "failed");
      throw e;
    } finally {
      activeThreadId = undefined;
      activeShortId = undefined;
      removePidFile(shortId);
    }
  });

  process.exit(exitCode);
}

/** Fetch all pages of a paginated endpoint. */
async function fetchAllPages<T>(
  client: AppServerClient,
  method: string,
  baseParams?: Record<string, unknown>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { ...baseParams };
    if (cursor) params.cursor = cursor;
    const page = await client.request<{ data: T[]; nextCursor: string | null }>(method, params);
    items.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

async function cmdJobs(opts: Options) {
  const mapping = loadThreadMapping(config.threadsFile);
  const reverseMap = new Map<string, string>();
  for (const [shortId, entry] of Object.entries(mapping)) {
    reverseMap.set(entry.threadId, shortId);
  }

  // Fetch all pages from server — we filter to locally-known threads,
  // so a single page could miss local threads buried behind non-local ones.
  const allThreads = await withClient((client) =>
    fetchAllPages<Thread>(client, "thread/list", { sortKey: "updated_at" }),
  );

  // Only show threads created by this CLI (those with a local short ID mapping)
  let localThreads = allThreads.filter((t) => reverseMap.has(t.id));

  // Detect stale "running" status: if the owning process is dead, mark as interrupted.
  for (const t of localThreads) {
    const sid = reverseMap.get(t.id)!;
    const entry = mapping[sid];
    if (entry?.lastStatus === "running" && !isProcessAlive(sid)) {
      updateThreadStatus(config.threadsFile, t.id, "interrupted");
      entry.lastStatus = "interrupted";
      removePidFile(sid);
    }
  }

  if (opts.limit !== Infinity) localThreads = localThreads.slice(0, opts.limit);

  if (opts.json) {
    const enriched = localThreads.map((t) => {
      const sid = reverseMap.get(t.id)!;
      const entry = mapping[sid];
      return {
        shortId: sid,
        threadId: t.id,
        status: entry.lastStatus ?? "unknown",
        modelProvider: t.modelProvider,
        cwd: t.cwd,
        preview: t.preview || null,
        createdAt: new Date(t.createdAt * 1000).toISOString(),
        updatedAt: new Date(t.updatedAt * 1000).toISOString(),
      };
    });
    console.log(JSON.stringify(enriched, null, 2));
  } else {
    if (localThreads.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const t of localThreads) {
      const sid = reverseMap.get(t.id)!;
      const entry = mapping[sid];
      const status = entry.lastStatus ?? "idle";
      const age = formatAge(t.updatedAt);
      const preview = t.preview ? ` ${t.preview.slice(0, 50)}` : "";
      console.log(
        `  ${sid}  ${status.padEnd(12)} ${age.padEnd(8)} ${t.cwd}${preview}`,
      );
    }
  }
}

async function cmdKill(positional: string[]) {
  const id = positional[0];
  if (!id) die("Usage: codex-collab kill <id>");
  validateIdOrDie(id);

  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);

  // Skip kill for threads that have already reached a terminal status
  if (shortId) {
    const mapping = loadThreadMapping(config.threadsFile);
    const localStatus = mapping[shortId]?.lastStatus;
    if (localStatus && localStatus !== "running") {
      progress(`Thread ${id} is already ${localStatus}`);
      return;
    }
  }

  // Write kill signal file so the running process can detect the kill
  let killSignalWritten = false;
  const signalPath = join(config.killSignalsDir, threadId);
  try {
    writeFileSync(signalPath, "", { mode: 0o600 });
    killSignalWritten = true;
  } catch (e) {
    console.error(
      `[codex] Warning: could not write kill signal: ${e instanceof Error ? e.message : String(e)}. ` +
      `The running process may not detect the kill.`,
    );
  }

  // Try to interrupt the active turn on the server (immediate effect).
  // The kill signal file handles the case where the run process is polling.
  let serverInterrupted = false;
  await withClient(async (client) => {
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
          serverInterrupted = true;
          progress(`Interrupted turn ${activeTurn.id}`);
        }
      }
    } catch (e) {
      if (e instanceof Error && !e.message.includes("not found")) {
        console.error(`[codex] Warning: could not read/interrupt thread: ${e.message}`);
      }
    }
  });

  updateThreadStatus(config.threadsFile, threadId, "interrupted");
  if (shortId) removePidFile(shortId);
  if (killSignalWritten || serverInterrupted) {
    progress(`Stopped thread ${id}`);
  } else {
    progress(`Marked thread ${id} as interrupted, but could not signal the running process`);
  }
}

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

async function cmdOutput(positional: string[], opts: Options) {
  const logPath = resolveLogPath(positional, "Usage: codex-collab output <id>");
  if (!existsSync(logPath)) die(`No log file for thread`);
  const content = readFileSync(logPath, "utf-8");
  if (opts.contentOnly) {
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

async function cmdProgress(positional: string[]) {
  const logPath = resolveLogPath(positional, "Usage: codex-collab progress <id>");
  if (!existsSync(logPath)) {
    console.log("No activity yet.");
    return;
  }

  // Show last 20 lines
  const lines = readFileSync(logPath, "utf-8").trim().split("\n");
  console.log(lines.slice(-20).join("\n"));
}

async function cmdModels() {
  const allModels = await withClient((client) =>
    fetchAllPages<Model>(client, "model/list"),
  );

  for (const m of allModels) {
    const efforts =
      m.supportedReasoningEfforts?.map((o) => o.reasoningEffort).join(", ") ?? "";
    console.log(
      `  ${m.id.padEnd(25)} ${(m.description ?? "").slice(0, 50).padEnd(52)} ${efforts}`,
    );
  }
}

async function cmdApproveOrDecline(
  decision: "accept" | "decline",
  positional: string[],
) {
  const approvalId = positional[0];
  const verb = decision === "accept" ? "approve" : "decline";
  if (!approvalId) die(`Usage: codex-collab ${verb} <approval-id>`);
  validateIdOrDie(approvalId);

  const requestPath = join(config.approvalsDir, `${approvalId}.json`);
  if (!existsSync(requestPath))
    die(`No pending approval: ${approvalId}`);

  const decisionPath = join(config.approvalsDir, `${approvalId}.decision`);
  try {
    writeFileSync(decisionPath, decision, { mode: 0o600 });
  } catch (e) {
    die(`Failed to write approval decision: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(
    `${decision === "accept" ? "Approved" : "Declined"}: ${approvalId}`,
  );
}

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

async function cmdClean() {
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

async function cmdDelete(positional: string[]) {
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

async function cmdHealth() {
  const findCmd = process.platform === "win32" ? "where" : "which";
  const which = Bun.spawnSync([findCmd, "codex"]);
  if (which.exitCode !== 0) {
    die("codex CLI not found. Install: npm install -g @openai/codex");
  }

  console.log(`  bun:   ${Bun.version}`);
  // `where` on Windows returns multiple matches; show only the first
  console.log(`  codex: ${which.stdout.toString().trim().split("\n")[0].trim()}`);

  try {
    const userAgent = await withClient(async (client) => client.userAgent);
    console.log(`  app-server: OK (${userAgent})`);
  } catch (e) {
    console.log(`  app-server: FAILED (${e instanceof Error ? e.message : e})`);
    process.exit(1);
  }

  console.log("\nHealth check passed.");
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function showHelp() {
  console.log(`codex-collab — Claude + Codex collaboration tool

Usage: codex-collab <command> [options]

Commands:
  run "prompt" [opts]     Send prompt, wait for result, print output
  run --resume <id> "p"   Resume existing thread with new prompt
  review [opts]           Run code review (PR-style by default)
  review "instructions"   Custom review with specific focus
  jobs [--json] [--all]   List threads (--limit <n> to cap)
  kill <id>               Stop a running thread
  output <id>             Read full log for thread
  progress <id>           Show recent activity for thread
  models                  List available models
  approve <id>            Approve a pending request
  decline <id>            Decline a pending request
  clean                   Delete old logs and stale mappings
  delete <id>             Archive thread, delete local files
  health                  Check prerequisites

Options:
  -m, --model <model>     Model name (default: ${config.model})
  -r, --reasoning <lvl>   Reasoning: ${config.reasoningEfforts.join(", ")} (default: ${config.defaultReasoningEffort})
  -s, --sandbox <mode>    Sandbox: ${config.sandboxModes.join(", ")}
                          (default: ${config.defaultSandbox})
  -d, --dir <path>        Working directory (default: cwd)
  --resume <id>           Resume existing thread
  --timeout <sec>         Turn timeout in seconds (default: ${config.defaultTimeout})
  --approval <policy>     Approval: ${config.approvalPolicies.join(", ")} (default: ${config.defaultApprovalPolicy})
  --mode <mode>           Review mode: ${VALID_REVIEW_MODES.join(", ")}
  --ref <hash>            Commit ref for --mode commit
  --base <branch>         Base branch for PR review (default: main)
  --content-only          Print only result text (no progress lines)

Examples:
  codex-collab run "what does this project do?" -s read-only --content-only
  codex-collab run --resume abc123 "now summarize the key files" --content-only
  codex-collab review -d /path/to/project --content-only
  codex-collab review --mode uncommitted -d /path/to/project --content-only
  codex-collab review "Focus on security issues" --content-only
  codex-collab jobs --json
  codex-collab kill abc123
  codex-collab health
`);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/** Ensure data directories exist (called only for commands that need them).
 *  Config getters throw if the home directory cannot be determined, producing a clear error. */
function ensureDataDirs(): void {
  mkdirSync(config.logsDir, { recursive: true });
  mkdirSync(config.approvalsDir, { recursive: true });
  mkdirSync(config.killSignalsDir, { recursive: true });
  mkdirSync(config.pidsDir, { recursive: true });
}

async function main() {
  if (rawArgs.length === 0) {
    showHelp();
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(rawArgs);

  // Validate command before setting up data directories.
  // Keep in sync with the switch below.
  const knownCommands = new Set([
    "run", "review", "jobs", "kill", "output", "progress",
    "models", "approve", "decline", "clean", "delete", "health",
  ]);
  if (!knownCommands.has(command)) {
    console.error(`Error: Unknown command: ${command}`);
    console.error("Run codex-collab --help for usage");
    process.exit(1);
  }

  // Create data directories for commands that need them
  const noDataDirCommands = new Set(["health", "models"]);
  if (!noDataDirCommands.has(command)) {
    ensureDataDirs();
  }

  switch (command) {
    case "run":
      return cmdRun(positional, options);
    case "review":
      return cmdReview(positional, options);
    case "jobs":
      return cmdJobs(options);
    case "kill":
      return cmdKill(positional);
    case "output":
      return cmdOutput(positional, options);
    case "progress":
      return cmdProgress(positional);
    case "models":
      return cmdModels();
    case "approve":
      return cmdApproveOrDecline("accept", positional);
    case "decline":
      return cmdApproveOrDecline("decline", positional);
    case "clean":
      return cmdClean();
    case "delete":
      return cmdDelete(positional);
    case "health":
      return cmdHealth();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Fatal: ${msg}`);
  if (msg.includes("timed out")) {
    console.error("Tip: Resume with --resume <id> or increase --timeout");
  }
  process.exit(1);
});
