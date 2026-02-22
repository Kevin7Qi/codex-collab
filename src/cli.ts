#!/usr/bin/env bun

// src/cli.ts — codex-collab CLI (app server protocol)

import {
  config,
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
import { resolve } from "path";
import type {
  ReviewTarget,
  ThreadListResponse,
  ModelListResponse,
  TurnResult,
} from "./types";

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
  resumeId: string | null;
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
    resumeId: null,
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
    } else if (arg === "-d" || arg === "--dir") {
      if (i + 1 >= args.length) {
        console.error("Error: --dir requires a value");
        process.exit(1);
      }
      options.dir = resolve(args[++i]);
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
      options.reviewMode = args[++i];
    } else if (arg === "--ref") {
      if (i + 1 >= args.length) {
        console.error("Error: --ref requires a value");
        process.exit(1);
      }
      options.reviewRef = args[++i];
    } else if (arg === "--resume") {
      if (i + 1 >= args.length) {
        console.error("Error: --resume requires a value");
        process.exit(1);
      }
      options.resumeId = args[++i];
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

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/** Validate that an ID is safe for use in file paths. */
function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    die(`Invalid ID: "${id}"`);
  }
  return id;
}

function progress(text: string): void {
  console.log(`[codex] ${text}`);
}

function getApprovalHandler(policy: ApprovalPolicy): ApprovalHandler {
  if (policy === "never") return autoApproveHandler;
  return new InteractiveApprovalHandler(config.approvalsDir, progress);
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Start or resume a thread, returning threadId and shortId. */
async function startOrResumeThread(
  client: AppServerClient,
  opts: Options,
  extraStartParams?: Record<string, unknown>,
): Promise<{ threadId: string; shortId: string }> {
  if (opts.resumeId) {
    const threadId = resolveThreadId(config.threadsFile, opts.resumeId);
    const shortId = findShortId(config.threadsFile, threadId) ?? opts.resumeId;
    await client.request("thread/resume", {
      threadId,
      model: opts.model,
      cwd: opts.dir,
      approvalPolicy: opts.approval,
    });
    return { threadId, shortId };
  }

  const startParams: Record<string, unknown> = {
    model: opts.model,
    cwd: opts.dir,
    approvalPolicy: opts.approval,
    ...extraStartParams,
  };
  const resp = await client.request<{ thread: { id: string } }>(
    "thread/start",
    startParams,
  );
  const threadId = resp.thread.id;
  registerThread(config.threadsFile, threadId, {
    model: opts.model,
    cwd: opts.dir,
  });
  const shortId = findShortId(config.threadsFile, threadId) ?? "unknown";
  return { threadId, shortId };
}

/** Print turn result and exit with appropriate code. */
function printResultAndExit(
  result: TurnResult,
  shortId: string,
  label: string,
  contentOnly: boolean,
): never {
  if (!contentOnly) {
    progress(`${label} ${result.status} (${formatDuration(result.durationMs)}${result.filesChanged.length > 0 ? `, ${pluralize(result.filesChanged.length, "file")} changed` : ""})`);
    if (result.output) console.log("\n--- Result ---");
  }

  if (result.output) console.log(result.output);
  if (result.error) console.error(`\nError: ${result.error}`);
  if (!contentOnly) console.error(`\nThread: ${shortId}`);

  process.exit(result.status === "completed" ? 0 : 1);
}

async function cmdRun(positional: string[], opts: Options) {
  if (positional.length === 0) {
    die("No prompt provided\nUsage: codex-collab run \"prompt\" [options]");
  }

  const prompt = positional.join(" ");
  const timeoutMs = opts.timeout * 1000;

  const client = await connect();
  const sandboxOverride = opts.sandbox !== config.defaultSandbox
    ? { sandbox: opts.sandbox }
    : undefined;
  const { threadId, shortId } = await startOrResumeThread(client, opts, sandboxOverride);

  if (!opts.contentOnly) {
    if (opts.resumeId) {
      progress(`Resumed thread ${shortId} (${opts.model})`);
    } else {
      progress(`Thread ${shortId} started (${opts.model}, ${opts.sandbox})`);
    }
    progress("Turn started");
  }

  const dispatcher = new EventDispatcher(
    shortId,
    config.logsDir,
    opts.contentOnly ? () => {} : progress,
  );

  const result = await runTurn(
    client,
    threadId,
    [{ type: "text", text: prompt }],
    {
      dispatcher,
      approvalHandler: getApprovalHandler(opts.approval),
      timeoutMs,
      cwd: opts.dir,
      model: opts.model,
      effort: opts.reasoning,
      approvalPolicy: opts.approval,
    },
  );

  await client.close();
  printResultAndExit(result, shortId, "Turn", opts.contentOnly);
}

async function cmdReview(positional: string[], opts: Options) {
  const mode = opts.reviewMode ?? "pr";
  const timeoutMs = opts.timeout * 1000;

  // Custom review: positional args become custom instructions
  let target: ReviewTarget;
  if (positional.length > 0) {
    target = { type: "custom", instructions: positional.join(" ") };
  } else {
    switch (mode) {
      case "pr":
        target = { type: "baseBranch", branch: "main" };
        break;
      case "uncommitted":
        target = { type: "uncommittedChanges" };
        break;
      case "commit":
        target = { type: "commit", sha: opts.reviewRef ?? "HEAD" };
        break;
      default: {
        const validModes = ["pr", "uncommitted", "commit"];
        die(
          `Unknown review mode: ${mode}. Use: ${validModes.join(", ")}`,
        );
      }
    }
  }

  const client = await connect();
  const { threadId, shortId } = await startOrResumeThread(
    client, opts, { sandbox: "read-only" },
  );

  if (!opts.contentOnly) {
    if (opts.resumeId) {
      progress(`Resumed thread ${shortId} for review`);
    } else {
      progress(`Thread ${shortId} started for review (${opts.model}, read-only)`);
    }
  }

  const dispatcher = new EventDispatcher(
    shortId,
    config.logsDir,
    opts.contentOnly ? () => {} : progress,
  );

  const result = await runReview(client, threadId, target, {
    dispatcher,
    approvalHandler: getApprovalHandler(opts.approval),
    timeoutMs,
    cwd: opts.dir,
    model: opts.model,
    approvalPolicy: opts.approval,
  });

  await client.close();
  printResultAndExit(result, shortId, "Review", opts.contentOnly);
}

async function cmdJobs(opts: Options) {
  const client = await connect();
  const resp = await client.request<ThreadListResponse>("thread/list", {
    limit: opts.limit,
    sortKey: "updated_at",
  });
  await client.close();

  const mapping = loadThreadMapping(config.threadsFile);
  const reverseMap = new Map<string, string>();
  for (const [shortId, entry] of Object.entries(mapping)) {
    reverseMap.set(entry.threadId, shortId);
  }

  if (opts.json) {
    const enriched = resp.data.map((t) => ({
      shortId: reverseMap.get(t.id) ?? null,
      threadId: t.id,
      status: t.status?.type ?? "unknown",
      source: t.source,
      cwd: t.cwd,
      createdAt: new Date(t.createdAt * 1000).toISOString(),
      updatedAt: new Date(t.updatedAt * 1000).toISOString(),
    }));
    console.log(JSON.stringify(enriched, null, 2));
  } else {
    if (resp.data.length === 0) {
      console.log("No threads found.");
      return;
    }
    for (const t of resp.data) {
      const sid = reverseMap.get(t.id) ?? "????????";
      const status = t.status?.type ?? t.source ?? "unknown";
      const age = formatAge(t.updatedAt);
      const preview = t.preview ? ` ${t.preview.slice(0, 40)}` : "";
      console.log(
        `  ${sid}  ${status.padEnd(10)} ${age.padEnd(8)} ${t.cwd}${preview}`,
      );
    }
  }
}

async function cmdKill(positional: string[]) {
  const id = positional[0];
  if (!id) die("Usage: codex-collab kill <id>");
  validateId(id);

  const threadId = resolveThreadId(config.threadsFile, id);
  const client = await connect();

  // Try to read thread status first and interrupt active turn if any
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
        progress(`Interrupted turn ${activeTurn.id}`);
      }
    }
  } catch {
    // Thread may not exist on server; continue to archive anyway
  }

  try {
    await client.request("thread/archive", { threadId });
  } catch {
    // Already archived or not found
  }

  await client.close();
  progress(`Archived thread ${id}`);
}

