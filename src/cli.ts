#!/usr/bin/env bun

// codex-collab CLI — Claude + Codex collaboration bridge

import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import {
  startJob,
  startInteractiveJob,
  loadJob,
  listJobs,
  killJob,
  refreshJobStatus,
  cleanupOldJobs,
  deleteJob,
  sendToJob,
  sendKeysToJob,
  sendControlToJob,
  getJobOutput,
  getJobFullOutput,
  getAttachCommand,
  waitForJob,
  Job,
  getJobsJson,
} from "./jobs.ts";
import {
  loadFiles,
  formatPromptWithFiles,
  estimateTokens,
  loadCodebaseMap,
} from "./files.ts";
import { isTmuxAvailable, listSessions } from "./tmux.ts";

const HELP = `
codex-collab — Claude + Codex collaboration bridge

Usage:
  codex-collab start "prompt" [options]       Start a Codex session with a prompt
  codex-collab start --interactive [options]   Start a session without auto-prompt (TUI mode)
  codex-collab send <id> "message"            Send text + Enter to a session
  codex-collab send-keys <id> <key>           Send raw keystrokes (Down, Up, Enter, 1, Escape, etc.)
  codex-collab send-control <id> <key>        Send control sequences (C-c, C-d)
  codex-collab capture <id> [lines]           Capture recent terminal output (default: 50)
  codex-collab output <id>                    Full session output
  codex-collab wait <id>                      Wait for codex to finish (poll-based)
  codex-collab watch <id>                     Stream output updates
  codex-collab jobs [--json]                  List jobs
  codex-collab status <id>                    Job status
  codex-collab attach <id>                    Print tmux attach command
  codex-collab kill <id>                      Kill a running job
  codex-collab clean                          Remove old completed jobs
  codex-collab health                         Check tmux + codex availability

Options:
  -r, --reasoning <level>    Reasoning effort: low, medium, high, xhigh (default: xhigh)
  -m, --model <model>        Model name (default: ${config.model})
  -s, --sandbox <mode>       Sandbox: read-only, workspace-write, danger-full-access
  -f, --file <glob>          Include files matching glob (can repeat)
  -d, --dir <path>           Working directory (default: cwd)
  --map                      Include codebase map if available
  --dry-run                  Show prompt without executing
  --strip-ansi               Remove ANSI escape codes from output
  --json                     Output JSON (jobs command only)
  --interactive              Start in interactive TUI mode (no auto-prompt)
  --timeout <seconds>        Wait timeout in seconds (default: 900)
  --interval <seconds>       Wait poll interval in seconds (default: 30)
  --limit <n>                Limit jobs shown
  --all                      Show all jobs
  -h, --help                 Show this help

Examples:
  # Start a prompted session
  codex-collab start "Review this code for security issues" -f "src/**/*.ts"

  # Start an interactive session for TUI navigation
  codex-collab start --interactive -d /path/to/project

  # See what Codex is showing
  codex-collab capture abc123

  # Send a chat message
  codex-collab send abc123 "Also check the auth module"

  # Send raw keystrokes (TUI navigation)
  codex-collab send-keys abc123 Down
  codex-collab send-keys abc123 Enter

  # Send Ctrl+C
  codex-collab send-control abc123 C-c
`;

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  files: string[];
  dir: string;
  includeMap: boolean;
  parentSessionId: string | null;
  dryRun: boolean;
  stripAnsi: boolean;
  json: boolean;
  interactive: boolean;
  timeout: number;
  interval: number;
  jobsLimit: number | null;
  jobsAll: boolean;
}

