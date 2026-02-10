#!/usr/bin/env bun

// codex-collab CLI — Claude + Codex collaboration bridge

import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import {
  startInteractiveJob,
  loadJob,
  listJobs,
  killJob,
  refreshJobStatus,
  cleanupOldJobs,
  deleteJob,
  sendToJob,
  sendKeysToJob,
  getJobOutput,
  getJobFullOutput,
  getAttachCommand,
  waitForJob,
  resetJob,
  runReview,
  runPrompt,
  Job,
  getJobsJson,
  type ReviewMode,
} from "./jobs.ts";
import { isTmuxAvailable } from "./tmux.ts";
import { resolve, basename } from "path";

const HELP = `
codex-collab — Manage interactive Codex TUI sessions in tmux

Usage:
  codex-collab run "prompt" [options]          Run a prompt and wait for output
  codex-collab run --resume <id> "prompt"      Resume existing session
  codex-collab review [options]               Code review (PR-style by default)
  codex-collab review "instructions" [options] Custom review with specific focus
  codex-collab start [options]                Start an interactive Codex session (TUI mode)
  codex-collab send <id> "message"            Send text + Enter to a session
  codex-collab send-keys <id> <key>           Send raw keystrokes (Down, Up, Enter, 1, Escape, etc.)
  codex-collab capture <id> [lines]           Capture recent screen output (default: 50 lines)
  codex-collab output <id>                    Full session output
  codex-collab wait <id>                      Wait for codex to finish (poll-based)
  codex-collab reset <id>                     Send /new to clear session context
  codex-collab jobs [--json]                  List jobs
  codex-collab status <id>                    Job status
  codex-collab attach <id>                    Print tmux attach command
  codex-collab delete <id>                    Delete a job and its files
  codex-collab kill <id>                      Kill a running job
  codex-collab clean                          Remove old completed jobs
  codex-collab health                         Check tmux + codex availability

Options:
  -r, --reasoning <level>    Reasoning effort: low, medium, high, xhigh (default: xhigh)
  -m, --model <model>        Model name (default: ${config.model})
  -s, --sandbox <mode>       Sandbox: read-only, workspace-write, danger-full-access
                             (default: workspace-write; review always uses read-only)
  -d, --dir <path>           Working directory (default: cwd)
  --strip-ansi               Remove ANSI escape codes from output
  --content-only             Strip TUI chrome (banner, tips, shortcuts) from output
                             (implies --strip-ansi)
  --json                     Output JSON (jobs command only)
  --timeout <seconds>        Wait timeout in seconds (default: 900)
  --interval <seconds>       Wait poll interval in seconds (default: 30)
  --mode <mode>              Review mode: pr, uncommitted, commit, custom (default: pr)
  --ref <hash>               Commit ref for --mode commit
  --resume <id>              Resume an existing session (run and review)
  --limit <n>                Limit jobs shown
  --all                      Show all jobs
  -h, --help                 Show this help

Examples:
  # Run a prompt (starts session, waits, prints output)
  codex-collab run "what does this project do?" -s read-only --content-only

  # Resume an existing session
  codex-collab run --resume abc123 "now summarize the key files" --content-only

  # Code review (PR-style against main)
  codex-collab review -d /path/to/project --content-only

  # Review uncommitted changes
  codex-collab review --mode uncommitted -d /path/to/project --content-only

  # Review a specific commit
  codex-collab review --mode commit --ref abc1234 -d /path/to/project --content-only

  # Custom review focus
  codex-collab review "Focus on security issues" -d /path/to/project --content-only

  # Resume an existing session
  codex-collab review --resume abc123 "Check error handling" --content-only

  # Reset a session (clear context with /new)
  codex-collab reset abc123

  # Start an interactive session
  codex-collab start -d /path/to/project

  # See what Codex is showing (clean output)
  codex-collab capture abc123 --content-only

  # Wait for completion, then read results separately
  codex-collab wait abc123
  codex-collab output abc123 --content-only
`;

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  dir: string;
  stripAnsi: boolean;
  contentOnly: boolean;
  json: boolean;
  timeout: number;
  interval: number;
  jobsLimit: number | null;
  jobsAll: boolean;
  reviewMode: ReviewMode | null;
  reviewRef: string | null;
  resumeJobId: string | null;
}

