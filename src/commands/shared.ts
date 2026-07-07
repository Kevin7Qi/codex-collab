// src/commands/shared.ts — Shared utilities for CLI command modules

import {
  config,
  resolveStateDir,
  resolveMailboxDir,
  resolveModel,
  validateId,
  type ReasoningEffort,
  type SandboxMode,
  type ApprovalPolicy,
  type ApprovalMode,
} from "../config";
import { type AppServerClient, connectDirect } from "../client";
import { ensureConnection, getCurrentSessionId, isBrokerBusyError } from "../broker";
import {
  registerThread,
  resolveThreadId,
  findShortId,
  loadThreadIndex,
  updateThreadMeta,
  updateThreadStatus,
  generateRunId,
  runLogRelPath,
  ensureLedgerVersion,
  createRun,
  updateRun,
  loadRun,
  pruneRuns,
  migrateGlobalState,
  appendRunQuestion,
} from "../threads";
import type { PendingApproval, RunGoalState } from "../types";
import { RpcError, TurnTimeoutError } from "../types";
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
} from "fs";
import { resolve, join, dirname } from "path";
import type {
  ThreadForkParams,
  ThreadStartResponse,
  Model,
  TurnResult,
  RunRecord,
  ApprovalsReviewer,
} from "../types";

// ---------------------------------------------------------------------------
// Per-workspace paths
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  stateDir: string;
  logsDir: string;
  approvalsDir: string;
  killSignalsDir: string;
  pidsDir: string;
  runsDir: string;
  guardianDir: string;
}

