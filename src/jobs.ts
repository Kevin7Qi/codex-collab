// Job management for codex-collab

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { join } from "path";
import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import {
  extractSessionId,
  findSessionFile,
  parseSessionFile,
  type ParsedSessionData,
} from "./session-parser.ts";
import {
  createSession,
  killSession,
  killSessionUnchecked,
  sessionExists,
  getSessionName,
  capturePaneUnchecked,
  captureFullHistoryUnchecked,
  isSessionActive,
  sendMessageUnchecked,
  sendKeysUnchecked,
  sendControlUnchecked,
} from "./tmux.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  interactive: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
  parentSessionId?: string;
  cwd: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tmuxSession?: string;
  result?: string;
  error?: string;
}

function ensureJobsDir(): void {
  mkdirSync(config.jobsDir, { recursive: true });
}

function generateJobId(): string {
  return randomBytes(4).toString("hex");
}

function getJobPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.json`);
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(getJobPath(job.id), JSON.stringify(job, null, 2));
}

export function loadJob(jobId: string): Job | null {
  try {
    const content = readFileSync(getJobPath(jobId), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function listJobs(): Job[] {
  ensureJobsDir();
  const files = readdirSync(config.jobsDir).filter((f) =>
    f.endsWith(".json")
  );
  return files
    .map((f) => {
      try {
        const content = readFileSync(join(config.jobsDir, f), "utf-8");
        return JSON.parse(content) as Job;
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function computeElapsedMs(job: Job): number {
  const start = job.startedAt ?? job.createdAt;
  const startMs = Date.parse(start);
  const endMs = job.completedAt ? Date.parse(job.completedAt) : Date.now();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function getLogMtimeMs(jobId: string): number | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return statSync(logFile).mtimeMs;
  } catch {
    return null;
  }
}

function getLastActivityMs(job: Job): number | null {
  const logMtime = getLogMtimeMs(job.id);
  if (logMtime !== null) return logMtime;

  const fallback = job.startedAt ?? job.createdAt;
  const fallbackMs = Date.parse(fallback);
  if (!Number.isFinite(fallbackMs)) return null;
  return fallbackMs;
}

function isInactiveTimedOut(job: Job): boolean {
  const timeoutMinutes = config.defaultTimeout;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;

  const lastActivityMs = getLastActivityMs(job);
  if (!lastActivityMs) return false;

  return Date.now() - lastActivityMs > timeoutMinutes * 60 * 1000;
}

function loadSessionData(jobId: string): ParsedSessionData | null {
  const logFile = join(config.jobsDir, `${jobId}.log`);
  let logContent: string;

  try {
    logContent = readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }

  const sessionId = extractSessionId(logContent);
  if (!sessionId) return null;

  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) return null;

  return parseSessionFile(sessionFile);
}

export type JobsJsonEntry = {
  id: string;
  status: Job["status"];
  prompt: string;
  interactive: boolean;
  model: string;
  reasoning: ReasoningEffort;
  cwd: string;
  elapsed_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  tokens: ParsedSessionData["tokens"] | null;
  files_modified: ParsedSessionData["files_modified"] | null;
  summary: string | null;
};

export type JobsJsonOutput = {
  generated_at: string;
  jobs: JobsJsonEntry[];
};

export function getJobsJson(): JobsJsonOutput {
  const jobs = listJobs();
  const enriched = jobs.map((job) => {
    const refreshed =
      job.status === "running" ? refreshJobStatus(job.id) : null;
    const effective = refreshed ?? job;
    const elapsedMs = computeElapsedMs(effective);

    let tokens: ParsedSessionData["tokens"] | null = null;
    let filesModified: ParsedSessionData["files_modified"] | null = null;
    let summary: string | null = null;

    if (effective.status === "completed") {
      const sessionData = loadSessionData(effective.id);
      if (sessionData) {
        tokens = sessionData.tokens;
        filesModified = sessionData.files_modified;
        summary = sessionData.summary
          ? truncateText(sessionData.summary, 500)
          : null;
      }
    }

    return {
      id: effective.id,
      status: effective.status,
      prompt: truncateText(effective.prompt, 100),
      interactive: effective.interactive,
      model: effective.model,
      reasoning: effective.reasoningEffort,
      cwd: effective.cwd,
      elapsed_ms: elapsedMs,
      created_at: effective.createdAt,
      started_at: effective.startedAt ?? null,
      completed_at: effective.completedAt ?? null,
      tokens,
      files_modified: filesModified,
      summary,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    jobs: enriched,
  };
}

export function deleteJob(jobId: string): boolean {
  const job = loadJob(jobId);

  if (job?.tmuxSession) {
    killSessionUnchecked(job.tmuxSession);
  }

  try {
    unlinkSync(getJobPath(jobId));
    try {
      unlinkSync(join(config.jobsDir, `${jobId}.prompt`));
    } catch {
      // Prompt file may not exist
    }
    return true;
  } catch {
    return false;
  }
}

export interface StartJobOptions {
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
}

export function startJob(options: StartJobOptions): Job {
  ensureJobsDir();

  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: options.prompt,
    interactive: false,
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    cwd,
    createdAt: new Date().toISOString(),
  };

  saveJob(job);

  const result = createSession({
    jobId,
    prompt: options.prompt,
    interactive: false,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.tmuxSession = result.sessionName;
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to create tmux session";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export interface StartInteractiveJobOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  parentSessionId?: string;
  cwd?: string;
}

export function startInteractiveJob(options: StartInteractiveJobOptions): Job {
  ensureJobsDir();

  const jobId = generateJobId();
  const cwd = options.cwd || process.cwd();

  const job: Job = {
    id: jobId,
    status: "pending",
    prompt: "(interactive)",
    interactive: true,
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    parentSessionId: options.parentSessionId,
    cwd,
    createdAt: new Date().toISOString(),
  };

  saveJob(job);

  const result = createSession({
    jobId,
    interactive: true,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    sandbox: job.sandbox,
    cwd,
  });

  if (result.success) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.tmuxSession = result.sessionName;
  } else {
    job.status = "failed";
    job.error = result.error || "Failed to create tmux session";
    job.completedAt = new Date().toISOString();
  }

  saveJob(job);
  return job;
}

export function killJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job) return false;

  if (job.tmuxSession) {
    killSession(job.tmuxSession);
  }

  job.status = "failed";
  job.error = "Killed by user";
  job.completedAt = new Date().toISOString();
  saveJob(job);
  return true;
}

export function sendToJob(jobId: string, message: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendMessageUnchecked(job.tmuxSession, message);
}

export function sendKeysToJob(jobId: string, keys: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendKeysUnchecked(job.tmuxSession, keys);
}

export function sendControlToJob(jobId: string, key: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return sendControlUnchecked(job.tmuxSession, key);
}

export function getJobOutput(jobId: string, lines?: number): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.tmuxSession) {
    const output = capturePaneUnchecked(job.tmuxSession, { lines });
    if (output) return output;
  }

  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    const content = readFileSync(logFile, "utf-8");
    if (lines) {
      const allLines = content.split("\n");
      return allLines.slice(-lines).join("\n");
    }
    return content;
  } catch {
    return null;
  }
}

export function getJobFullOutput(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.tmuxSession) {
    const output = captureFullHistoryUnchecked(job.tmuxSession);
    if (output) return output;
  }

  const logFile = join(config.jobsDir, `${jobId}.log`);
  try {
    return readFileSync(logFile, "utf-8");
  } catch {
    return null;
  }
}

export function cleanupOldJobs(maxAgeDays: number = 7): number {
  const jobs = listJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const job of jobs) {
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (
      jobTime < cutoff &&
      (job.status === "completed" || job.status === "failed")
    ) {
      if (deleteJob(job.id)) cleaned++;
    }
  }

  return cleaned;
}

export function isJobRunning(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;

  return isSessionActive(job.tmuxSession);
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.status === "running" && job.tmuxSession) {
    if (!sessionExists(job.tmuxSession)) {
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      const logFile = join(config.jobsDir, `${jobId}.log`);
      try {
        job.result = readFileSync(logFile, "utf-8");
      } catch {
        // No log file
      }
      saveJob(job);
    } else {
      const output = capturePaneUnchecked(job.tmuxSession, { lines: 20 });
      if (output && output.includes("[codex-collab: Session complete")) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        const fullOutput = captureFullHistoryUnchecked(job.tmuxSession);
        if (fullOutput) {
          job.result = fullOutput;
        }
        saveJob(job);
      } else if (isInactiveTimedOut(job)) {
        killSessionUnchecked(job.tmuxSession);
        job.status = "failed";
        job.error = `Timed out after ${config.defaultTimeout} minutes of inactivity`;
        job.completedAt = new Date().toISOString();
        saveJob(job);
      }
    }
  }

  return job;
}

export function resetJob(jobId: string): boolean {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return false;
  if (job.status !== "running") return false;

  if (!sendMessageUnchecked(job.tmuxSession, "/new")) return false;

  job.prompt = "(reset)";
  job.startedAt = new Date().toISOString();
  job.completedAt = undefined;
  job.result = undefined;
  job.error = undefined;
  saveJob(job);
  return true;
}

export function findReusableJob(cwd: string): Job | null {
  const jobs = listJobs();
  for (const job of jobs) {
    if (
      job.status === "running" &&
      job.interactive &&
      job.cwd === cwd &&
      job.tmuxSession &&
      sessionExists(job.tmuxSession)
    ) {
      return job;
    }
  }
  return null;
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return null;

  return `tmux attach -t "${job.tmuxSession}"`;
}

/**
 * Poll a job's capture output until codex finishes working.
 * Returns the final capture output, or null if timed out / job not found.
 */
export function waitForJob(
  jobId: string,
  options: { timeoutSec?: number; intervalSec?: number } = {}
): { done: boolean; output: string | null } {

  const timeoutSec = options.timeoutSec ?? 900;
  const intervalSec = options.intervalSec ?? 30;
  const deadline = Date.now() + timeoutSec * 1000;

  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) {
    return { done: false, output: null };
  }

  // Grace period: wait for the spinner to appear before checking for completion.
  // Without this, calling `wait` right after `send` can return immediately
  // because codex hasn't rendered the spinner yet.
  // After the grace period, if no spinner was ever seen and codex is idle, report done.
  let sawSpinner = false;
  const waitStarted = Date.now();
  const gracePeriodMs = 15_000;

  while (Date.now() < deadline) {
    let output = capturePaneUnchecked(job.tmuxSession, { lines: 50 });

    // Null capture means the session is gone — task is done
    if (output === null) {
      return { done: true, output: null };
    }

    const lower = output.toLowerCase();
    // Codex spinner shows "* <task description> (<time> * esc to interrupt)"
    // The task description varies, so detect the spinner by its consistent suffix
    const isWorking = lower.includes("esc to interrupt");

    if (isWorking) {
      sawSpinner = true;
    } else if (sawSpinner) {
      // Spinner disappeared — confirm it's truly gone with rapid checks.
      // Codex briefly drops the spinner between tool calls, so a single
      // observation isn't reliable.
      const confirmMs = 10_000;
      const confirmInterval = 2_000;
      const confirmDeadline = Math.min(Date.now() + confirmMs, deadline);
      let confirmed = true;
      while (Date.now() < confirmDeadline) {
        Bun.sleepSync(confirmInterval);
        const check = capturePaneUnchecked(job.tmuxSession, { lines: 50 });
        if (check === null) return { done: true, output: null };
        if (check.toLowerCase().includes("esc to interrupt")) {
          // Spinner came back — still working
          confirmed = false;
          break;
        }
        output = check; // keep freshest capture
      }
      if (confirmed) return { done: true, output };
    } else if (!sawSpinner && Date.now() - waitStarted > gracePeriodMs) {
      // Grace period expired and spinner was never seen.
      // Codex is at idle prompt — task completed before we started polling.
      return { done: true, output };
    }

    Bun.sleepSync(intervalSec * 1000);
  }

  // Timed out — return last capture
  const finalOutput = capturePaneUnchecked(job.tmuxSession, { lines: 50 });
  return { done: false, output: finalOutput };
}

/**
 * Poll capturePane until the output matches a pattern (or times out).
 * Returns the matched output or null on timeout.
 */
export function waitForContent(
  sessionName: string,
  pattern: RegExp | string,
  timeoutSec: number = 30,
  pollMs: number = 1000
): string | null {

  const deadline = Date.now() + timeoutSec * 1000;
  const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;

  while (Date.now() < deadline) {
    const output = capturePaneUnchecked(sessionName, { lines: 50 });
    if (output === null) return null; // session died
    if (re.test(output)) return output;
    Bun.sleepSync(pollMs);
  }
  return null;
}

export type ReviewMode = "pr" | "uncommitted" | "commit" | "custom";

export interface RunReviewOptions {
  mode: ReviewMode;
  instructions?: string;
  ref?: string;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  timeoutSec?: number;
  intervalSec?: number;
  reuseJobId?: string;
}

export interface ReviewResult {
  jobId: string;
  done: boolean;
  output: string | null;
  error?: string;
}

/**
 * Run a code review in a single call: start session, navigate /review menu, wait for completion.
 */
export function runReview(options: RunReviewOptions): ReviewResult {

  const timeoutSec = options.timeoutSec ?? 900;
  const intervalSec = options.intervalSec ?? 30;

  let job: Job;
  let sessionName: string;
  let isReused = false;

  // Either reuse an existing session or start a new one
  if (options.reuseJobId) {
    const existing = loadJob(options.reuseJobId);
    if (!existing || !existing.tmuxSession) {
      return { jobId: options.reuseJobId, done: false, output: null, error: "Job not found or no session" };
    }
    if (existing.status !== "running" || !sessionExists(existing.tmuxSession)) {
      return { jobId: options.reuseJobId, done: false, output: null, error: "Session is no longer running" };
    }
    // Reset the session with /new before reusing
    sendMessageUnchecked(existing.tmuxSession, "/new");
    Bun.sleepSync(2000);
    existing.prompt = "(review)";
    existing.startedAt = new Date().toISOString();
    existing.completedAt = undefined;
    saveJob(existing);
    job = existing;
    sessionName = existing.tmuxSession;
    isReused = true;
  } else {
    job = startInteractiveJob({
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sandbox: "read-only",
      cwd: options.cwd,
    });
    if (job.status === "failed" || !job.tmuxSession) {
      return { jobId: job.id, done: false, output: null, error: job.error || "Failed to start session" };
    }
    sessionName = job.tmuxSession;
  }

  // Custom mode: send /review with instructions directly (bypasses menu)
  if (options.mode === "custom" && options.instructions) {
    sendMessageUnchecked(sessionName, `/review ${options.instructions}`);
    const result = waitForJob(job.id, { timeoutSec, intervalSec });
    const fullOutput = result.done ? (getJobFullOutput(job.id) ?? result.output) : result.output;
    return { jobId: job.id, done: result.done, output: fullOutput };
  }

  // Menu modes: send /review and navigate the TUI menu
  sendMessageUnchecked(sessionName, "/review");

  // Wait for the review preset menu to appear
  const menuScreen = waitForContent(sessionName, /select a review preset/i, 30);
  if (!menuScreen) {
    const err = "Review menu did not appear (timed out)";
    if (!isReused) killSessionUnchecked(sessionName);
    job.status = "failed";
    job.error = err;
    job.completedAt = new Date().toISOString();
    saveJob(job);
    return { jobId: job.id, done: false, output: null, error: err };
  }

  // Navigate based on mode
  switch (options.mode) {
    case "pr": {
      // Option 1 is default, just press Enter
      sendKeysUnchecked(sessionName, "Enter");
      // Wait for branch picker to appear (menu text disappears, picker shows branch list)
      // Use a small delay then just accept default — the picker highlights main by default
      Bun.sleepSync(3000);
      sendKeysUnchecked(sessionName, "Enter");
      break;
    }
    case "uncommitted": {
      // Navigate to option 2: Down, Enter
      sendKeysUnchecked(sessionName, "Down");
      Bun.sleepSync(300);
      sendKeysUnchecked(sessionName, "Enter");
      break;
    }
    case "commit": {
      // Navigate to option 3: Down, Down, Enter
      sendKeysUnchecked(sessionName, "Down");
      Bun.sleepSync(300);
      sendKeysUnchecked(sessionName, "Down");
      Bun.sleepSync(300);
      sendKeysUnchecked(sessionName, "Enter");
      // Wait for commit picker — match "Type to search" which only appears in the picker,
      // not in the preset menu ("Review a commit")
      const commitScreen = waitForContent(sessionName, /Type to search/i, 15);
      if (!commitScreen) {
        const err = "Commit picker did not appear (timed out)";
        if (!isReused) killSessionUnchecked(sessionName);
        job.status = "failed";
        job.error = err;
        job.completedAt = new Date().toISOString();
        saveJob(job);
        return { jobId: job.id, done: false, output: null, error: err };
      }
      if (options.ref) {
        // Type the ref to filter the searchable picker (without Enter)
        Bun.sleepSync(500);
        const escapedRef = options.ref.replace(/'/g, "'\\''");
        try {
          execSync(`tmux send-keys -t "${sessionName}" '${escapedRef}'`, { stdio: "pipe" });
        } catch { /* session may have died */ }
        Bun.sleepSync(1000);
        // Verify the picker found a match (it shows "no matches" if the ref is invalid)
        const filtered = capturePaneUnchecked(sessionName, { lines: 30 });
        if (filtered && /no matches/i.test(filtered)) {
          const err = `Commit not found in picker: ${options.ref}`;
          if (!isReused) killSessionUnchecked(sessionName);
          job.status = "failed";
          job.error = err;
          job.completedAt = new Date().toISOString();
          saveJob(job);
          return { jobId: job.id, done: false, output: null, error: err };
        }
        sendKeysUnchecked(sessionName, "Enter");
      } else {
        // No ref specified — accept the default (latest commit)
        Bun.sleepSync(500);
        sendKeysUnchecked(sessionName, "Enter");
      }
      break;
    }
  }

  // Wait for the review to complete
  const result = waitForJob(job.id, { timeoutSec, intervalSec });

  // Fetch full scrollback — waitForJob only returns the visible pane,
  // which truncates long reviews
  const fullOutput = result.done ? (getJobFullOutput(job.id) ?? result.output) : result.output;
  return { jobId: job.id, done: result.done, output: fullOutput };
}