function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  options: Options;
} {
  const options: Options = {
    reasoning: config.defaultReasoningEffort,
    model: config.model,
    sandbox: config.defaultSandbox,
    files: [],
    dir: process.cwd(),
    includeMap: false,
    parentSessionId: null,
    dryRun: false,
    stripAnsi: false,
    json: false,
    interactive: false,
    timeout: 900,
    interval: 30,
    jobsLimit: config.jobsListLimit,
    jobsAll: false,
  };

  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-r" || arg === "--reasoning") {
      const level = args[++i] as ReasoningEffort;
      if (config.reasoningEfforts.includes(level)) {
        options.reasoning = level;
      } else {
        console.error(`Invalid reasoning level: ${level}`);
        console.error(
          `Valid options: ${config.reasoningEfforts.join(", ")}`
        );
        process.exit(1);
      }
    } else if (arg === "-m" || arg === "--model") {
      options.model = args[++i];
    } else if (arg === "-s" || arg === "--sandbox") {
      const mode = args[++i] as SandboxMode;
      if (config.sandboxModes.includes(mode)) {
        options.sandbox = mode;
      } else {
        console.error(`Invalid sandbox mode: ${mode}`);
        console.error(
          `Valid options: ${config.sandboxModes.join(", ")}`
        );
        process.exit(1);
      }
    } else if (arg === "-f" || arg === "--file") {
      options.files.push(args[++i]);
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = args[++i];
    } else if (arg === "--parent-session") {
      options.parentSessionId = args[++i] ?? null;
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--strip-ansi") {
      options.stripAnsi = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--interactive") {
      options.interactive = true;
    } else if (arg === "--timeout") {
      const val = Number(args[++i]);
      if (!Number.isFinite(val) || val <= 0) {
        console.error(`Invalid timeout: ${args[i]}`);
        process.exit(1);
      }
      options.timeout = val;
    } else if (arg === "--interval") {
      const val = Number(args[++i]);
      if (!Number.isFinite(val) || val <= 0) {
        console.error(`Invalid interval: ${args[i]}`);
        process.exit(1);
      }
      options.interval = val;
    } else if (arg === "--limit") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error(`Invalid limit: ${raw}`);
        process.exit(1);
      }
      options.jobsLimit = Math.floor(parsed);
    } else if (arg === "--all") {
      options.jobsAll = true;
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, options };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatJobStatus(job: Job): string {
  const elapsed = job.startedAt
    ? formatDuration(
        (job.completedAt
          ? new Date(job.completedAt).getTime()
          : Date.now()) - new Date(job.startedAt).getTime()
      )
    : "-";

  const status = job.status.toUpperCase().padEnd(10);
  const mode = job.interactive ? "[interactive]" : "";
  const promptPreview =
    job.prompt.slice(0, 50) + (job.prompt.length > 50 ? "..." : "");

  return `${job.id}  ${status}  ${elapsed.padEnd(8)}  ${job.reasoningEffort.padEnd(6)}  ${mode}${promptPreview}`;
}

function refreshJobsForDisplay(jobs: Job[]): Job[] {
  return jobs.map((job) => {
    if (job.status !== "running") return job;
    const refreshed = refreshJobStatus(job.id);
    return refreshed ?? job;
  });
}

function sortJobsRunningFirst(jobs: Job[]): Job[] {
  const statusRank: Record<Job["status"], number> = {
    running: 0,
    pending: 1,
    failed: 2,
    completed: 3,
  };

  return [...jobs].sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    return (
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });
}