export function getWorkspacePaths(cwd: string): WorkspacePaths {
  const stateDir = resolveStateDir(cwd);
  const paths = {
    stateDir,
    logsDir: join(stateDir, "logs"),
    approvalsDir: join(stateDir, "approvals"),
    killSignalsDir: join(stateDir, "kill-signals"),
    pidsDir: join(stateDir, "pids"),
    runsDir: join(stateDir, "runs"),
    guardianDir: join(stateDir, "guardian"),
  };
  // Lazily ensure workspace directories exist on first access.
  for (const dir of [paths.logsDir, paths.approvalsDir, paths.killSignalsDir, paths.pidsDir, paths.runsDir, paths.guardianDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Ensure global data dir exists for config.json
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Migrate legacy global state to per-workspace layout (idempotent)
  migrateGlobalState(cwd);
  // One-time run-ledger sweep (legacy "cancelled" → "interrupted"); cheap
  // version-marker check on every subsequent access.
  ensureLedgerVersion(stateDir);
  return paths;
}

// ---------------------------------------------------------------------------
// Options interface and argument parsing
// ---------------------------------------------------------------------------

export interface Options {
  reasoning: ReasoningEffort | undefined;
  model: string | undefined;
  sandbox: SandboxMode;
  approval: ApprovalMode;
  /** Opt-in: let Codex's memory feature learn from threads this run creates.
   *  Default off — created threads get thread/memoryMode/set mode=disabled. */
  memory: boolean;
  /** run: hand the turn to a detached runner process and return immediately. */
  detach: boolean;
  /** follow: don't exit when the run finishes — keep watching for the next one. */
  watch: boolean;
  /** delete: permanently delete the thread server-side instead of archiving. */
  purge: boolean;
  /** kill: clear (abandon) the thread's goal instead of pausing it. */
  clear: boolean;
  /** output: print only the latest turn's agent output (implies contentOnly). */
  last: boolean;
  /** approve: override a Guardian denial instead of answering a pending
   *  interactive approval request. */
  guardian: boolean;
  /** threads: only threads the current session has run. */
  session: boolean;
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
  full: boolean;
  help: boolean;
  template: string | null;
  /** run: create (or replace) the thread's goal with this objective before
   *  the first turn — the programmatic equivalent of the TUI's /goal. */
  goal: string | null;
  /** run: token budget for --goal. */
  budget: number | null;
  /** Flags explicitly provided on the command line (forwarded on resume). */
  explicit: Set<string>;
  /** Flags set by user config file (suppress auto-detection but NOT forwarded on resume). */
  configured: Set<string>;
}

/** Valid review modes for --mode flag. */
export const VALID_REVIEW_MODES = ["pr", "uncommitted", "commit", "custom"] as const;

/** Max --timeout / config timeout in seconds: the turn timeout feeds
 *  setTimeout(sec * 1000), and delays beyond 2^31-1 ms overflow the 32-bit
 *  timer and fire after ~1ms — every turn would instantly "time out". */
export const MAX_TIMEOUT_SECONDS = 2_147_483;

/** Shell metacharacters that must not appear in git refs. Braces are allowed
 *  so reflog refs like HEAD@{1} work — git is always invoked with an argv
 *  array here, never through a shell. */
const UNSAFE_REF_CHARS = /[;|&`$()<>\\'"\s]/;

export function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** Exit-code taxonomy for run/review, so background callers can branch on
 *  the outcome without text-sniffing stderr. 0/1 keep their universal
 *  meanings (usage and unclassified errors stay 1); 130/143 remain the
 *  signal-death codes set by the SIGINT/SIGTERM handlers. */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  /** Turn did not complete within --timeout. Resume with --resume <id>. */
  timeout: 3,
  /** Turn interrupted (`codex-collab kill` or server-side interrupt). */
  interrupted: 4,
  /** Turn died while blocked on an approval request. The request itself is
   *  void by the time this code is observed (the turn was interrupted and
   *  the handler's cleanup removed the request file) — the remedy is to
   *  resume with a longer --timeout, answer faster, or use --approval auto,
   *  NOT to answer the now-dead request. */
  approvalPending: 5,
  /** Broker stream owned by another invocation and the direct-connection
   *  fallback did not absorb it — transient, safe to retry. */
  brokerBusy: 6,
  /** The run followed a goal that ended needing a human: `blocked` (Codex
   *  stalled 3 consecutive turns) or a server brake (usage/token-budget
   *  limit). The goal persists on the thread — steer with a resume turn, or
   *  abandon it with `kill --clear`. */
  goalBlocked: 7,
} as const;

/** Errors can carry an explicit exit code (set where the context to classify
 *  them exists, e.g. an approval was pending when the turn died). */
export function tagExitCode(e: unknown, code: number): void {
  if (e !== null && typeof e === "object") {
    (e as { exitCode?: number }).exitCode = code;
  }
}

/** Map an error escaping main() to its exit code. A tagged code wins;
 *  otherwise classify by type. */
export function exitCodeForError(e: unknown): number {
  const tagged = e !== null && typeof e === "object" ? (e as { exitCode?: unknown }).exitCode : undefined;
  if (typeof tagged === "number") return tagged;
  if (isBrokerBusyError(e)) return EXIT_CODES.brokerBusy;
  if (e instanceof TurnTimeoutError) return EXIT_CODES.timeout;
  return EXIT_CODES.failed;
}

export function validateGitRef(value: string, label: string): string {
  // A leading dash is an option-injection primitive for whatever git
  // invocation ultimately receives the ref.
  if (!value || value.startsWith("-") || UNSAFE_REF_CHARS.test(value)) die(`Invalid ${label}: ${value}`);
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

/** Resolve a user-supplied thread ID or exit with a friendly error.
 *  "Thread not found" and "Ambiguous prefix" are user mistakes and should
 *  print as `Error: …`, not escape to main()'s `Fatal: …` handler. */
export function resolveThreadIdOrDie(stateDir: string, id: string): string {
  try {
    const resolved = resolveThreadId(stateDir, id);
    if (!resolved) die(`Thread not found: "${id}"`);
    return resolved.threadId;
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

/** Like resolveThreadIdOrDie, but an ID missing from the local index is
 *  treated as a raw server thread ID (shortId: null) instead of an error —
 *  peek, run --resume, kill, and delete all accept threads created by the
 *  Codex TUI or another workspace that were never discovered locally.
 *  Ambiguous prefixes and index corruption still die. Callers must
 *  validateIdOrDie(id) first. */
export function resolveThreadIdAllowRaw(
  stateDir: string,
  id: string,
): { threadId: string; shortId: string | null } {
  try {
    const resolved = resolveThreadId(stateDir, id);
    if (resolved) return resolved;
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  return { threadId: id, shortId: null };
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
    memory: false,
    detach: false,
    watch: false,
    purge: false,
    clear: false,
    guardian: false,
    dir: process.cwd(),
    last: false,
    session: false,
    contentOnly: false,
    json: false,
    timeout: config.defaultTimeout,
    limit: config.threadsListLimit,
    reviewMode: null,
    reviewRef: null,
    base: "main",
    resumeId: null,
    discover: false,
    full: false,
    help: false,
    template: null,
    goal: null,
    budget: null,
    explicit: new Set<string>(),
    configured: new Set<string>(),
  };
}

/** True iff argv[i+1] exists and is usable as the value of the flag at
 *  argv[i]. A next token that looks like another flag is rejected — silently
 *  swallowing it surfaces later as a baffling downstream error (e.g.
 *  `--template --content-only` failing with "Template not found:
 *  --content-only"). Negative numbers pass through so numeric flags can
 *  report their own, more specific validation error. */
function hasFlagValue(argv: string[], i: number): boolean {
  const next = argv[i + 1];
  if (next === undefined) return false;
  return !(next.length > 1 && next.startsWith("-") && !/^-\d/.test(next));
}

export function parseOptions(args: string[]): { positional: string[]; options: Options } {
  const options = defaultOptions();
  const positional: string[] = [];

  // Expand `--name=value` into two tokens so every flag branch handles just
  // the space-separated form. Tokens after the `--` end-of-options
  // terminator are left verbatim.
  const argv: string[] = [];
  let terminated = false;
  for (const arg of args) {
    if (terminated || arg === "--") {
      terminated = true;
      argv.push(arg);
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      argv.push(arg.slice(0, eq), arg.slice(eq + 1));
    } else {
      argv.push(arg);
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      // End of options: everything after is positional (allows prompts and
      // review instructions that start with a dash).
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-r" || arg === "--reasoning") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --reasoning requires a value");
        process.exit(1);
      }
      const level = argv[++i] as ReasoningEffort;
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
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --model requires a value");
        process.exit(1);
      }
      const model = argv[++i];
      if (!model || /[^a-zA-Z0-9._\-\/:]/.test(model)) {
        console.error(`Error: Invalid model name: ${model}`);
        process.exit(1);
      }
      options.model = model;
      options.explicit.add("model");
    } else if (arg === "-s" || arg === "--sandbox") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --sandbox requires a value");
        process.exit(1);
      }
      const mode = argv[++i] as SandboxMode;
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
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --approval requires a value");
        process.exit(1);
      }
      const policy = argv[++i] as ApprovalMode;
      if (!config.approvalModes.includes(policy)) {
        console.error(`Error: Invalid approval policy: ${policy}`);
        console.error(
          `Valid options: ${config.approvalModes.join(", ")}`
        );
        process.exit(1);
      }
      options.approval = policy;
      options.explicit.add("approval");
    } else if (arg === "-d" || arg === "--dir") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --dir requires a value");
        process.exit(1);
      }
      options.dir = resolve(argv[++i]);
      options.explicit.add("dir");
    } else if (arg === "--memory") {
      options.memory = true;
      options.explicit.add("memory");
    } else if (arg === "--detach") {
      options.detach = true;
    } else if (arg === "-w" || arg === "--watch") {
      options.watch = true;
    } else if (arg === "--purge") {
      options.purge = true;
    } else if (arg === "--clear") {
      options.clear = true;
    } else if (arg === "--last") {
      options.last = true;
      options.contentOnly = true;
    } else if (arg === "--guardian") {
      options.guardian = true;
    } else if (arg === "--session") {
      options.session = true;
    } else if (arg === "--content-only") {
      options.contentOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--goal") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --goal requires an objective");
        process.exit(1);
      }
      const objective = argv[++i].trim();
      if (!objective) {
        console.error("Error: --goal objective is empty");
        process.exit(1);
      }
      options.goal = objective;
    } else if (arg === "--budget") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --budget requires a value");
        process.exit(1);
      }
      const val = Number(argv[++i]);
      if (!Number.isInteger(val) || val <= 0) {
        console.error(`Error: Invalid budget: ${argv[i]} (must be a positive integer of tokens)`);
        process.exit(1);
      }
      options.budget = val;
    } else if (arg === "--timeout") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --timeout requires a value");
        process.exit(1);
      }
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || val <= 0 || val > MAX_TIMEOUT_SECONDS) {
        console.error(`Error: Invalid timeout: ${argv[i]} (must be 1-${MAX_TIMEOUT_SECONDS} seconds)`);
        process.exit(1);
      }
      options.timeout = val;
      options.explicit.add("timeout");
    } else if (arg === "--limit") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --limit requires a value");
        process.exit(1);
      }
      const val = Number(argv[++i]);
      if (!Number.isFinite(val) || val < 1) {
        console.error(`Error: Invalid limit: ${argv[i]}`);
        process.exit(1);
      }
      options.limit = Math.floor(val);
      options.explicit.add("limit");
    } else if (arg === "--mode") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --mode requires a value");
        process.exit(1);
      }
      const mode = argv[++i];
      if (!VALID_REVIEW_MODES.includes(mode as any)) {
        console.error(`Error: Invalid review mode: ${mode}`);
        console.error(`Valid options: ${VALID_REVIEW_MODES.join(", ")}`);
        process.exit(1);
      }
      options.reviewMode = mode;
    } else if (arg === "--ref") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --ref requires a value");
        process.exit(1);
      }
      options.reviewRef = validateGitRef(argv[++i], "ref");
    } else if (arg === "--base") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --base requires a value");
        process.exit(1);
      }
      options.base = validateGitRef(argv[++i], "base branch");
      options.explicit.add("base");
    } else if (arg === "--resume") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --resume requires a value");
        process.exit(1);
      }
      options.resumeId = argv[++i];
    } else if (arg === "--all") {
      options.limit = Infinity;
      options.explicit.add("limit");
    } else if (arg === "--discover") {
      options.discover = true;
    } else if (arg === "--full") {
      options.full = true;
    } else if (arg === "--template") {
      if (!hasFlagValue(argv, i)) {
        console.error("Error: --template requires a name");
        process.exit(1);
      }
      options.template = argv[++i];
    } else if (arg === "--unset") {
      options.explicit.add("unset");
    } else if (arg !== "-" && arg.startsWith("-")) {
      // Bare "-" is a positional by Unix convention (`run -` = prompt on stdin).
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
  approval?: ApprovalMode;
  timeout?: number;
  memory?: boolean;
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
      // Silently ignoring a broken config means user-set defaults disappear
      // without warning — fail fast so the user sees and fixes it.
      die(`Invalid JSON in ${config.configFile}: ${e.message}\nFix the file or remove it to use defaults.`);
    }
    console.error(`[codex] Warning: could not read config: ${e instanceof Error ? e.message : String(e)}`);
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
    if (!cfg.model || /[^a-zA-Z0-9._\-\/:]/.test(cfg.model)) {
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
    if (cfg.approval && config.approvalModes.includes(cfg.approval)) {
      options.approval = cfg.approval;
      options.configured.add("approval");
    } else {
      console.error(`[codex] Warning: ignoring invalid approval in config: ${cfg.approval}`);
    }
  }
  if (!options.explicit.has("memory") && cfg.memory !== undefined) {
    if (typeof cfg.memory === "boolean") {
      options.memory = cfg.memory;
    } else {
      console.error(`[codex] Warning: ignoring invalid memory in config: ${cfg.memory}`);
    }
  }
  if (!options.explicit.has("timeout") && cfg.timeout !== undefined) {
    if (typeof cfg.timeout === "number" && Number.isFinite(cfg.timeout) && cfg.timeout > 0 && cfg.timeout <= MAX_TIMEOUT_SECONDS) {
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
export let activeReviewThreadId: string | undefined;
export let activeShortId: string | undefined;
export let activeTurnId: string | undefined;
export let activeWsPaths: WorkspacePaths | undefined;
export let activeRunId: string | undefined;
export let shuttingDown = false;

export function setActiveClient(client: AppServerClient | undefined): void { activeClient = client; }
export function setActiveThreadId(id: string | undefined): void { activeThreadId = id; }
export function setActiveReviewThreadId(id: string | undefined): void { activeReviewThreadId = id; }
export function setActiveShortId(id: string | undefined): void { activeShortId = id; }
export function setActiveTurnId(id: string | undefined): void { activeTurnId = id; }
export function setActiveWsPaths(ws: WorkspacePaths | undefined): void { activeWsPaths = ws; }
export function setActiveRunId(id: string | undefined): void { activeRunId = id; }
export function setShuttingDown(val: boolean): void { shuttingDown = val; }

export interface ApprovalHandlerContext {
  workspaceDir?: string;
  /** Mirrors approval prompts into the thread log so observers that don't
   *  own this process's stdout (follow, Monitor, output) see them. */
  dispatcher?: EventDispatcher;
  /** With runId, mirrors the pending approval into the run record. */
  stateDir?: string;
  runId?: string;
}

export function getApprovalHandler(policy: ApprovalPolicy, approvalsDir: string, ctx?: ApprovalHandlerContext): ApprovalHandler {
  if (policy === "never") return autoApproveHandler;
  // Approval prompts must stay on the console even under --content-only
  // (they're actionable, not progress noise), so this bypasses the
  // dispatcher's console gate and logs separately.
  const onProgress = (line: string) => {
    progress(line);
    ctx?.dispatcher?.logLine(line);
  };
  const { stateDir, runId } = ctx ?? {};
  const onPending = stateDir && runId
    ? (pending: PendingApproval | null) => updateRun(stateDir, runId, { pendingApproval: pending })
    : undefined;
  return new InteractiveApprovalHandler(approvalsDir, onProgress, { workspaceDir: ctx?.workspaceDir, onPending });
}

/** Best-effort close that swallows + logs errors. Cleanup runs on every
 *  exit path; a failed close is not actionable for the caller. */
async function safeCloseClient(client: AppServerClient): Promise<void> {
  try {
    await client.close();
  } catch (e) {
    console.error(`[codex] Warning: cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Connect to app server, run fn, then close the client (even on error).
 *
 *  For streaming callers, transparently retries once via `connectDirect`
 *  when fn throws a BROKER_BUSY error. The broker's busy state is set when
 *  another invocation owns the shared stream; the initial check in
 *  `ensureConnection` is one-shot, so two callers can both pass it before
 *  either has actually claimed the stream — only the racing loser sees
 *  BROKER_BUSY on its first stream-owning RPC (`thread/start` etc.).
 *  Auto-falling back to a direct connection mirrors the documented
 *  parallel-execution behavior. */
export async function withClient<T>(fn: (client: AppServerClient) => Promise<T>, cwd?: string, streaming = false): Promise<T> {
  const workingDir = cwd ?? process.cwd();
  let client = await ensureConnection(workingDir, streaming);
  activeClient = client;
  try {
    try {
      return await fn(client);
    } catch (e) {
      if (!streaming || !isBrokerBusyError(e)) throw e;
      // Lost the busy race after handshake — drop the broker client and
      // retry via direct connection. The first attempt's side effects
      // (e.g. a failed RunRecord recorded by the command's own catch
      // handler) remain, like a user-observable "started, then retried"
      // sequence.
      console.error("[broker] Broker became busy after handshake — retrying with direct connection.");
      await safeCloseClient(client);
      client = await connectDirect({ cwd: workingDir });
      activeClient = client;
      return await fn(client);
    }
  } finally {
    await safeCloseClient(client);
    activeClient = undefined;
  }
}

export function createDispatcher(
  logPath: string,
  opts: Options,
  guardianDir?: string,
): EventDispatcher {
  return new EventDispatcher(
    logPath,
    opts.contentOnly ? () => {} : progress,
    guardianDir,
  );
}

/** Arm the ask channel on a dispatcher: `codex-collab ask` inside the turn
 *  surfaces via mailbox watchers and output markers, mirrored onto this run
 *  record (pendingQuestion while waiting, questions[] audit trail on
 *  resolution). Callers MUST call dispatcher.setQuestionContext(null) in
 *  their finally — the watchers are unref'd timers that outlive the turn,
 *  and a late callback would otherwise stamp pendingQuestion onto a record
 *  already written terminal. Observers never throw into the event path. */
export function armQuestionChannel(
  dispatcher: EventDispatcher,
  ws: WorkspacePaths,
  runId: string,
  workspaceDir: string,
): void {
  dispatcher.setQuestionContext({
    mailboxDir: resolveMailboxDir(workspaceDir),
    workspaceDir,
    onPending: (pending) => {
      try {
        updateRun(ws.stateDir, runId, { pendingQuestion: pending });
      } catch (e) {
        console.error(`[codex] Warning: could not mirror pending question: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    onResolved: (resolved) => {
      try {
        appendRunQuestion(ws.stateDir, runId, resolved);
      } catch (e) {
        console.error(`[codex] Warning: could not record resolved question: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
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
  // Resume paths forward only *explicitly provided* flags to the server
  // (see turnOverrides / startOrResumeThread) — auto-detected values would
  // be discarded, so the paginated model/list fetch is a wasted round-trip.
  if (opts.resumeId) return;
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

/** RunId injected by a `run --detach` parent (its ledger-handshake key).
 *  Sticky for this process's lifetime so the broker-busy retry re-creates
 *  the SAME record the parent is watching, but removed from the environment
 *  immediately so grandchildren (e.g. Codex itself invoking codex-collab
 *  inside the turn) can't collide with it.
 *
 *  Call this BEFORE establishing any client connection: the broker and
 *  app-server spawned there inherit this process's environment, and every
 *  shell command Codex runs inherits theirs — scrubbing only at thread-start
 *  time would leak the runId to all of them. */
let stickyInjectedRunId: string | null | undefined;

export function consumeInjectedRunId(): string | null {
  const fromEnv = process.env.CODEX_COLLAB_RUN_ID;
  if (fromEnv !== undefined) {
    delete process.env.CODEX_COLLAB_RUN_ID;
    stickyInjectedRunId = /^[a-zA-Z0-9_-]+$/.test(fromEnv) ? fromEnv : null;
  }
  return stickyInjectedRunId ?? null;
}

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
    // and pass it directly to the server (handles TUI-created threads not yet
    // discovered). Ambiguity and index corruption still throw and must surface:
    // ambiguity so the user can disambiguate, corruption because
    // bailOnCorruptThreads has just renamed the index aside and its message
    // explains how to recover.
    const resolved = resolveThreadId(ws.stateDir, opts.resumeId);
    if (resolved) {
      threadId = resolved.threadId;
    } else {
      validateId(opts.resumeId);
      threadId = opts.resumeId;
    }

    if (isReview) {
      const forkParams: ThreadForkParams = {
        threadId,
        ephemeral: true,
      };
      if (opts.explicit.has("model")) forkParams.model = opts.model;
      if (opts.explicit.has("dir")) forkParams.cwd = opts.dir;
      if (opts.explicit.has("approval")) Object.assign(forkParams, resolveApproval(opts.approval));
      // Codex resolves the review sub-agent's model from its own
      // `review_model` config key before falling back to the thread's model,
      // so a review_model in ~/.codex/config.toml would silently override the
      // model requested here. Pin review_model to the model this review runs
      // as: the explicit flag, else the thread's last known model. External
      // threads with no local record get no pin.
      const reviewModel = opts.explicit.has("model")
        ? opts.model
        : resolved
          ? loadThreadIndex(ws.stateDir)[resolved.shortId]?.model
          : undefined;
      if (reviewModel) forkParams.config = { review_model: reviewModel };
      // Reviews must run in read-only mode. `thread/resume.sandbox` is not
      // reliable for already-loaded broker threads, and `review/start` has no
      // per-turn sandbox override, so fork the resumed context into a fresh
      // read-only review thread.
      Object.assign(forkParams, extraStartParams ?? {});
      effective = await client.request<ThreadStartResponse>("thread/fork", forkParams);
      threadId = effective.thread.id;
      shortId = registerThread(ws.stateDir, threadId, {
        model: effective.model,
        cwd: effective.cwd ?? opts.dir,
        preview,
      });
      isNewThread = true;
    } else {
      shortId = findShortId(ws.stateDir, threadId) ?? opts.resumeId;
      const resumeParams: Record<string, unknown> = {
        threadId,
        persistExtendedHistory: false,
      };
      // Only forward flags that were explicitly provided on the command line
      if (opts.explicit.has("model")) resumeParams.model = opts.model;
      if (opts.explicit.has("dir")) resumeParams.cwd = opts.dir;
      if (opts.explicit.has("approval")) Object.assign(resumeParams, resolveApproval(opts.approval));
      if (opts.explicit.has("sandbox")) resumeParams.sandbox = opts.sandbox;
      // Forced overrides from caller (e.g., review forces sandbox to read-only)
      if (extraStartParams) Object.assign(resumeParams, extraStartParams);
      effective = await client.request<ThreadStartResponse>("thread/resume", resumeParams);
      // Ensure the thread is in our local index (may not be if it was created externally)
      if (!findShortId(ws.stateDir, threadId)) {
        shortId = registerThread(ws.stateDir, threadId, {
          model: effective.model,
          cwd: opts.dir,
          preview,
        });
      } else {
        // Refresh stored metadata so `threads` stays accurate after resume
        updateThreadMeta(ws.stateDir, threadId, {
          model: effective.model,
          ...(opts.explicit.has("dir") ? { cwd: opts.dir } : {}),
          ...(preview ? { preview } : {}),
        });
      }
    }
  } else {
    const startParams: Record<string, unknown> = {
      cwd: opts.dir,
      ...resolveApproval(opts.approval),
      sandbox: opts.sandbox,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: isReview,
      serviceName: config.serviceName,
      ...extraStartParams,
    };
    if (opts.model) startParams.model = opts.model;
    // Same review_model pin as the fork path above: without it, a
    // review_model in ~/.codex/config.toml would win over the model shown in
    // our own "started for review" progress line.
    if (isReview && opts.model) startParams.config = { review_model: opts.model };
    effective = await client.request<ThreadStartResponse>(
      "thread/start",
      startParams,
    );
    threadId = effective.thread.id;
    shortId = registerThread(ws.stateDir, threadId, {
      model: effective.model,
      cwd: opts.dir,
      preview,
    });
    isNewThread = true;
  }

  // Keep threads codex-collab creates out of Codex's memory consolidation
  // (~/.codex/memories) unless the user opts in with --memory: an agent
  // driving Codex on the user's behalf shouldn't shape Codex's learned
  // picture of how the user works. Only ever set on threads WE create —
  // memoryMode is a persistent per-thread flag, so setting it on a resumed
  // user-owned thread would silently exclude that thread from the user's
  // own memory. Review threads are skipped: they're ephemeral (never
  // written to disk, so structurally outside memory ingestion) and the
  // server rejects metadata updates on them. Non-fatal: requires the
  // experimentalApi capability and Codex ≥ 0.142.
  if (isNewThread && !isReview && !opts.memory) {
    try {
      await client.request("thread/memoryMode/set", { threadId, mode: "disabled" });
    } catch (e) {
      console.error(`[codex] Warning: could not exclude thread from Codex memory: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  const runId = consumeInjectedRunId() ?? generateRunId();
  const sessionId = getCurrentSessionId(ws.stateDir);

  createRun(ws.stateDir, {
    runId,
    threadId,
    shortId,
    kind: isReview ? "review" : "task",
    phase: "starting",
    status: "running",
    pid: process.pid,
    sessionId,
    // Per-run log file: this run owns it exclusively, so followers get
    // perfect attribution even when runs on one thread overlap. logOffset
    // stays for legacy records that share logs/{shortId}.log.
    logFile: runLogRelPath(shortId, runId),
    logOffset: 0,
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

/** Map a CLI approval mode to the app-server's wire params. "auto" generates
 *  approval requests like "on-request" but routes them to Codex's Guardian
 *  subagent (approvalsReviewer "auto_review"), which approves or denies
 *  autonomously — it never escalates to this client, so auto runs never
 *  block on a human. Decisions and denial rationales surface via the
 *  autoApprovalReview events and guardianWarning notifications.
 *
 *  Non-auto modes explicitly send approvalsReviewer "user" so selecting them
 *  is reversible: approvalsReviewer persists on the thread, and without the
 *  reset a thread once run with "auto" would keep routing approvals through
 *  Guardian even after the user explicitly asked for interactive control. */
export function resolveApproval(mode: ApprovalMode): {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
} {
  if (mode === "auto") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  return { approvalPolicy: mode, approvalsReviewer: "user" };
}

/** Map a kebab-case sandbox mode to the app-server's sandboxPolicy wire shape. */
export function sandboxPolicyFor(mode: SandboxMode): { type: string } {
  switch (mode) {
    case "read-only": return { type: "readOnly" };
    case "workspace-write": return { type: "workspaceWrite" };
    case "danger-full-access": return { type: "dangerFullAccess" };
  }
}

/** Per-turn parameter overrides: all values for new threads, explicit-only for resume. */
export function turnOverrides(opts: Options) {
  if (!opts.resumeId) {
    const o: Record<string, unknown> = { cwd: opts.dir, ...resolveApproval(opts.approval) };
    if (opts.model) o.model = opts.model;
    if (opts.reasoning) o.effort = opts.reasoning;
    return o;
  }
  const o: Record<string, unknown> = {};
  if (opts.explicit.has("dir")) o.cwd = opts.dir;
  if (opts.explicit.has("model")) o.model = opts.model;
  if (opts.explicit.has("reasoning")) o.effort = opts.reasoning;
  if (opts.explicit.has("approval")) Object.assign(o, resolveApproval(opts.approval));
  // thread/resume's `sandbox` is ignored once the thread is loaded in a
  // long-lived (broker) app-server, so carry an explicit -s as a per-turn
  // sandboxPolicy override — the only path that re-applies the new mode.
  if (opts.explicit.has("sandbox")) o.sandboxPolicy = sandboxPolicyFor(opts.sandbox);
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

/** Codex forwards upstream HTTP errors verbatim as (pretty-printed) JSON
 *  blobs — e.g. the 400 for `-r minimal` on accounts whose built-in tools
 *  (image_gen, web_search) require a higher effort. Extract the human
 *  message; fall back to the raw string for anything unrecognized. */
export function humanizeTurnError(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { message?: unknown };
      message?: unknown;
      status?: unknown;
    };
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === "string" && msg.length > 0) {
      return typeof parsed.status === "number" ? `${msg} (HTTP ${parsed.status})` : msg;
    }
  } catch { /* not JSON — print as-is */ }
  return raw;
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
  if (result.error) {
    const msg = humanizeTurnError(result.error);
    console.error(`\nError: ${msg}`);
    if (/reasoning\.effort/i.test(msg)) {
      console.error("Tip: this account's built-in tools need a higher reasoning effort — retry with -r low or higher.");
    }
  }
  if (result.status === "completed") return EXIT_CODES.ok;
  return result.status === "interrupted" ? EXIT_CODES.interrupted : EXIT_CODES.failed;
}

/**
 * Persist a successful turn's terminal state and print the result. Returns
 * the CLI exit code: `printResult`'s code on success, or 1 if state save
 * failed (the result is still printed so the user doesn't lose output).
 */
export function recordTerminalRunState(
  ws: WorkspacePaths,
  threadId: string,
  runId: string,
  result: TurnResult,
  label: "Turn" | "Review",
  contentOnly: boolean,
  /** Final goal snapshot for the record; undefined leaves the field as the
   *  live mirror last wrote it (non-goal runs never have one). */
  goal?: RunGoalState | null,
): number {
  // Snapshot before the terminal write below clears it: a non-completed end
  // with an approval still pending is the "healthy turn killed while blocked
  // on approval" case, and gets its own exit code.
  const hadPendingApproval = hasPendingApproval(ws.stateDir, runId);
  try {
    updateThreadStatus(ws.stateDir, threadId, result.status as "completed" | "failed" | "interrupted");
  } catch (e) {
    console.error(`[codex] Warning: could not update thread status for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let stateSaveFailed = false;
  try {
    updateRun(ws.stateDir, runId, {
      status: result.status,
      phase: "finalizing",
      completedAt: new Date().toISOString(),
      elapsed: formatDuration(result.durationMs),
      output: result.output || null,
      filesChanged: result.filesChanged,
      commandsRun: result.commandsRun,
      error: result.error ?? null,
      // A kill/timeout can end the run while the approval poll is asleep and
      // the process exits before its cleanup tick — never leave a terminal
      // record claiming an approval (or ask-channel question) is still pending.
      pendingApproval: null,
      pendingQuestion: null,
      ...(goal !== undefined ? { goal } : {}),
    });
  } catch (e) {
    console.error(`[codex] CRITICAL: could not save run state for ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[codex] The ${label.toLowerCase()} output is below; thread state on disk is stale.`);
    stateSaveFailed = true;
  }
  const printed = printResult(result, label, contentOnly);
  if (stateSaveFailed) return EXIT_CODES.failed;
  return printed !== EXIT_CODES.ok && hadPendingApproval ? EXIT_CODES.approvalPending : printed;
}

/** True iff the run record currently claims a pending approval. Read this
 *  BEFORE writing a terminal state — terminal writes always clear it. */
export function hasPendingApproval(stateDir: string, runId: string): boolean {
  try {
    return loadRun(stateDir, runId)?.pendingApproval != null;
  } catch {
    return false;
  }
}

/**
 * Record a failed turn — best-effort persistence of "failed" status and
 * an error string. Each call is wrapped separately so a state-save failure
 * doesn't shadow the original turn error the caller will rethrow.
 */
export function recordRunFailure(
  ws: WorkspacePaths,
  threadId: string,
  runId: string,
  error: unknown,
): void {
  try {
    updateThreadStatus(ws.stateDir, threadId, "failed");
  } catch (e) {
    console.error(`[codex] Warning: could not update thread status for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    updateRun(ws.stateDir, runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      // Same guarantee as recordTerminalRunState: terminal records never
      // claim a pending approval or question.
      pendingApproval: null,
      pendingQuestion: null,
    });
  } catch (e) {
    console.error(`[codex] Warning: could not record run failure for ${runId}: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/**
 * Read the PID file for a thread. Returns the parsed PID, or null if the
 * file is missing, unreadable, or contains an invalid value.
 *
 * Logs on real I/O errors (anything other than ENOENT) so unexpected
 * failures aren't silent.
 */
export function readPidFile(pidsDir: string, shortId: string): number | null {
  const pidPath = join(pidsDir, shortId);
  let raw: string;
  try {
    raw = readFileSync(pidPath, "utf-8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    console.error(`[codex] Warning: could not read PID file for ${shortId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error(`[codex] Warning: PID file for ${shortId} contains invalid value`);
    return null;
  }
  return pid;
}

/** Check if the process that owns a thread is still alive. Treats a missing
 *  PID file as alive (pre-PID-tracking threads, or write-failed PID files);
 *  treats an unreadable or invalid PID file as dead (already logged by
 *  `readPidFile`). When a valid PID is present, returns false on ESRCH and
 *  true on EPERM (process exists but we can't signal it). */
export function isThreadProcessAlive(pidsDir: string, shortId: string): boolean {
  const pid = readPidFile(pidsDir, shortId);
  if (pid === null) {
    // null can mean "no file" (treat as alive — pre-PID-tracking thread) or
    // "invalid contents" (already logged; treat as dead). Distinguish via
    // existsSync rather than re-reading.
    return !existsSync(join(pidsDir, shortId));
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

/** Try to permanently delete a thread on the server (thread/delete). Unlike
 *  archiving, this is NOT recoverable with `codex unarchive`. */
export async function tryServerDelete(client: AppServerClient, threadId: string): Promise<"deleted" | "already_done" | "failed"> {
  try {
    await client.request("thread/delete", { threadId });
    return "deleted";
  } catch (e) {
    // "Method not found" (JSON-RPC -32601: a Codex without thread/delete)
    // must NOT read as "thread already gone" — that would report a permanent
    // deletion that never happened.
    const methodUnsupported =
      (e instanceof RpcError && e.rpcCode === -32601) ||
      (e instanceof Error && /method not found/i.test(e.message));
    if (methodUnsupported) {
      console.error(`[codex] This Codex version does not support thread/delete — use plain \`delete\` (archive) instead.`);
      return "failed";
    }
    if (e instanceof Error && /not found/i.test(e.message)) {
      return "already_done";
    }
    console.error(`[codex] Warning: could not delete thread on server: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
