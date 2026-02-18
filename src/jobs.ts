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
import {
  extractSessionId,
  findSessionFile,
  parseSessionFile,
  type ParsedSessionData,
} from "./session-parser.ts";
import { processOutput } from "./utils.ts";
import {
  createSession,
  killSessionUnchecked,
  sessionExists,
  capturePaneUnchecked,
  captureFullHistoryUnchecked,
  clearHistoryUnchecked,
  sendMessageUnchecked,
  sendLiteralUnchecked,
  sendKeysUnchecked,
} from "./tmux.ts";

export interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "killed";
  prompt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  sandbox: SandboxMode;
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

const JOB_ID_RE = /^[0-9a-f]{8}$/;
const TERMINAL_STATUSES: ReadonlySet<Job["status"]> = new Set(["completed", "failed", "killed"]);

function isValidJobId(jobId: string): boolean {
  return JOB_ID_RE.test(jobId);
}

function getJobPath(jobId: string): string {
  if (!isValidJobId(jobId)) throw new Error(`Invalid job ID: ${jobId}`);
  return join(config.jobsDir, `${jobId}.json`);
}

export function saveJob(job: Job): void {
  ensureJobsDir();
  writeFileSync(getJobPath(job.id), JSON.stringify(job, null, 2));

  // Clean up transient files once the job reaches a terminal state
  if (TERMINAL_STATUSES.has(job.status)) {
    try { unlinkSync(join(config.jobsDir, `${job.id}.log`)); } catch {}
    try { unlinkSync(join(config.jobsDir, `${job.id}.exit`)); } catch {}
  }
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

/** Strip ANSI codes and TUI chrome before storing result in the job JSON. */
function cleanResult(raw: string): string {
  return processOutput(raw, { contentOnly: true, stripAnsi: true });
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
    try { unlinkSync(join(config.jobsDir, `${jobId}.prompt`)); } catch {}
    try { unlinkSync(join(config.jobsDir, `${jobId}.log`)); } catch {}
    try { unlinkSync(join(config.jobsDir, `${jobId}.exit`)); } catch {}
    return true;
  } catch {
    return false;
  }
}