/** Resolve a positional ID arg to a log file path, or die with an error. */
function resolveLogPath(positional: string[], usage: string): string {
  const id = positional[0];
  if (!id) die(usage);
  validateId(id);
  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);
  if (!shortId) die(`Thread not found: ${id}`);
  return `${config.logsDir}/${shortId}.log`;
}

async function cmdOutput(positional: string[]) {
  const logPath = resolveLogPath(positional, "Usage: codex-collab output <id>");
  if (!existsSync(logPath)) die(`No log file for thread`);
  console.log(readFileSync(logPath, "utf-8"));
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
  const client = await connect();
  const resp = await client.request<ModelListResponse>("model/list", {});
  await client.close();

  for (const m of resp.data) {
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
  validateId(approvalId);

  const requestPath = `${config.approvalsDir}/${approvalId}.json`;
  if (!existsSync(requestPath))
    die(`No pending approval: ${approvalId}`);

  const decisionPath = `${config.approvalsDir}/${approvalId}.decision`;
  writeFileSync(decisionPath, decision);
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
    const path = `${dir}/${file}`;
    try {
      if (now - Bun.file(path).lastModified > maxAgeMs) {
        unlinkSync(path);
        deleted++;
      }
    } catch {
      // skip files we can't stat
    }
  }
  return deleted;
}

