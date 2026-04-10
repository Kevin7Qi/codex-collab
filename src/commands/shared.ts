// src/commands/shared.ts — Shared utilities for CLI command modules

import {
  config,
  resolveStateDir,
  resolveModel,
  validateId,
  type ReasoningEffort,
  type SandboxMode,
  type ApprovalPolicy,
} from "../config";
import { type AppServerClient } from "../client";
import { ensureConnection, getCurrentSessionId } from "../broker";
import {
  legacyRegisterThread as registerThread,
  legacyResolveThreadId as resolveThreadId,
  legacyFindShortId as findShortId,
  legacyUpdateThreadMeta as updateThreadMeta,
  legacyRemoveThread as removeThread,
  updateThreadStatus,
  loadThreadMapping,
  saveThreadMapping,
  withThreadLock,
  generateRunId,
  createRun,
  updateRun,
  pruneRuns,
  migrateGlobalState,
} from "../threads";
import { EventDispatcher } from "../events";
import {
  autoApproveHandler,
  InteractiveApprovalHandler,
  type ApprovalHandler,
} from "../approvals";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "fs";
import { resolve, join, dirname } from "path";
import type {
  ThreadStartResponse,
  Model,
  TurnResult,
  RunRecord,
} from "../types";

// ---------------------------------------------------------------------------
// Per-workspace paths
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  stateDir: string;
  threadsFile: string;
  logsDir: string;
  approvalsDir: string;
  killSignalsDir: string;
  pidsDir: string;
  runsDir: string;
}

