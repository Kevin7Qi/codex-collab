#!/usr/bin/env bun

// src/cli.ts — codex-collab CLI router

import { config } from "./config";
import type { AppServerClient } from "./client";
import { updateThreadStatus, updateRun } from "./threads";
import { tryInterruptTurn } from "./turns";
import {
  activeClient,
  activeThreadId,
  activeReviewThreadId,
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

  // Interrupt the active turn before disconnecting. Closing the socket
  // alone only detaches from the broker; the turn would keep running and
  // hold the broker stream busy. For reviews the turn lives on a review
  // subthread distinct from activeThreadId — route there when known.
  const interruptThreadId = activeReviewThreadId ?? activeThreadId;
  if (activeClient && interruptThreadId && activeTurnId) {
    await tryInterruptTurn(activeClient, interruptThreadId, activeTurnId);
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

function printVersion() {
  console.log(`codex-collab ${config.clientVersion}`);
}

function showHelp() {
  console.log(`codex-collab ${config.clientVersion} — Claude + Codex collaboration tool

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
  version                 Print version

Options:
  -m, --model <model>     Model name (default: auto — latest available)
  -r, --reasoning <lvl>   Reasoning: ${config.reasoningEfforts.join(", ")} (default: auto — highest available)
  -s, --sandbox <mode>    Sandbox: ${config.sandboxModes.join(", ")}
                          (default: ${config.defaultSandbox})
  -d, --dir <path>        Working directory (default: cwd)
  --resume <id>           Resume existing thread
  --timeout <sec>         Turn timeout in seconds (default: ${config.defaultTimeout})
  --approval <policy>     Approval: ${config.approvalModes.join(", ")} (default: ${config.defaultApprovalPolicy})
                          "auto" routes requests to Codex's Guardian reviewer;
                          only its escalations reach approve/decline
  --memory                Let Codex's memory feature learn from threads this
                          run creates (default: created threads are excluded)
  --mode <mode>           Review mode: ${VALID_REVIEW_MODES.join(", ")}
  --ref <hash>            Commit ref for --mode commit
  --base <branch>         Base branch for PR review (default: auto-detected default branch)
  --template <name>       Prompt template (run command; checks ~/.codex-collab/templates/ first)
  --limit <n>             Number of items shown (peek, threads commands)
  --full                  Include all item types (peek command)
  --content-only          Print only result text (no progress lines)
  --json                  JSON output (threads, peek commands)
  --all                   List all threads without the display limit
  --discover              Merge server-side threads into the local list (threads)
  --                      End of options; remaining args are prompt text
  -v, --version           Print version and exit (before the command only)

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

// Flags that consume the next argument as their value. Used only by the
// pre-scan so `codex-collab --dir /repo run "…"` finds `run` rather than
// stopping at `--dir` and reporting an unknown-option error; the real
// validation happens in commands/shared.ts parseOptions. Keep in sync with
// the value-taking branches there.
const VALUE_FLAGS = new Set([
  "-r", "--reasoning",
  "-m", "--model",
  "-s", "--sandbox",
  "--approval",
  "-d", "--dir",
  "--timeout",
  "--limit",
  "--mode",
  "--ref",
  "--base",
  "--resume",
  "--template",
]);

// Boolean flags recognized by commands/shared.ts parseOptions. Combined with
// VALUE_FLAGS this lets the pre-scan tell "unknown flag" (real error) from
// "known flag but no command followed" (degenerate but not unknown).
const BOOLEAN_FLAGS = new Set([
  "--content-only",
  "--json",
  "--all",
  "--discover",
  "--full",
  "--unset",
  "--memory",
]);

function extractCommand(args: string[]): { command: string; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      showHelp();
      process.exit(0);
    }
    // Only honored before the command: `run "prompt" -v` should surface an
    // unknown-option error rather than silently printing the version and
    // exiting 0 (dangerous in scripts that expect the run to happen).
    if (arg === "-v" || arg === "--version") {
      printVersion();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      // `--name=value` is one token; `--name value` is two — only skip the
      // following arg in the latter case, and only for known value-flags.
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    // First non-flag token is the command. Preserve any options that
    // appeared *before* the command — `args.slice(i + 1)` alone would drop
    // them, so `codex-collab --dir /repo run "…"` would silently run in the
    // wrong workspace. parseOptions is unordered, so the resulting rest may
    // safely interleave pre- and post-command flags.
    const rest = args.slice(0, i).concat(args.slice(i + 1));
    return { command: arg, rest };
  }
  // Reached end of args with no command found — bare flags only. Mirror the
  // pre-existing "Unknown option" error for genuinely unknown flags so
  // `codex-collab --bogus` still exits 1, but tolerate known flags missing
  // their command (the empty-command help path below handles those).
  for (const arg of args) {
    if (arg === "--") break; // end of options — nothing after is a flag
    if (!arg.startsWith("-")) continue;
    // Strip `--name=value` so we match the option name, not the joined token.
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (name === "-h" || name === "--help") continue;
    if (VALUE_FLAGS.has(name) || BOOLEAN_FLAGS.has(name)) continue;
    console.error(`Error: Unknown option: ${arg}`);
    console.error("Run codex-collab --help for usage");
    process.exit(1);
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
    "peek", "version",
  ]);
  if (!knownCommands.has(command)) {
    console.error(`Error: Unknown command: ${command}`);
    console.error("Run codex-collab --help for usage");
    process.exit(1);
  }

  // Handle --help after a command (e.g., "codex-collab run --help") — but
  // not past a `--` terminator, where it is positional prompt text.
  const optionTokens = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
  if (optionTokens.includes("-h") || optionTokens.includes("--help")) {
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
    case "version":
      return printVersion();
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
