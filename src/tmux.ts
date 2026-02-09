// tmux helper functions for codex-collab

import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { config } from "./config.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

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

export function getSessionName(jobId: string): string {
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
 */
function waitForCodexReady(
  sessionName: string,
  maxAttempts: number = 15,
  pollInterval: number = 2
): void {
  for (let i = 0; i < maxAttempts; i++) {
    const screen = capturePaneUnchecked(sessionName);
    if (!screen) {
      spawnSync("sleep", [String(pollInterval)]);
      continue;
    }

    if (isCodexReady(screen)) {
      return;
    }

    if (isUpdatePrompt(screen)) {
      tmux(["send-keys", "-t", sessionName, "Enter"]);
      spawnSync("sleep", ["15"]);
      continue;
    }

    spawnSync("sleep", [String(pollInterval)]);
  }
}

/**
 * Create a new tmux session running codex.
 * If interactive is true, skip auto-sending a prompt (leave user at TUI input).
 *
 * Note: the inner shell command (`script -c "codex ..."`) is a pre-built string
 * from validated config values (model, reasoning, sandbox), not user input.
 * The outer tmux invocation uses spawnSync to avoid injection via sessionName/cwd.
 */
export function createSession(options: {
  jobId: string;
  prompt?: string;
  interactive?: boolean;
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
    // before the echo/read, so it's reliable even if the user closes the pane.
    const shellCmd = `script -q "${logFile}" -c "codex ${codexArgs}"; echo $? > "${exitFile}"; echo "\\n\\n[codex-collab: Session complete. Closing in 30s.]"; sleep 30`;

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

    // If not interactive, send the prompt
    if (!options.interactive && options.prompt) {
      const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
      writeFileSync(promptFile, options.prompt);

      if (options.prompt.length < 5000) {
        // -l: literal mode, prevents tmux from interpreting backslash sequences
        tmux(["send-keys", "-l", "-t", sessionName, options.prompt]);
        spawnSync("sleep", ["0.3"]);
        tmux(["send-keys", "-t", sessionName, "Enter"]);
      } else {
        tmux(["load-buffer", promptFile]);
        tmux(["paste-buffer", "-t", sessionName]);
        spawnSync("sleep", ["0.3"]);
        tmux(["send-keys", "-t", sessionName, "Enter"]);
      }
    }

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
 * Send text + Enter to a session.
 * Uses -l (literal) to prevent tmux from interpreting backslash sequences.
 */
export function sendMessageUnchecked(sessionName: string, message: string): boolean {
  try {
    if (tmux(["send-keys", "-l", "-t", sessionName, message]).status !== 0) return false;
    spawnSync("sleep", ["0.3"]);
    return tmux(["send-keys", "-t", sessionName, "Enter"]).status === 0;
  } catch {
    return false;
  }
}

/**
 * Send raw keystrokes without Enter (for TUI navigation: arrows, numbers, Escape, Tab, Enter)
 */
export function sendKeysUnchecked(sessionName: string, keys: string): boolean {
  return tmux(["send-keys", "-t", sessionName, keys]).status === 0;
}

/**
 * Send control sequences (C-c, C-d, etc.)
 */
export function sendControlUnchecked(sessionName: string, key: string): boolean {
  return tmux(["send-keys", "-t", sessionName, key]).status === 0;
}

/**
 * Capture the current pane content.
 */
export function capturePaneUnchecked(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  try {
    const args = ["capture-pane", "-t", sessionName, "-p"];
    if (options.start !== undefined) {
      args.push("-S", String(options.start));
    }

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

export function listSessions(): TmuxSession[] {
  try {
    const { status, stdout } = tmux([
      "list-sessions", "-F",
      "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}",
    ]);
    if (status !== 0) return [];

    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.startsWith(config.tmuxPrefix))
      .map((line) => {
        const [name, attached, windows, created] = line.split("|");
        return {
          name,
          attached: attached === "1",
          windows: parseInt(windows, 10),
          created: new Date(parseInt(created, 10) * 1000).toISOString(),
        };
      });
  } catch {
    return [];
  }
}

export function isSessionActive(sessionName: string): boolean {
  if (!sessionExists(sessionName)) return false;

  try {
    const { status, stdout } = tmux([
      "list-panes", "-t", sessionName, "-F", "#{pane_pid}",
    ]);
    if (status !== 0) return false;

    const pid = stdout.trim();
    if (!pid) return false;

    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}