function applyJobsLimit<T>(jobs: T[], limit: number | null): T[] {
  if (!limit || limit <= 0) return jobs;
  return jobs.slice(0, limit);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(args);

  try {
    switch (command) {
      case "health": {
        if (!isTmuxAvailable()) {
          console.error("tmux not found");
          console.error("Install with: sudo apt install tmux");
          process.exit(1);
        }
        console.log("tmux: OK");

        const { execSync } = await import("child_process");
        try {
          const version = execSync("codex --version", {
            encoding: "utf-8",
          }).trim();
          console.log(`codex: ${version}`);
        } catch {
          console.error("codex CLI not found");
          console.error("Install with: npm install -g @openai/codex");
          process.exit(1);
        }

        console.log("Status: Ready");
        break;
      }

      case "start": {
        if (!isTmuxAvailable()) {
          console.error("Error: tmux is required but not installed");
          process.exit(1);
        }

        // Interactive mode: no prompt needed
        if (options.interactive) {
          const job = startInteractiveJob({
            model: options.model,
            reasoningEffort: options.reasoning,
            sandbox: options.sandbox,
            parentSessionId: options.parentSessionId ?? undefined,
            cwd: options.dir,
          });

          console.log(`Interactive job started: ${job.id}`);
          console.log(`Model: ${job.model} (${job.reasoningEffort})`);
          console.log(`Working dir: ${job.cwd}`);
          console.log(`tmux session: ${job.tmuxSession}`);
          console.log("");
          console.log("Commands:");
          console.log(
            `  See screen:      codex-collab capture ${job.id}`
          );
          console.log(
            `  Send message:    codex-collab send ${job.id} "message"`
          );
          console.log(
            `  Send keystroke:  codex-collab send-keys ${job.id} Enter`
          );
          console.log(
            `  Attach session:  tmux attach -t ${job.tmuxSession}`
          );
          break;
        }

        // Prompted mode
        if (positional.length === 0) {
          console.error(
            "Error: No prompt provided. Use --interactive for TUI mode."
          );
          process.exit(1);
        }

        let prompt = positional.join(" ");

        if (options.files.length > 0) {
          const files = await loadFiles(options.files, options.dir);
          prompt = formatPromptWithFiles(prompt, files);
          console.error(`Included ${files.length} files`);
        }

        if (options.includeMap) {
          const map = await loadCodebaseMap(options.dir);
          if (map) {
            prompt = `## Codebase Map\n\n${map}\n\n---\n\n${prompt}`;
            console.error("Included codebase map");
          } else {
            console.error("No codebase map found");
          }
        }

        if (options.dryRun) {
          const tokens = estimateTokens(prompt);
          console.log(`Would send ~${tokens.toLocaleString()} tokens`);
          console.log(`Model: ${options.model}`);
          console.log(`Reasoning: ${options.reasoning}`);
          console.log(`Sandbox: ${options.sandbox}`);
          console.log("\n--- Prompt Preview ---\n");
          console.log(prompt.slice(0, 3000));
          if (prompt.length > 3000) {
            console.log(
              `\n... (${prompt.length - 3000} more characters)`
            );
          }
          process.exit(0);
        }

        const job = startJob({
          prompt,
          model: options.model,
          reasoningEffort: options.reasoning,
          sandbox: options.sandbox,
          parentSessionId: options.parentSessionId ?? undefined,
          cwd: options.dir,
        });

        console.log(`Job started: ${job.id}`);
        console.log(`Model: ${job.model} (${job.reasoningEffort})`);
        console.log(`Working dir: ${job.cwd}`);
        console.log(`tmux session: ${job.tmuxSession}`);
        console.log("");
        console.log("Commands:");
        console.log(
          `  Capture output:  codex-collab capture ${job.id}`
        );
        console.log(
          `  Send message:    codex-collab send ${job.id} "message"`
        );
        console.log(
          `  Attach session:  tmux attach -t ${job.tmuxSession}`
        );
        break;
      }

      case "status": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = refreshJobStatus(positional[0]);
        if (!job) {
          console.error(`Job ${positional[0]} not found`);
          process.exit(1);
        }

        console.log(`Job: ${job.id}`);
        console.log(`Status: ${job.status}`);
        console.log(
          `Mode: ${job.interactive ? "interactive" : "prompted"}`
        );
        console.log(`Model: ${job.model} (${job.reasoningEffort})`);
        console.log(`Sandbox: ${job.sandbox}`);
        console.log(`Created: ${job.createdAt}`);
        if (job.startedAt) console.log(`Started: ${job.startedAt}`);
        if (job.completedAt)
          console.log(`Completed: ${job.completedAt}`);
        if (job.tmuxSession)
          console.log(`tmux session: ${job.tmuxSession}`);
        if (job.error) console.log(`Error: ${job.error}`);
        break;
      }

      case "send": {
        if (positional.length < 2) {
          console.error(
            'Error: Usage: codex-collab send <id> "message"'
          );
          process.exit(1);
        }

        const jobId = positional[0];
        const message = positional.slice(1).join(" ");

        if (sendToJob(jobId, message)) {
          console.log(`Sent to ${jobId}: ${message}`);
        } else {
          console.error(`Could not send to job ${jobId}`);
          console.error(
            "Job may not be running or tmux session not found"
          );
          process.exit(1);
        }
        break;
      }

      case "send-keys": {
        if (positional.length < 2) {
          console.error(
            "Error: Usage: codex-collab send-keys <id> <key>"
          );
          process.exit(1);
        }

        const jobId = positional[0];
        const keys = positional.slice(1).join(" ");

        if (sendKeysToJob(jobId, keys)) {
          console.log(`Sent keys to ${jobId}: ${keys}`);
        } else {
          console.error(`Could not send keys to job ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "send-control": {
        if (positional.length < 2) {
          console.error(
            "Error: Usage: codex-collab send-control <id> <key>"
          );
          process.exit(1);
        }

        const jobId = positional[0];
        const key = positional[1];

        if (sendControlToJob(jobId, key)) {
          console.log(`Sent control to ${jobId}: ${key}`);
        } else {
          console.error(`Could not send control to job ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "capture": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const lines = positional[1] ? parseInt(positional[1], 10) : 50;
        let output = getJobOutput(positional[0], lines);

        if (output) {
          if (options.stripAnsi) {
            output = stripAnsiCodes(output);
          }
          console.log(output);
        } else {
          console.error(
            `Could not capture output for job ${positional[0]}`
          );
          process.exit(1);
        }
        break;
      }

      case "wait": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const jobId = positional[0];
        const job = loadJob(jobId);
        if (!job) {
          console.error(`Job ${jobId} not found`);
          process.exit(1);
        }

        console.error(
          `Waiting for job ${jobId} to finish (timeout: ${options.timeout}s, poll interval: ${options.interval}s)...`
        );

        const result = waitForJob(jobId, {
          timeoutSec: options.timeout,
          intervalSec: options.interval,
        });

        if (result.done) {
          console.error("Done.");
          if (result.output) {
            let output = result.output;
            if (options.stripAnsi) {
              output = stripAnsiCodes(output);
            }
            console.log(output);
          }
        } else {
          console.error("Timed out waiting for completion.");
          if (result.output) {
            let output = result.output;
            if (options.stripAnsi) {
              output = stripAnsiCodes(output);
            }
            console.log(output);
          }
          process.exit(1);
        }
        break;
      }

      case "output": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        let output = getJobFullOutput(positional[0]);
        if (output) {
          if (options.stripAnsi) {
            output = stripAnsiCodes(output);
          }
          console.log(output);
        } else {
          console.error(
            `Could not get output for job ${positional[0]}`
          );
          process.exit(1);
        }
        break;
      }

      case "attach": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const attachCmd = getAttachCommand(positional[0]);
        if (attachCmd) {
          console.log(attachCmd);
        } else {
          console.error(
            `Job ${positional[0]} not found or no tmux session`
          );
          process.exit(1);
        }
        break;
      }

      case "watch": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        const job = loadJob(positional[0]);
        if (!job || !job.tmuxSession) {
          console.error(
            `Job ${positional[0]} not found or no tmux session`
          );
          process.exit(1);
        }

        console.error(
          `Watching ${job.tmuxSession}... (Ctrl+C to stop)`
        );
        console.error(
          "For interactive mode, use: tmux attach -t " +
            job.tmuxSession
        );
        console.error("");

        let lastOutput = "";
        const pollInterval = setInterval(() => {
          const output = getJobOutput(positional[0], 100);
          if (output && output !== lastOutput) {
            if (lastOutput) {
              const newPart = output.replace(lastOutput, "");
              if (newPart.trim()) {
                process.stdout.write(newPart);
              }
            } else {
              console.log(output);
            }
            lastOutput = output;
          }

          const refreshed = refreshJobStatus(positional[0]);
          if (refreshed && refreshed.status !== "running") {
            console.error(`\nJob ${refreshed.status}`);
            clearInterval(pollInterval);
            process.exit(0);
          }
        }, 1000);

        process.on("SIGINT", () => {
          clearInterval(pollInterval);
          console.error("\nStopped watching");
          process.exit(0);
        });
        break;
      }

      case "jobs": {
        if (options.json) {
          const payload = getJobsJson();
          const limit = options.jobsAll ? null : options.jobsLimit;
          const statusRank: Record<Job["status"], number> = {
            running: 0,
            pending: 1,
            failed: 2,
            completed: 3,
          };
          payload.jobs.sort((a, b) => {
            const rankDiff =
              statusRank[a.status] - statusRank[b.status];
            if (rankDiff !== 0) return rankDiff;
            return (
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime()
            );
          });
          payload.jobs = applyJobsLimit(payload.jobs, limit);
          console.log(JSON.stringify(payload, null, 2));
          break;
        }

        const limit = options.jobsAll ? null : options.jobsLimit;
        const allJobs = refreshJobsForDisplay(listJobs());
        const jobs = applyJobsLimit(
          sortJobsRunningFirst(allJobs),
          limit
        );
        if (jobs.length === 0) {
          console.log("No jobs");
        } else {
          console.log(
            "ID        STATUS      ELAPSED   EFFORT  PROMPT"
          );
          console.log("-".repeat(80));
          for (const job of jobs) {
            console.log(formatJobStatus(job));
          }
        }
        break;
      }

      case "sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          console.log("No active codex-collab sessions");
        } else {
          console.log(
            "SESSION NAME                    ATTACHED  CREATED"
          );
          console.log("-".repeat(60));
          for (const session of sessions) {
            const attached = session.attached ? "yes" : "no";
            console.log(
              `${session.name.padEnd(30)}  ${attached.padEnd(8)}  ${session.created}`
            );
          }
        }
        break;
      }

      case "kill": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (killJob(positional[0])) {
          console.log(`Killed job: ${positional[0]}`);
        } else {
          console.error(`Could not kill job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      case "clean": {
        const cleaned = cleanupOldJobs(7);
        console.log(`Cleaned ${cleaned} old jobs`);
        break;
      }

      case "delete": {
        if (positional.length === 0) {
          console.error("Error: No job ID provided");
          process.exit(1);
        }

        if (deleteJob(positional[0])) {
          console.log(`Deleted job: ${positional[0]}`);
        } else {
          console.error(`Could not delete job: ${positional[0]}`);
          process.exit(1);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run codex-collab --help for usage");
        process.exit(1);
    }
  } catch (err) {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  }
}

main();