export function getWorkspacePaths(cwd: string): WorkspacePaths {
  const stateDir = resolveStateDir(cwd);
  const paths = {
    stateDir,
    threadsFile: join(stateDir, "threads.json"),
    logsDir: join(stateDir, "logs"),
    approvalsDir: join(stateDir, "approvals"),
    killSignalsDir: join(stateDir, "kill-signals"),
    pidsDir: join(stateDir, "pids"),
    runsDir: join(stateDir, "runs"),
  };
  // Lazily ensure workspace directories exist on first access.
  for (const dir of [paths.logsDir, paths.approvalsDir, paths.killSignalsDir, paths.pidsDir, paths.runsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Ensure global data dir exists for config.json
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Migrate legacy global state to per-workspace layout (idempotent)
  migrateGlobalState(cwd);
  return paths;
}

// ---------------------------------------------------------------------------
// Options interface and argument parsing
// ---------------------------------------------------------------------------

export interface Options {
  reasoning: ReasoningEffort | undefined;
  model: string | undefined;
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
  discover: boolean;
  help: boolean;
  template: string | null;
  /** Flags explicitly provided on the command line (forwarded on resume). */
  explicit: Set<string>;
  /** Flags set by user config file (suppress auto-detection but NOT forwarded on resume). */
  configured: Set<string>;
}

/** Valid review modes for --mode flag. */
export const VALID_REVIEW_MODES = ["pr", "uncommitted", "commit", "custom"] as const;

/** Shell metacharacters that must not appear in git refs. */
const UNSAFE_REF_CHARS = /[;|&`$()<>\\'"{\s]/;

export function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

export function validateGitRef(value: string, label: string): string {
  if (UNSAFE_REF_CHARS.test(value)) die(`Invalid ${label}: ${value}`);
  return value;
}

/** Validate ID, using die() for CLI-friendly error output. */
export function validateIdOrDie(id: string): string {
  try {
    return validateId(id);
  } catch {
    die(`Invalid ID: "${id}"`);
  }
}

export function progress(text: string): void {
  console.log(`[codex] ${text}`);
}

export function defaultOptions(): Options {
  return {
    reasoning: undefined,
    model: undefined,
    sandbox: config.defaultSandbox,
    approval: config.defaultApprovalPolicy,
    dir: process.cwd(),
    contentOnly: false,
    json: false,
    timeout: config.defaultTimeout,
    limit: config.threadsListLimit,
    reviewMode: null,
    reviewRef: null,
    base: "main",
    resumeId: null,
    discover: false,
    help: false,
    template: null,
    explicit: new Set<string>(),
    configured: new Set<string>(),
  };
}

export function parseOptions(args: string[]): { positional: string[]; options: Options } {
  const options = defaultOptions();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
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
      options.explicit.add("timeout");
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
      options.explicit.add("base");
    } else if (arg === "--resume") {
      if (i + 1 >= args.length) {
        console.error("Error: --resume requires a value");
        process.exit(1);
      }
      options.resumeId = args[++i];
    } else if (arg === "--all") {
      options.limit = Infinity;
    } else if (arg === "--discover") {
      options.discover = true;
    } else if (arg === "--template") {
      if (i + 1 >= args.length) {
        console.error("Error: --template requires a name");
        process.exit(1);
      }
      options.template = args[++i];
    } else if (arg === "--unset") {
      options.explicit.add("unset");
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option: ${arg}`);
      console.error("Run codex-collab --help for usage");
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  // Resolve model aliases (e.g., "spark" → "gpt-5.3-codex-spark")
  options.model = resolveModel(options.model);

  return { positional, options };
}

// ---------------------------------------------------------------------------
// User config — persistent defaults from ~/.codex-collab/config.json
// ---------------------------------------------------------------------------

/** Fields users can set in ~/.codex-collab/config.json. */
export interface UserConfig {
  model?: string;
  reasoning?: ReasoningEffort;
  sandbox?: SandboxMode;
  approval?: ApprovalPolicy;
  timeout?: number;
}

export function loadUserConfig(): UserConfig {
  try {
    const parsed = JSON.parse(readFileSync(config.configFile, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[codex] Warning: config file is not a JSON object — ignoring: ${config.configFile}`);
      return {};
    }
    return parsed as UserConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (e instanceof SyntaxError) {
      console.error(`[codex] Warning: invalid JSON in ${config.configFile} — ignoring config`);
    } else {
      console.error(`[codex] Warning: could not read config: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {};
  }
}

export function saveUserConfig(cfg: UserConfig): void {
  try {
    mkdirSync(dirname(config.configFile), { recursive: true, mode: 0o700 });
    writeFileSync(config.configFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  } catch (e) {
    die(`Could not save config to ${config.configFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Apply user config to parsed options — only for fields not set via CLI flags.
 *  Config values are added to `configured` (not `explicit`) so they suppress
 *  auto-detection but are NOT forwarded as overrides on thread resume. */
export function applyUserConfig(options: Options): void {
  const cfg = loadUserConfig();

  if (!options.explicit.has("model") && typeof cfg.model === "string") {
    if (/[^a-zA-Z0-9._\-\/:]/.test(cfg.model)) {
      console.error(`[codex] Warning: ignoring invalid model in config: ${cfg.model}`);
    } else {
      options.model = resolveModel(cfg.model);
      options.configured.add("model");
    }
  }
  if (!options.explicit.has("reasoning") && typeof cfg.reasoning === "string") {
    if (cfg.reasoning && config.reasoningEfforts.includes(cfg.reasoning)) {
      options.reasoning = cfg.reasoning;
      options.configured.add("reasoning");
    } else {
      console.error(`[codex] Warning: ignoring invalid reasoning in config: ${cfg.reasoning}`);
    }
  }
  if (!options.explicit.has("sandbox") && typeof cfg.sandbox === "string") {
    if (cfg.sandbox && config.sandboxModes.includes(cfg.sandbox)) {
      options.sandbox = cfg.sandbox;
      options.configured.add("sandbox");
    } else {
      console.error(`[codex] Warning: ignoring invalid sandbox in config: ${cfg.sandbox}`);
    }
  }
  if (!options.explicit.has("approval") && typeof cfg.approval === "string") {
    if (cfg.approval && config.approvalPolicies.includes(cfg.approval)) {
      options.approval = cfg.approval;
      options.configured.add("approval");
    } else {
      console.error(`[codex] Warning: ignoring invalid approval in config: ${cfg.approval}`);
    }
  }
  if (!options.explicit.has("timeout") && cfg.timeout !== undefined) {
    if (typeof cfg.timeout === "number" && Number.isFinite(cfg.timeout) && cfg.timeout > 0) {
      options.timeout = cfg.timeout;
    } else {
      console.error(`[codex] Warning: ignoring invalid timeout in config: ${cfg.timeout}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Client lifecycle helpers
// ---------------------------------------------------------------------------

/** Active client/thread tracking for signal handlers. */
export let activeClient: AppServerClient | undefined;
export let activeThreadId: string | undefined;
export let activeShortId: string | undefined;
export let activeTurnId: string | undefined;
export let activeWsPaths: WorkspacePaths | undefined;
export let activeRunId: string | undefined;
export let shuttingDown = false;

export function setActiveClient(client: AppServerClient | undefined): void { activeClient = client; }
export function setActiveThreadId(id: string | undefined): void { activeThreadId = id; }
export function setActiveShortId(id: string | undefined): void { activeShortId = id; }
export function setActiveTurnId(id: string | undefined): void { activeTurnId = id; }
export function setActiveWsPaths(ws: WorkspacePaths | undefined): void { activeWsPaths = ws; }
export function setActiveRunId(id: string | undefined): void { activeRunId = id; }
export function setShuttingDown(val: boolean): void { shuttingDown = val; }

export function getApprovalHandler(policy: ApprovalPolicy, approvalsDir: string): ApprovalHandler {
  if (policy === "never") return autoApproveHandler;
  return new InteractiveApprovalHandler(approvalsDir, progress);
}

/** Connect to app server, run fn, then close the client (even on error). */
export async function withClient<T>(fn: (client: AppServerClient) => Promise<T>, cwd?: string, streaming = false): Promise<T> {
  const client = await ensureConnection(cwd ?? process.cwd(), streaming);
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

export function createDispatcher(shortId: string, logsDir: string, opts: Options): EventDispatcher {
  return new EventDispatcher(
    shortId,
    logsDir,
    opts.contentOnly ? () => {} : progress,
  );
}

// ---------------------------------------------------------------------------
// Model auto-selection
// ---------------------------------------------------------------------------

/** Fetch all pages of a paginated endpoint. */
export async function fetchAllPages<T>(
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

/** Pick the best model by following the upgrade chain from the server default,
 *  then preferring a -codex variant if one exists at the latest generation. */
export function pickBestModel(models: Model[]): string | undefined {
  const byId = new Map(models.map(m => [m.id, m]));

  // Start from the server's default model
  let current = models.find(m => m.isDefault);
  if (!current) return undefined;

  // Follow the upgrade chain to the latest generation
  const visited = new Set<string>();
  while (current.upgrade && !visited.has(current.id)) {
    visited.add(current.id);
    const next = byId.get(current.upgrade);
    if (!next) break; // upgrade target not in the list
    current = next;
  }

  // Prefer -codex variant if available at this generation
  if (!current.id.endsWith("-codex")) {
    const codexVariant = byId.get(current.id + "-codex");
    if (codexVariant && codexVariant.upgrade === null) return codexVariant.id;
  }

  return current.id;
}

/** Pick the highest reasoning effort a model supports. */
function pickHighestEffort(supported: Array<{ reasoningEffort: string }>): ReasoningEffort | undefined {
  const available = new Set(supported.map(s => s.reasoningEffort));
  for (let i = config.reasoningEfforts.length - 1; i >= 0; i--) {
    if (available.has(config.reasoningEfforts[i])) return config.reasoningEfforts[i];
  }
  return undefined;
}

/** Auto-resolve model and/or reasoning effort when not set by CLI or config. */
export async function resolveDefaults(client: AppServerClient, opts: Options): Promise<void> {
  const isSet = (key: string) => opts.explicit.has(key) || opts.configured.has(key);
  const needModel = !isSet("model");
  const needReasoning = !isSet("reasoning");
  if (!needModel && !needReasoning) return;

  let models: Model[];
  try {
    models = await fetchAllPages<Model>(client, "model/list", { includeHidden: true });
  } catch (e) {
    console.error(`[codex] Warning: could not fetch model list (${e instanceof Error ? e.message : String(e)}). Model and reasoning will be determined by the server.`);
    return;
  }
  if (models.length === 0) {
    console.error(`[codex] Warning: server returned no models. Model and reasoning will be determined by the server.`);
    return;
  }

  if (needModel) {
    opts.model = pickBestModel(models);
  }

  if (needReasoning) {
    const modelData = models.find(m => m.id === opts.model);
    if (modelData?.supportedReasoningEfforts?.length) {
      opts.reasoning = pickHighestEffort(modelData.supportedReasoningEfforts);
    }
  }
}

// ---------------------------------------------------------------------------
// Thread start/resume
// ---------------------------------------------------------------------------

/** Start or resume a thread, returning threadId, shortId, runId, and effective config. */
export async function startOrResumeThread(
  client: AppServerClient,
  opts: Options,
  ws: WorkspacePaths,
  extraStartParams?: Record<string, unknown>,
  preview?: string,
  isReview = false,
): Promise<{ threadId: string; shortId: string; runId: string; effective: ThreadStartResponse }> {
  let threadId: string;
  let shortId: string;
  let effective: ThreadStartResponse;
  let isNewThread = false;

  if (opts.resumeId) {
    // Try local resolution first; if not found, treat the ID as a full thread ID
    // and pass it directly to the server (handles TUI-created threads not yet discovered)
    try {
      threadId = resolveThreadId(ws.threadsFile, opts.resumeId);
    } catch (e) {
      if (e instanceof Error && e.message.includes("Ambiguous")) {
        throw e; // Let user see the ambiguity error
      }
      // Thread not found locally — treat as raw server thread ID
      validateId(opts.resumeId);
      threadId = opts.resumeId;
    }
    shortId = findShortId(ws.threadsFile, threadId) ?? opts.resumeId;
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
    effective = await client.request<ThreadStartResponse>("thread/resume", resumeParams);
    // Ensure the thread is in our local index (may not be if it was created externally)
    if (!findShortId(ws.threadsFile, threadId)) {
      registerThread(ws.threadsFile, threadId, {
        model: effective.model,
        cwd: opts.dir,
        preview,
      });
      shortId = findShortId(ws.threadsFile, threadId) ?? shortId;
    } else {
      // Refresh stored metadata so `threads` stays accurate after resume
      updateThreadMeta(ws.threadsFile, threadId, {
        model: effective.model,
        ...(opts.explicit.has("dir") ? { cwd: opts.dir } : {}),
        ...(preview ? { preview } : {}),
      });
    }
  } else {
    const startParams: Record<string, unknown> = {
      cwd: opts.dir,
      approvalPolicy: opts.approval,
      sandbox: opts.sandbox,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: isReview,
      serviceName: config.serviceName,
      ...extraStartParams,
    };
    if (opts.model) startParams.model = opts.model;
    effective = await client.request<ThreadStartResponse>(
      "thread/start",
      startParams,
    );
    threadId = effective.thread.id;
    registerThread(ws.threadsFile, threadId, {
      model: effective.model,
      cwd: opts.dir,
      preview,
    });
    const resolvedShortId = findShortId(ws.threadsFile, threadId);
    if (!resolvedShortId) die(`Internal error: thread ${threadId.slice(0, 12)}... registered but not found in mapping`);
    shortId = resolvedShortId;
    isNewThread = true;
  }

  // Name new threads (non-fatal on failure)
  // Name new non-ephemeral threads (reviews are ephemeral — naming would fail)
  if (isNewThread && !isReview) {
    const threadName = preview?.slice(0, 100) ?? "codex-collab task";
    try {
      await client.request("thread/name/set", { threadId, name: threadName });
    } catch (e) {
      console.error(`[codex] Warning: could not name thread: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Create run record (Gap 1 + Gap 5 + Gap 6)
  const prompt = preview ?? null;
  const runId = generateRunId();
  const sessionId = getCurrentSessionId(ws.stateDir);
  const logPath = join(ws.logsDir, `${shortId}.log`);
  const logOffset = existsSync(logPath) ? statSync(logPath).size : 0;

  createRun(ws.stateDir, {
    runId,
    threadId,
    shortId,
    kind: isReview ? "review" : "task",
    phase: "starting",
    status: "running",
    sessionId,
    logFile: `logs/${shortId}.log`,
    logOffset,
    prompt,
    model: effective.model,
    startedAt: new Date().toISOString(),
    completedAt: null,
    elapsed: null,
    output: null,
    filesChanged: null,
    commandsRun: null,
    error: null,
  });
  pruneRuns(ws.stateDir);

  return { threadId, shortId, runId, effective };
}

// ---------------------------------------------------------------------------
// Turn overrides and result printing
// ---------------------------------------------------------------------------

/** Per-turn parameter overrides: all values for new threads, explicit-only for resume. */
export function turnOverrides(opts: Options) {
  if (!opts.resumeId) {
    const o: Record<string, unknown> = { cwd: opts.dir, approvalPolicy: opts.approval };
    if (opts.model) o.model = opts.model;
    if (opts.reasoning) o.effort = opts.reasoning;
    return o;
  }
  const o: Record<string, unknown> = {};
  if (opts.explicit.has("dir")) o.cwd = opts.dir;
  if (opts.explicit.has("model")) o.model = opts.model;
  if (opts.explicit.has("reasoning")) o.effort = opts.reasoning;
  if (opts.explicit.has("approval")) o.approvalPolicy = opts.approval;
  return o;
}

export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

export function formatAge(unixTimestamp: number): string {
  const seconds = Math.round(Date.now() / 1000 - unixTimestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Print turn result and return the appropriate exit code. */
export function printResult(
  result: TurnResult,
  label: string,
  contentOnly: boolean,
): number {
  if (!contentOnly) {
    progress(`${label} ${result.status} (${formatDuration(result.durationMs)}${result.filesChanged.length > 0 ? `, ${pluralize(result.filesChanged.length, "file")} changed` : ""})`);
    if (result.output) console.log("\n--- Result ---");
  }

  if (result.output) console.log(result.output);
  if (result.error) console.error(`\nError: ${result.error}`);
  return result.status === "completed" ? 0 : 1;
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

/** Write a PID file for the current process so threads list can detect stale "running" status. */
export function writePidFile(pidsDir: string, shortId: string): void {
  try {
    writeFileSync(join(pidsDir, shortId), String(process.pid), { mode: 0o600 });
  } catch (e) {
    console.error(`[codex] Warning: could not write PID file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Remove the PID file for a thread. */
export function removePidFile(pidsDir: string, shortId: string): void {
  try {
    unlinkSync(join(pidsDir, shortId));
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
export function isProcessAlive(pidsDir: string, shortId: string): boolean {
  const pidPath = join(pidsDir, shortId);
  let pid: number;
  try {
    pid = Number(readFileSync(pidPath, "utf-8").trim());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; // no PID file -> assume alive
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

/** Try to archive a thread on the server. Returns status string. */
export async function tryArchive(client: AppServerClient, threadId: string): Promise<"archived" | "already_done" | "failed"> {
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