async function cmdClean() {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  const logsDeleted = deleteOldFiles(config.logsDir, sevenDaysMs);
  const approvalsDeleted = deleteOldFiles(config.approvalsDir, oneDayMs);

  // Clean stale thread mappings
  const mapping = loadThreadMapping(config.threadsFile);
  let mappingsRemoved = 0;
  const now = Date.now();
  for (const [shortId, entry] of Object.entries(mapping)) {
    if (now - new Date(entry.createdAt).getTime() > sevenDaysMs) {
      delete mapping[shortId];
      mappingsRemoved++;
    }
  }
  if (mappingsRemoved > 0) {
    saveThreadMapping(config.threadsFile, mapping);
  }

  const parts: string[] = [];
  if (logsDeleted > 0) parts.push(`${logsDeleted} log files deleted`);
  if (approvalsDeleted > 0)
    parts.push(`${approvalsDeleted} approval files deleted`);
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
  validateId(id);

  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);

  // Archive in Codex
  try {
    const client = await connect();
    await client.request("thread/archive", { threadId });
    await client.close();
  } catch {
    // Server may be unavailable or thread already archived
  }

  // Delete local files
  if (shortId) {
    const logPath = `${config.logsDir}/${shortId}.log`;
    if (existsSync(logPath)) unlinkSync(logPath);
    removeThread(config.threadsFile, shortId);
  }

  progress(`Deleted thread ${id}`);
}

async function cmdHealth() {
  // Check codex CLI exists
  const which = Bun.spawnSync(["which", "codex"]);
  if (which.exitCode !== 0) {
    die("codex CLI not found. Install: npm install -g @openai/codex");
  }

  console.log(`  bun:   ${Bun.version}`);
  console.log(`  codex: ${which.stdout.toString().trim()}`);

  // Try spawning app server and doing handshake
  try {
    const client = await connect();
    console.log(
      `  app-server: OK (${client.userAgent})`,
    );
    await client.close();
  } catch (e) {
    console.log(
      `  app-server: FAILED (${e instanceof Error ? e.message : e})`,
    );
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
  jobs [--json]           List threads
  kill <id>               Interrupt and archive thread
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
  --mode <mode>           Review mode: pr, uncommitted, commit
  --ref <hash>            Commit ref for --mode commit
  --json                  JSON output (jobs command)
  --content-only          Print only result text (no progress lines)
  --limit <n>             Limit items shown

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

/** Ensure data directories exist (called only for commands that need them). */
function ensureDataDirs(): void {
  mkdirSync(config.logsDir, { recursive: true });
  mkdirSync(config.approvalsDir, { recursive: true });
}

async function main() {
  if (rawArgs.length === 0) {
    showHelp();
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(rawArgs);

  // Create data directories for commands that need them
  // Commands that don't need data directories. "" = no command (shows help).
  const noDataDirCommands = new Set(["health", ""]);
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
      return cmdOutput(positional);
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
    default:
      console.error(`Error: Unknown command: ${command}`);
      console.error("Run codex-collab --help for usage");
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
