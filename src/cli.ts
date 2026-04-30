#!/usr/bin/env bun

// src/cli.ts — codex-collab CLI router

import { config } from "./config";
import type { AppServerClient } from "./client";
import { updateThreadStatus, updateRun } from "./threads";
import {
  activeClient,
  activeThreadId,
  activeShortId,
  activeTurnId,
  activeWsPaths,
  activeRunId,
  shuttingDown,
  setShuttingDown,
  removePidFile,
  VALID_REVIEW_MODES,
} from "./commands/shared";

// ---------------------------------------------------------------------------
// Signal handlers — clean up spawned app-server and update thread status
// ---------------------------------------------------------------------------

async function handleShutdownSignal(exitCode: number): Promise<void> {
  if (shuttingDown) {
    process.exit(exitCode);
  }
  setShuttingDown(true);
  console.error("[codex] Shutting down...");

  // Update thread status and clean up PID file synchronously before async
  // cleanup — ensures the mapping is written even if client.close() hangs.
  if (activeThreadId && activeWsPaths) {
    try {
      updateThreadStatus(activeWsPaths.threadsFile, activeThreadId, "interrupted");
    } catch (e) {
      console.error(`[codex] Warning: could not update thread status during shutdown: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (activeRunId) {
      try {
        updateRun(activeWsPaths.stateDir, activeRunId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Interrupted by signal",
        });
      } catch (e) {
        console.error(`[codex] Warning: could not update run record during shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (activeShortId && activeWsPaths) {
    removePidFile(activeWsPaths.pidsDir, activeShortId);
  }

  // Try to interrupt the active turn before disconnecting (prevents
  // orphaned turns when using the broker — closing the socket alone
  // only disconnects from the broker, the turn keeps running).
  if (activeClient && activeThreadId && activeTurnId) {
    try {
      await activeClient.request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId });
    } catch (e) {
      // Best effort — may fail if turn already completed
      if (e instanceof Error && !e.message.includes("not found") && !e.message.includes("already")) {
        console.error(`[codex] Warning: could not interrupt turn: ${e.message}`);
      }
    }
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
  threads [--json] [--all] List threads (--limit <n>, --discover)
  kill <id>               Stop a running thread
  output <id>             Read full log for thread
  progress <id>           Show recent activity for thread
  peek <id>               Show recent conversation slice from server
  config [key] [value]    Show or set persistent defaults
  models                  List available models
  templates               List available prompt templates
  approve <id>            Approve a pending request
  decline <id>            Decline a pending request
  clean                   Delete old logs and stale mappings
  delete <id>             Archive thread, delete local files
  health                  Check prerequisites

Options:
  -m, --model <model>     Model name (default: auto — latest available)
  -r, --reasoning <lvl>   Reasoning: ${config.reasoningEfforts.join(", ")} (default: auto — highest available)
  -s, --sandbox <mode>    Sandbox: ${config.sandboxModes.join(", ")}
                          (default: ${config.defaultSandbox})
  -d, --dir <path>        Working directory (default: cwd)
  --resume <id>           Resume existing thread
  --timeout <sec>         Turn timeout in seconds (default: ${config.defaultTimeout})
  --approval <policy>     Approval: ${config.approvalPolicies.join(", ")} (default: ${config.defaultApprovalPolicy})
  --mode <mode>           Review mode: ${VALID_REVIEW_MODES.join(", ")}
  --ref <hash>            Commit ref for --mode commit
  --base <branch>         Base branch for PR review (default: main)
  --template <name>       Prompt template (run command; checks ~/.codex-collab/templates/ first)
  --limit <n>             Number of items shown (peek, threads commands)
  --full                  Include all item types (peek command)
  --content-only          Print only result text (no progress lines)

Examples:
  codex-collab run "what does this project do?" -s read-only --content-only
  codex-collab run --resume abc123 "now summarize the key files" --content-only
  codex-collab review -d /path/to/project --content-only
  codex-collab review --mode uncommitted -d /path/to/project --content-only
  codex-collab review "Focus on security issues" --content-only
  codex-collab threads --json
  codex-collab kill abc123
  codex-collab health
`);
}

// ---------------------------------------------------------------------------
// Argument pre-scan: extract command name and check for --help
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

function extractCommand(args: string[]): { command: string; rest: string[] } {
  // Scan for --help / -h before any command
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      showHelp();
      process.exit(0);
    }
    // Stop at first unknown flag — let command modules handle errors
    if (arg.startsWith("-")) break;
    // First non-flag is the command
    return { command: arg, rest: args.slice(args.indexOf(arg) + 1) };
  }
  // No command found — check for bare flags
  for (const arg of args) {
    if (arg.startsWith("-") && arg !== "-h" && arg !== "--help") {
      console.error(`Error: Unknown option: ${arg}`);
      console.error("Run codex-collab --help for usage");
      process.exit(1);
    }
  }
  return { command: "", rest: [] };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main() {
  if (rawArgs.length === 0) {
    showHelp();
    process.exit(0);
  }

  const { command, rest } = extractCommand(rawArgs);

  if (!command) {
    showHelp();
    process.exit(0);
  }

  // Validate command
  const knownCommands = new Set([
    "run", "review", "threads", "jobs", "kill", "output", "progress",
    "config", "models", "templates", "approve", "decline", "clean", "delete", "health",
    "peek",
  ]);
  if (!knownCommands.has(command)) {
    console.error(`Error: Unknown command: ${command}`);
    console.error("Run codex-collab --help for usage");
    process.exit(1);
  }

  // Handle --help after a command (e.g., "codex-collab run --help")
  if (rest.includes("-h") || rest.includes("--help")) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case "run":
      return (await import("./commands/run")).handleRun(rest);
    case "review":
      return (await import("./commands/review")).handleReview(rest);
    case "threads":
      return (await import("./commands/threads")).handleThreads(rest);
    case "jobs":
      console.error("[codex] Warning: 'jobs' is deprecated, use 'threads'");
      return (await import("./commands/threads")).handleThreads(rest);
    case "kill":
      return (await import("./commands/kill")).handleKill(rest);
    case "output":
      return (await import("./commands/threads")).handleOutput(rest);
    case "progress":
      return (await import("./commands/threads")).handleProgress(rest);
    case "config":
      return (await import("./commands/config")).handleConfig(rest);
    case "models":
      return (await import("./commands/config")).handleModels(rest);
    case "templates":
      return (await import("./commands/config")).handleTemplates(rest);
    case "approve":
      return (await import("./commands/approve")).handleApprove(rest);
    case "decline":
      return (await import("./commands/approve")).handleDecline(rest);
    case "clean":
      return (await import("./commands/threads")).handleClean(rest);
    case "delete":
      return (await import("./commands/threads")).handleDelete(rest);
    case "health":
      return (await import("./commands/config")).handleHealth(rest);
    case "peek":
      return (await import("./commands/peek")).handlePeek(rest);
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
