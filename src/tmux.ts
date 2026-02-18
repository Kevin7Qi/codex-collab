// tmux helper functions for codex-collab

import { spawnSync } from "child_process";
import { config } from "./config.ts";

/**
 * Run a tmux command with argument array (no shell interpolation).
 * Returns { status, stdout } on success, throws on spawn failure.
 */
function tmux(args: string[], options?: { maxBuffer?: number }): { status: number; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: options?.maxBuffer,
  });
  return { status: result.status ?? 1, stdout: (result.stdout ?? "") as string };
}

function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

export function isTmuxAvailable(): boolean {
  return spawnSync("which", ["tmux"], { stdio: "pipe" }).status === 0;
}

export function sessionExists(sessionName: string): boolean {
  return tmux(["has-session", "-t", sessionName]).status === 0;
}

/**
 * Check if a screen looks like the codex TUI is ready for input
 * (shows the model info banner and input prompt, not an update dialog).
 */
function isCodexReady(screen: string): boolean {
  const lower = screen.toLowerCase();
  return (
    lower.includes("openai codex") &&
    lower.includes("? for shortcuts") &&
    !lower.includes("model:     loading")
  );
}

/**
 * Check if the screen shows an update prompt.
 */
function isUpdatePrompt(screen: string): boolean {
  const lower = screen.toLowerCase();
  return (
    lower.includes("update available") ||
    lower.includes("new version") ||
    lower.includes("update now") ||
    lower.includes("skip until next")
  );
}

/**
 * Poll for the codex TUI to be ready. If an update prompt appears, accept it.
 * If codex self-updates and exits, the shell command restarts it automatically;
 * we just keep polling through the transient post-update screen.
 */
function waitForCodexReady(
  sessionName: string,
  maxAttempts: number = 30,
  pollInterval: number = 2
): void {
  for (let i = 0; i < maxAttempts; i++) {
    const screen = capturePaneUnchecked(sessionName);
    if (!screen) {
      Bun.sleepSync(pollInterval * 1000);
      continue;
    }

    if (isCodexReady(screen)) {
      return;
    }

    if (isUpdatePrompt(screen)) {
      tmux(["send-keys", "-t", sessionName, "Enter"]);
      Bun.sleepSync(15_000);
      continue;
    }

    // Post-update screen or other transient state — keep polling.
    Bun.sleepSync(pollInterval * 1000);
  }
}

/**
 * Create a tmux session running the Codex TUI.
 *
 * Note: the inner shell command (`script -c "codex ..."`) is a pre-built string
 * from validated config values (model, reasoning, sandbox), not user input.
 * The outer tmux invocation uses spawnSync to avoid injection via sessionName/cwd.
 */