function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/**
 * Word-wrap a single line to `width`, preserving leading indentation.
 * Continuation lines are indented to the same level as the original.
 */
function wrapLine(line: string, width: number): string {
  if (line.length <= width) return line;

  const indent = line.match(/^(\s*)/)![1];
  const content = line.slice(indent.length);

  // Don't wrap lines that look like structural/code content
  // (box-drawing, tree connectors, separators)
  if (/^[│└┌┐┘─╭╰…]/.test(content)) return line;

  const words = content.split(/(\s+)/);
  const lines: string[] = [];
  let current = indent;

  for (const word of words) {
    if (current.length + word.length > width && current.trim() !== '') {
      lines.push(current.trimEnd());
      current = indent + word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim() !== '') lines.push(current.trimEnd());

  return lines.join('\n');
}

function extractContent(text: string, width?: number): string {
  const cols = width ?? process.stdout.columns ?? 80;
  const lines = text.split('\n');
  const result: string[] = [];
  let inBanner = false;
  let inTip = false;

  for (const line of lines) {
    // Skip banner block (╭ through ╰ inclusive)
    if (line.trimStart().startsWith('╭')) {
      inBanner = true;
      continue;
    }
    if (inBanner) {
      if (line.trimStart().startsWith('╰')) {
        inBanner = false;
      }
      continue;
    }

    // Skip tip lines (including wrapped continuations)
    if (/^\s*Tip:/.test(line)) {
      inTip = true;
      continue;
    }
    if (inTip) {
      // Continuation: indented, not a content marker (›, •, ─)
      if (line.trim() === '' || (/^\s/.test(line) && !/^\s*[›•─]/.test(line))) {
        continue;
      }
      inTip = false;
    }

    // Skip shortcuts/context line
    if (line.includes('? for shortcuts') || /\d+%\s*context left/.test(line)) continue;

    result.push(wrapLine(line, cols));
  }

  // Remove trailing idle prompt placeholder and blank lines
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last.trim() === '' || /^\s*›/.test(last)) {
      result.pop();
    } else {
      break;
    }
  }

  // Remove leading empty lines
  while (result.length > 0 && result[0].trim() === '') {
    result.shift();
  }

  return result.join('\n');
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
    dir: process.cwd(),
    stripAnsi: false,
    contentOnly: false,
    json: false,
    timeout: 900,
    interval: 30,
    jobsLimit: config.jobsListLimit,
    jobsAll: false,
    reviewMode: null,
    reviewRef: null,
    resumeJobId: null,
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
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = resolve(args[++i]);
    } else if (arg === "--strip-ansi") {
      options.stripAnsi = true;
    } else if (arg === "--content-only") {
      options.contentOnly = true;
    } else if (arg === "--json") {
      options.json = true;
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
    } else if (arg === "--mode") {
      if (i + 1 >= args.length) { console.error("--mode requires a value"); process.exit(1); }
      const mode = args[++i] as ReviewMode;
      const validModes: ReviewMode[] = ["pr", "uncommitted", "commit", "custom"];
      if (validModes.includes(mode)) {
        options.reviewMode = mode;
      } else {
        console.error(`Invalid review mode: ${mode}`);
        console.error(`Valid options: ${validModes.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "--ref") {
      if (i + 1 >= args.length) { console.error("--ref requires a value"); process.exit(1); }
      options.reviewRef = args[++i];
    } else if (arg === "--resume") {
      if (i + 1 >= args.length) { console.error("--resume requires a value"); process.exit(1); }
      options.resumeJobId = args[++i];
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
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

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    console.error("Error: tmux is required but not installed");
    process.exit(1);
  }
}

function requireJobId(positional: string[]): string {
  if (positional.length === 0) {
    console.error("Error: No job ID provided");
    process.exit(1);
  }
  return positional[0];
}

function processOutput(output: string, options: Options): string {
  if (options.contentOnly) {
    return extractContent(stripAnsiCodes(output));
  }
  if (options.stripAnsi) {
    return stripAnsiCodes(output);
  }
  return output;
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
  const dir = basename(job.cwd).slice(0, 20).padEnd(20);
  const promptPreview =
    job.prompt.slice(0, 50) + (job.prompt.length > 50 ? "..." : "");

  return `${job.id}  ${status}  ${elapsed.padEnd(8)}  ${job.reasoningEffort.padEnd(6)}  ${dir}  ${promptPreview}`;
}

function refreshJobsForDisplay(jobs: Job[]): Job[] {
  return jobs.map((job) => {
    if (job.status !== "running") return job;
    const refreshed = refreshJobStatus(job.id);
    return refreshed ?? job;
  });
}

const STATUS_RANK: Record<Job["status"], number> = {
  running: 0,
  pending: 1,
  failed: 2,
  completed: 3,
};

function sortByStatusThenDate<T extends { status: Job["status"] }>(
  items: T[],
  getDate: (item: T) => string
): T[] {
  return [...items].sort((a, b) => {
    const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rankDiff !== 0) return rankDiff;
    return new Date(getDate(b)).getTime() - new Date(getDate(a)).getTime();
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
        if (positional.length > 0) {
          console.error("Error: start does not accept a prompt argument");
          console.error("Use 'codex-collab run \"prompt\"' for prompted tasks");
          process.exit(1);
        }

        requireTmux();

        const job = startInteractiveJob({
          model: options.model,
          reasoningEffort: options.reasoning,
          sandbox: options.sandbox,
          cwd: options.dir,
        });

        console.log(`Session started: ${job.id}`);
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

      case "status": {
        const jobId = requireJobId(positional);
        const job = refreshJobStatus(jobId);
        if (!job) {
          console.error(`Job ${jobId} not found`);
          process.exit(1);
        }

        console.log(`Job: ${job.id}`);
        console.log(`Status: ${job.status}`);
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

      case "capture": {
        const jobId = requireJobId(positional);
        const lines = positional[1] ? parseInt(positional[1], 10) : 50;
        const output = getJobOutput(jobId, lines);

        if (output) {
          console.log(processOutput(output, options));
        } else {
          console.error(`Could not capture output for job ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "wait": {
        const jobId = requireJobId(positional);
        const job = loadJob(jobId);
        if (!job) {
          console.error(`Job ${jobId} not found`);
          process.exit(1);
        }

        console.error(
          `Waiting for job ${jobId} to finish (timeout: ${options.timeout}s, poll interval: ${options.interval}s)...`
        );

        const waitStart = Date.now();
        const result = waitForJob(jobId, {
          timeoutSec: options.timeout,
          intervalSec: options.interval,
        });
        const elapsed = Date.now() - waitStart;

        if (result.done) {
          console.error(`Done in ${formatDuration(elapsed)}`);
        } else {
          console.error(`Timed out after ${formatDuration(elapsed)}`);
          process.exit(1);
        }
        break;
      }

      case "output": {
        const jobId = requireJobId(positional);
        const output = getJobFullOutput(jobId);
        if (output) {
          console.log(processOutput(output, options));
        } else {
          console.error(`Could not get output for job ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "attach": {
        const jobId = requireJobId(positional);
        const attachCmd = getAttachCommand(jobId);
        if (attachCmd) {
          console.log(attachCmd);
        } else {
          console.error(`Job ${jobId} not found or no tmux session`);
          process.exit(1);
        }
        break;
      }

      case "jobs": {
        if (options.json) {
          const payload = getJobsJson();
          const limit = options.jobsAll ? null : options.jobsLimit;
          payload.jobs = applyJobsLimit(
            sortByStatusThenDate(payload.jobs, (j) => j.created_at),
            limit
          );
          console.log(JSON.stringify(payload, null, 2));
          break;
        }

        const limit = options.jobsAll ? null : options.jobsLimit;
        const allJobs = refreshJobsForDisplay(listJobs());
        const jobs = applyJobsLimit(
          sortByStatusThenDate(allJobs, (j) => j.createdAt),
          limit
        );
        if (jobs.length === 0) {
          console.log("No jobs");
        } else {
          console.log(
            "ID        STATUS      ELAPSED   EFFORT  DIR                   PROMPT"
          );
          console.log("-".repeat(100));
          for (const job of jobs) {
            console.log(formatJobStatus(job));
          }
        }
        break;
      }

      case "kill": {
        const jobId = requireJobId(positional);
        if (killJob(jobId)) {
          console.log(`Killed job: ${jobId}`);
        } else {
          console.error(`Could not kill job: ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "clean": {
        const cleaned = cleanupOldJobs(7);
        if (cleaned.sessions > 0) console.log(`Killed ${cleaned.sessions} stale sessions`);
        if (cleaned.deleted > 0) console.log(`Deleted ${cleaned.deleted} old jobs`);
        if (cleaned.sessions === 0 && cleaned.deleted === 0) console.log("Nothing to clean");
        break;
      }

      case "delete": {
        const jobId = requireJobId(positional);
        if (deleteJob(jobId)) {
          console.log(`Deleted job: ${jobId}`);
        } else {
          console.error(`Could not delete job: ${jobId}`);
          process.exit(1);
        }
        break;
      }

      case "review": {
        requireTmux();

        // Resolve review mode: null means not explicitly set (default to pr)
        let mode: ReviewMode = options.reviewMode ?? "pr";
        let instructions: string | undefined;

        if (positional.length > 0) {
          if (mode === "custom" || options.reviewMode === null) {
            // Infer custom mode from positional args (or explicit --mode custom)
            mode = "custom";
            instructions = positional.join(" ");
          } else {
            // Explicit non-custom mode + positional args = error
            console.error(`Error: --mode ${mode} does not accept positional arguments`);
            console.error('Use --mode custom "instructions" for custom reviews');
            process.exit(1);
          }
        } else if (mode === "custom") {
          console.error("Error: Custom review mode requires instructions");
          console.error('Usage: codex-collab review "instructions"');
          process.exit(1);
        }

        console.error(`Starting ${mode} review in ${options.dir}...`);

        const reviewResult = runReview({
          mode,
          instructions,
          ref: options.reviewRef ?? undefined,
          cwd: options.dir,
          model: options.model,
          reasoningEffort: options.reasoning,
          timeoutSec: options.timeout,
          intervalSec: options.interval,
          resumeJobId: options.resumeJobId ?? undefined,
        });

        if (reviewResult.error) {
          console.error(`Error: ${reviewResult.error}`);
          process.exit(1);
        }

        console.error(`Job: ${reviewResult.jobId}`);

        if (reviewResult.done) {
          console.error("Review complete.");
          if (reviewResult.output) {
            console.log(processOutput(reviewResult.output, options));
          }
        } else {
          console.error("Review timed out. Check output with:");
          console.error(`  codex-collab output ${reviewResult.jobId} --content-only`);
          process.exit(1);
        }
        break;
      }

      case "reset": {
        const jobId = requireJobId(positional);
        if (resetJob(jobId)) {
          console.log(`Reset job: ${jobId} (sent /new)`);
        } else {
          console.error(`Could not reset job: ${jobId}`);
          console.error("Job may not be running or tmux session not found");
          process.exit(1);
        }
        break;
      }

      case "run": {
        requireTmux();

        if (positional.length === 0) {
          console.error("Error: No prompt provided");
          console.error("Usage: codex-collab run \"prompt\" [options]");
          process.exit(1);
        }

        const prompt = positional.join(" ");

        console.error(`Running prompt in ${options.dir}...`);

        const runResult = runPrompt({
          prompt,
          cwd: options.dir,
          model: options.model,
          reasoningEffort: options.reasoning,
          sandbox: options.sandbox,
          timeoutSec: options.timeout,
          intervalSec: options.interval,
          resumeJobId: options.resumeJobId ?? undefined,
        });

        if (runResult.error) {
          console.error(`Error: ${runResult.error}`);
          process.exit(1);
        }

        console.error(`Job: ${runResult.jobId}`);

        if (runResult.done) {
          console.error("Done.");
          if (runResult.output) {
            console.log(processOutput(runResult.output, options));
          }
        } else {
          console.error("Timed out. Check output with:");
          console.error(`  codex-collab output ${runResult.jobId} --content-only`);
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