export interface StartInteractiveJobOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
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
    model: options.model || config.model,
    reasoningEffort: options.reasoningEffort || config.defaultReasoningEffort,
    sandbox: options.sandbox || config.defaultSandbox,
    cwd,
    createdAt: new Date().toISOString(),
  };

  saveJob(job);

  const result = createSession({
    jobId,
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
    killSessionUnchecked(job.tmuxSession);
  }

  job.status = "killed";
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

export function cleanupOldJobs(maxAgeDays: number = 7): { deleted: number; sessions: number } {
  const jobs = listJobs();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let sessions = 0;

  for (const job of jobs) {
    if (!TERMINAL_STATUSES.has(job.status)) continue;

    // Kill stale tmux sessions for all terminal jobs
    if (job.tmuxSession && sessionExists(job.tmuxSession)) {
      killSessionUnchecked(job.tmuxSession);
      sessions++;
    }

    // Delete job files only if old enough
    const jobTime = new Date(job.completedAt || job.createdAt).getTime();
    if (jobTime < cutoff) {
      if (deleteJob(job.id)) deleted++;
    }
  }

  return { deleted, sessions };
}

export function refreshJobStatus(jobId: string): Job | null {
  const job = loadJob(jobId);
  if (!job) return null;

  if (job.status === "running" && job.tmuxSession) {
    if (!sessionExists(job.tmuxSession)) {
      job.completedAt = new Date().toISOString();
      const logFile = join(config.jobsDir, `${jobId}.log`);
      try {
        job.result = cleanResult(readFileSync(logFile, "utf-8"));
      } catch {
        // Log may not exist if session was killed very early
      }
      // The .exit file is written by the shell immediately after codex exits,
      // before the echo/sleep, so it exists iff codex ran to completion.
      const exitFile = join(config.jobsDir, `${jobId}.exit`);
      try {
        const exitCode = readFileSync(exitFile, "utf-8").trim();
        job.status = exitCode === "0" ? "completed" : "failed";
        if (exitCode !== "0") {
          job.error = `Codex exited with code ${exitCode}`;
        }
      } catch {
        job.status = "killed";
      }
      saveJob(job);
    } else {
      const output = capturePaneUnchecked(job.tmuxSession, { lines: 20 });
      if (output && output.includes("[codex-collab: Session complete")) {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        const fullOutput = captureFullHistoryUnchecked(job.tmuxSession);
        if (fullOutput) {
          job.result = cleanResult(fullOutput);
        }
        saveJob(job);
      } else if (isInactiveTimedOut(job)) {
        // The watchdog sends /exit for a clean shutdown; give it a moment
        // to produce the "Session complete" marker before we intervene.
        Bun.sleepSync(3000);
        const recheck = capturePaneUnchecked(job.tmuxSession, { lines: 20 });
        if (recheck && recheck.includes("[codex-collab: Session complete")) {
          job.status = "completed";
          job.completedAt = new Date().toISOString();
          const fullOutput = captureFullHistoryUnchecked(job.tmuxSession);
          if (fullOutput) job.result = cleanResult(fullOutput);
        } else {
          killSessionUnchecked(job.tmuxSession);
          job.status = "completed";
          job.error = `Session expired after ${config.defaultTimeout} minutes of inactivity`;
          job.completedAt = new Date().toISOString();
        }
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

  // Verify codex is still running, not sitting at the post-exit "read" prompt.
  // Prompted jobs leave tmux alive at `read` after codex exits.
  const screen = capturePaneUnchecked(job.tmuxSession, { lines: 10 });
  if (!screen || screen.includes("[codex-collab: Session complete")) return false;

  if (!sendMessageUnchecked(job.tmuxSession, "/new")) return false;

  job.prompt = "(reset)";
  job.startedAt = new Date().toISOString();
  job.completedAt = undefined;
  job.result = undefined;
  job.error = undefined;
  saveJob(job);
  return true;
}

export function getAttachCommand(jobId: string): string | null {
  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) return null;

  return `tmux attach -t "${job.tmuxSession}"`;
}

/**
 * Confirm screen stability: check that the pane is unchanged for N consecutive
 * captures at 3s intervals, and the spinner hasn't reappeared.
 * Returns { confirmed: true } if stable, { confirmed: false } if spinner came back.
 */
function confirmStable(
  sessionName: string,
  currentOutput: string,
  requiredStable: number,
  deadline: number,
): { confirmed: boolean; lastOutput: string | null } {
  const interval = 3_000;
  const confirmDeadline = Math.min(Date.now() + 30_000, deadline);
  let stableCount = 0;
  let lastScreen = currentOutput;
  let lastOutput: string | null = currentOutput;

  while (Date.now() < confirmDeadline) {
    Bun.sleepSync(interval);
    const check = capturePaneUnchecked(sessionName, { lines: 50 });
    if (check === null) return { confirmed: true, lastOutput: null };
    if (check.toLowerCase().includes("esc to interrupt")) {
      return { confirmed: false, lastOutput: check };
    }
    if (check === lastScreen) {
      stableCount++;
      if (stableCount >= requiredStable) return { confirmed: true, lastOutput: check };
    } else {
      stableCount = 0;
      lastScreen = check;
    }
    lastOutput = check;
  }
  return { confirmed: true, lastOutput };
}

/**
 * Poll a job's capture output until codex finishes working.
 * Returns the final capture output, or null if timed out / job not found.
 */
export function waitForJob(
  jobId: string,
  options: { timeoutSec?: number; intervalSec?: number; requireSpinner?: boolean; spinnerSeen?: boolean } = {}
): { done: boolean; output: string | null } {

  const timeoutSec = options.timeoutSec ?? 900;
  const intervalSec = options.intervalSec ?? 30;
  const requireSpinner = options.requireSpinner ?? false;
  const deadline = Date.now() + timeoutSec * 1000;

  const job = loadJob(jobId);
  if (!job || !job.tmuxSession) {
    return { done: false, output: null };
  }

  // Two spinner flags:
  // - confirmedInLoop: the wait loop itself observed the spinner (authoritative)
  // - spinnerSeen: ensureSubmitted observed the spinner before this loop started
  // The quick 6s stability check only fires when confirmedInLoop is true.
  // When only spinnerSeen is true, a stricter 15s stability check is used
  // to avoid false completion during quiet gaps between tool calls.
  let confirmedInLoop = false;
  const spinnerSeen = options.spinnerSeen ?? false;
  const waitStarted = Date.now();
  const gracePeriodMs = spinnerSeen
    ? 10_000  // ensureSubmitted confirmed submission; shorter wait before stability check
    : Math.max(30_000, intervalSec * 2.5 * 1000);

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
      confirmedInLoop = true;
    } else if (confirmedInLoop) {
      // Spinner appeared AND disappeared in this loop — confirm with standard
      // stability check: 2 consecutive unchanged captures (~6s).
      const { confirmed, lastOutput } = confirmStable(job.tmuxSession, output, 2, deadline);
      if (lastOutput) output = lastOutput;
      if (confirmed) return { done: true, output };
      continue;
    } else if (spinnerSeen && Date.now() - waitStarted > gracePeriodMs) {
      // ensureSubmitted saw the spinner but this loop didn't — likely a fast
      // completion. Use a stricter stability check (5 consecutive = ~15s) to
      // avoid false completion during quiet gaps between tool calls.
      const { confirmed, lastOutput } = confirmStable(job.tmuxSession, output, 5, deadline);
      if (lastOutput) output = lastOutput;
      if (confirmed) return { done: true, output };
      continue;
    } else if (!spinnerSeen && !confirmedInLoop && Date.now() - waitStarted > gracePeriodMs) {
      // Grace period expired and spinner was never seen by anyone.
      // If requireSpinner is set, this means the submission wasn't confirmed —
      // report not-done instead of falsely declaring completion.
      // Otherwise (manual `wait`), assume codex finished before we started polling.
      return { done: !requireSpinner, output };
    }

    Bun.sleepSync(intervalSec * 1000);
  }

  // Timed out — return last capture
  const finalOutput = capturePaneUnchecked(job.tmuxSession, { lines: 50 });
  return { done: false, output: finalOutput };
}

/**
 * On completion, fetch full scrollback (pane capture truncates long output).
 * Falls back to the wait result's partial output.
 */
function resolveOutput(
  jobId: string,
  result: { done: boolean; output: string | null }
): string | null {
  if (result.done) return getJobFullOutput(jobId) ?? result.output;
  return result.output;
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

/**
 * Resume an existing interactive session: validate it's alive and return it.
 * Conversation context is preserved. Use `resetJob` to clear context with /new.
 */
function resumeSession(jobId: string): { job: Job; sessionName: string } | { error: string } {
  const existing = loadJob(jobId);
  if (!existing?.tmuxSession) return { error: "Job not found or no session" };
  if (existing.status !== "running" || !sessionExists(existing.tmuxSession)) {
    return { error: "Session is no longer running" };
  }
  // Guard: check Codex is still alive (not at post-exit read prompt)
  const screen = capturePaneUnchecked(existing.tmuxSession, { lines: 10 });
  if (!screen || screen.includes("[codex-collab: Session complete")) {
    return { error: "Codex has exited in this session" };
  }
  return { job: existing, sessionName: existing.tmuxSession };
}

interface AcquireSessionOptions {
  resumeJobId?: string;
  prompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  cwd: string;
}

type AcquireResult =
  | { job: Job; sessionName: string; isResumed: boolean }
  | { error: string; jobId: string };

/**
 * Acquire a session: either resume an existing one or start a new one.
 * Shared by runPrompt and runReview.
 */
function acquireSession(opts: AcquireSessionOptions): AcquireResult {
  if (opts.resumeJobId) {
    const resumed = resumeSession(opts.resumeJobId);
    if ("error" in resumed) {
      return { error: resumed.error, jobId: opts.resumeJobId };
    }
    // Clear tmux scrollback so output capture returns only the new response
    clearHistoryUnchecked(resumed.sessionName);
    resumed.job.prompt = opts.prompt;
    resumed.job.startedAt = new Date().toISOString();
    resumed.job.completedAt = undefined;
    saveJob(resumed.job);
    return { job: resumed.job, sessionName: resumed.sessionName, isResumed: true };
  }

  const job = startInteractiveJob({
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    sandbox: opts.sandbox,
    cwd: opts.cwd,
  });
  if (job.status === "failed" || !job.tmuxSession) {
    return { error: job.error || "Failed to start session", jobId: job.id };
  }
  return { job, sessionName: job.tmuxSession, isResumed: false };
}

/**
 * Verify that Codex started processing after a prompt was sent.
 * Rapid-polls for the spinner (500ms intervals), then retries Enter if needed.
 * Returns true if the spinner was observed (prompt confirmed submitted).
 */
function ensureSubmitted(
  sessionName: string,
  maxRetries: number = 2,
): boolean {
  // Phase 1: rapid poll for spinner — catches fast tasks that complete in 1-3s
  const rapidEnd = Date.now() + 5_000;
  while (Date.now() < rapidEnd) {
    const screen = capturePaneUnchecked(sessionName, { lines: 50 });
    if (!screen) return true; // session gone — was submitted
    if (screen.toLowerCase().includes("esc to interrupt")) return true;
    Bun.sleepSync(500);
  }

  // Phase 2: no spinner seen — Enter may have been swallowed. Retry and check.
  for (let i = 0; i < maxRetries; i++) {
    sendKeysUnchecked(sessionName, "Enter");
    Bun.sleepSync(3_000);
    const screen = capturePaneUnchecked(sessionName, { lines: 50 });
    if (!screen) return true;
    if (screen.toLowerCase().includes("esc to interrupt")) return true;
  }
  return false;
}

export interface RunPromptOptions {
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandbox?: SandboxMode;
  timeoutSec?: number;
  intervalSec?: number;
  resumeJobId?: string;
}

export interface RunResult {
  jobId: string;
  done: boolean;
  output: string | null;
  error?: string;
}

/**
 * Run a prompt in a single call: start (or resume) an interactive session, send the prompt, wait, return output.
 */
export function runPrompt(options: RunPromptOptions): RunResult {
  const timeoutSec = options.timeoutSec ?? 900;
  const intervalSec = options.intervalSec ?? 30;

  const session = acquireSession({
    resumeJobId: options.resumeJobId,
    prompt: options.prompt,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: options.sandbox,
    cwd: options.cwd,
  });
  if ("error" in session) {
    return { jobId: session.jobId, done: false, output: null, error: session.error };
  }
  const { job, sessionName } = session;

  // Send the prompt
  if (!sendMessageUnchecked(sessionName, options.prompt)) {
    return { jobId: job.id, done: false, output: null, error: "Failed to send prompt to session" };
  }
  const preSubmitMs = Date.now();
  const spinnerSeen = ensureSubmitted(sessionName);
  const remainingTimeout = Math.max(0, timeoutSec - (Date.now() - preSubmitMs) / 1000);

  // Wait for completion (done = spinner stopped, codex is idle — session stays reusable)
  const result = waitForJob(job.id, { timeoutSec: remainingTimeout, intervalSec, requireSpinner: true, spinnerSeen });

  // Fetch full scrollback on completion (pane capture truncates long output)
  const fullOutput = resolveOutput(job.id, result);
  if (!result.done) {
    return {
      jobId: job.id, done: false, output: fullOutput,
      error: "Codex never started processing (spinner not detected). "
        + "Session is still running — check with: codex-collab capture " + job.id,
    };
  }
  return { jobId: job.id, done: true, output: fullOutput };
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
  resumeJobId?: string;
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

  const session = acquireSession({
    resumeJobId: options.resumeJobId,
    prompt: "(review)",
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    sandbox: "read-only",
    cwd: options.cwd,
  });
  if ("error" in session) {
    return { jobId: session.jobId, done: false, output: null, error: session.error };
  }
  const { job, sessionName, isResumed } = session;

  function failReview(err: string): ReviewResult {
    if (!isResumed) killSessionUnchecked(sessionName);
    job.status = "failed";
    job.error = err;
    job.completedAt = new Date().toISOString();
    saveJob(job);
    return { jobId: job.id, done: false, output: null, error: err };
  }

  // Custom mode: send /review with instructions directly (bypasses menu)
  if (options.mode === "custom" && options.instructions) {
    sendMessageUnchecked(sessionName, `/review ${options.instructions}`);
    const preSubmitMs = Date.now();
    const spinnerSeen = ensureSubmitted(sessionName);
    const remainingTimeout = Math.max(0, timeoutSec - (Date.now() - preSubmitMs) / 1000);
    const result = waitForJob(job.id, { timeoutSec: remainingTimeout, intervalSec, requireSpinner: true, spinnerSeen });
    const fullOutput = resolveOutput(job.id, result);
    if (!result.done) {
      return {
        jobId: job.id, done: false, output: fullOutput,
        error: "Codex never started processing (spinner not detected). "
          + "Session is still running — check with: codex-collab capture " + job.id,
      };
    }
    return { jobId: job.id, done: true, output: fullOutput };
  }

  // Menu modes: send /review and navigate the TUI menu
  if (!sendMessageUnchecked(sessionName, "/review")) {
    return failReview("Failed to send /review to session");
  }

  // Wait for the review preset menu to appear
  const menuScreen = waitForContent(sessionName, /select a review preset/i, 30);
  if (!menuScreen) {
    return failReview("Review menu did not appear (timed out)");
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
        return failReview("Commit picker did not appear (timed out)");
      }
      if (options.ref) {
        // Type the ref to filter the searchable picker (literal, without Enter)
        Bun.sleepSync(500);
        sendLiteralUnchecked(sessionName, options.ref);
        Bun.sleepSync(1000);
        // Verify the picker found a match (it shows "no matches" if the ref is invalid)
        const filtered = capturePaneUnchecked(sessionName, { lines: 30 });
        if (filtered && /no matches/i.test(filtered)) {
          return failReview(`Commit not found in picker: ${options.ref}`);
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
  const result = waitForJob(job.id, { timeoutSec, intervalSec, requireSpinner: true });

  // Fetch full scrollback — waitForJob only returns the visible pane,
  // which truncates long reviews
  const fullOutput = resolveOutput(job.id, result);
  if (!result.done) {
    return {
      jobId: job.id, done: false, output: fullOutput,
      error: "Codex never started processing (spinner not detected). "
        + "Session is still running — check with: codex-collab capture " + job.id,
    };
  }
  return { jobId: job.id, done: true, output: fullOutput };
}