export function createSession(options: {
  jobId: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): { sessionName: string; success: boolean; error?: string } {
  const sessionName = getSessionName(options.jobId);
  const logFile = `${config.jobsDir}/${options.jobId}.log`;

  try {
    const codexArgs = [
      `-c`, `model=${options.model}`,
      `-c`, `model_reasoning_effort=${options.reasoningEffort}`,
      `-a`, `never`,
      `-s`, options.sandbox,
    ].join(" ");

    const exitFile = `${config.jobsDir}/${options.jobId}.exit`;

    // Inner shell command — values are from validated config enums, not raw user input.
    // The exit code is written to a .exit file immediately after script exits,
    // before the echo/sleep, so it's reliable even if the user closes the pane.
    //
    // Idle watchdog: a background loop checks log mtime every 60s. If codex
    // has been idle for defaultTimeout minutes, it sends /exit to trigger a
    // clean shutdown. Three safeguards prevent orphan watchdog processes:
    //   1. trap EXIT kills it when the parent shell exits
    //   2. tmux has-session check exits if the pane is gone
    //   3. it's a child of the pane shell, so gets SIGHUP on pane close
    const idleTimeoutSec = config.defaultTimeout * 60;
    const watchdog = `(while sleep 60; do tmux has-session -t "${sessionName}" 2>/dev/null || break; age=$(( $(date +%s) - $(stat -c %Y "${logFile}" 2>/dev/null || echo 0) )); [ $age -gt ${idleTimeoutSec} ] && tmux send-keys -l -t "${sessionName}" /exit && sleep 1 && tmux send-keys -t "${sessionName}" Enter && break; done) &`;
    const shellCmd = `${watchdog} _wd=$!; trap "kill $_wd 2>/dev/null" EXIT; script -q "${logFile}" -c "codex ${codexArgs}"; rc=$?; if grep -aq "Please restart Codex" "${logFile}" 2>/dev/null; then script -q "${logFile}" -c "codex ${codexArgs}"; rc=$?; fi; echo $rc > "${exitFile}"; echo "\\n\\n[codex-collab: Session complete. Closing in 30s.]"; sleep 30`;

    // Use -x 220 so the codex TUI doesn't truncate spinner lines.
    // The spinner suffix "esc to interrupt" must be visible for waitForJob
    // to detect work-in-progress; at the default 80 columns, long task
    // descriptions push it past the pane width.
    const result = spawnSync("tmux", [
      "new-session", "-d",
      "-s", sessionName,
      "-x", "220", "-y", "50",
      "-c", options.cwd,
      shellCmd,
    ], { stdio: "pipe", cwd: options.cwd });

    if (result.status !== 0) {
      return { sessionName, success: false, error: `tmux new-session exited ${result.status}` };
    }

    // Wait for codex TUI to be ready (handles update prompts if they appear)
    waitForCodexReady(sessionName);

    return { sessionName, success: true };
  } catch (err) {
    return {
      sessionName,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Send literal text without Enter (for typing into search fields / pickers).
 * Uses -l to prevent tmux from interpreting backslash sequences.
 */
export function sendLiteralUnchecked(sessionName: string, text: string): boolean {
  return tmux(["send-keys", "-l", "-t", sessionName, text]).status === 0;
}

/**
 * Send text + Enter to a session.
 */
export function sendMessageUnchecked(sessionName: string, message: string): boolean {
  if (!sendLiteralUnchecked(sessionName, message)) return false;
  Bun.sleepSync(Math.min(300 + message.length, 5000));
  return sendKeysUnchecked(sessionName, "Enter");
}

/**
 * Send raw keystrokes without Enter (for TUI navigation: arrows, numbers, Escape, Tab, Enter)
 */
export function sendKeysUnchecked(sessionName: string, keys: string): boolean {
  return tmux(["send-keys", "-t", sessionName, keys]).status === 0;
}

/**
 * Capture the current pane content.
 */
export function capturePaneUnchecked(
  sessionName: string,
  options: { lines?: number } = {}
): string | null {
  try {
    const args = ["capture-pane", "-t", sessionName, "-p"];

    const { status, stdout } = tmux(args);
    if (status !== 0) return null;

    if (options.lines) {
      const allLines = stdout.split("\n");
      return allLines.slice(-options.lines).join("\n");
    }

    return stdout;
  } catch {
    return null;
  }
}

/**
 * Get the full scrollback buffer.
 */
export function captureFullHistoryUnchecked(sessionName: string): string | null {
  try {
    const { status, stdout } = tmux(
      ["capture-pane", "-t", sessionName, "-p", "-S", "-"],
      { maxBuffer: 50 * 1024 * 1024 }
    );
    return status === 0 ? stdout : null;
  } catch {
    return null;
  }
}

/**
 * Clear the scrollback history for a session.
 */
export function clearHistoryUnchecked(sessionName: string): boolean {
  return tmux(["clear-history", "-t", sessionName]).status === 0;
}

export function killSessionUnchecked(sessionName: string): boolean {
  return tmux(["kill-session", "-t", sessionName]).status === 0;
}
