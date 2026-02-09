// tmux helper functions for codex-collab

import { execSync, spawnSync } from "child_process";
import { config } from "./config.ts";

export interface TmuxSession {
  name: string;
  attached: boolean;
  windows: number;
  created: string;
}

export function getSessionName(jobId: string): string {
  return `${config.tmuxPrefix}-${jobId}`;
}

export function isTmuxAvailable(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function sessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a screen looks like the codex TUI is ready for input
 * (shows the model info banner and input prompt, not an update dialog).
 */
function isCodexReady(screen: string): boolean {
  const lower = screen.toLowerCase();
  // Must show the TUI banner AND have finished loading the model
  // (the "loading" screen also shows "? for shortcuts" so we can't rely on that alone)
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
 * Polls up to maxAttempts times with pollInterval seconds between checks.
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
      return; // TUI is ready for input
    }

    if (isUpdatePrompt(screen)) {
      // Accept the update (Enter selects the default/first option)
      execSync(`tmux send-keys -t "${sessionName}" Enter`, {
        stdio: "pipe",
      });
      // Give the update time to download and install
      spawnSync("sleep", ["15"]);
      continue; // Re-check after update
    }

    // Not ready yet, not update prompt — codex is still loading
    spawnSync("sleep", [String(pollInterval)]);
  }
}

/**
 * Create a new tmux session running codex.
 * If interactive is true, skip auto-sending a prompt (leave user at TUI input).
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
      `-c`,
      `model=${options.model}`,
      `-c`,
      `model_reasoning_effort=${options.reasoningEffort}`,
      `-a`,
      `never`,
      `-s`,
      options.sandbox,
    ].join(" ");

    // Use script -c on Linux to wrap the full codex command as a single string,
    // preventing script from consuming codex's flags (e.g. -s).
    // The outer tmux command uses single quotes, and script -c uses double quotes.
    // Model args are unquoted inside the double quotes (they're simple alphanumeric values).
    const shellCmd = `script -q "${logFile}" -c "codex ${codexArgs}"; echo "\\n\\n[codex-collab: Session complete. Press Enter to close.]"; read`;

    // Use -x 220 so the codex TUI doesn't truncate spinner lines.
    // The spinner suffix "esc to interrupt" must be visible for waitForJob
    // to detect work-in-progress; at the default 80 columns, long task
    // descriptions push it past the pane width.
    execSync(
      `tmux new-session -d -s "${sessionName}" -x 220 -y 50 -c "${options.cwd}" '${shellCmd}'`,
      { stdio: "pipe", cwd: options.cwd }
    );

    // Wait for codex TUI to be ready (handles update prompts if they appear)
    waitForCodexReady(sessionName);

    // If not interactive, send the prompt
    if (!options.interactive && options.prompt) {
      const promptFile = `${config.jobsDir}/${options.jobId}.prompt`;
      const fs = require("fs");
      fs.writeFileSync(promptFile, options.prompt);

      const promptContent = options.prompt.replace(/'/g, "'\\''");

      if (options.prompt.length < 5000) {
        execSync(
          `tmux send-keys -t "${sessionName}" '${promptContent}'`,
          { stdio: "pipe" }
        );
        spawnSync("sleep", ["0.3"]);
        execSync(`tmux send-keys -t "${sessionName}" Enter`, {
          stdio: "pipe",
        });
      } else {
        execSync(`tmux load-buffer "${promptFile}"`, { stdio: "pipe" });
        execSync(`tmux paste-buffer -t "${sessionName}"`, {
          stdio: "pipe",
        });
        spawnSync("sleep", ["0.3"]);
        execSync(`tmux send-keys -t "${sessionName}" Enter`, {
          stdio: "pipe",
        });
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
 * Send text + Enter to a session (unchecked — skips sessionExists guard)
 */
export function sendMessageUnchecked(sessionName: string, message: string): boolean {
  try {
    const escapedMessage = message.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedMessage}'`, {
      stdio: "pipe",
    });
    spawnSync("sleep", ["0.3"]);
    execSync(`tmux send-keys -t "${sessionName}" Enter`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send text + Enter to a session (for chat input)
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  return sendMessageUnchecked(sessionName, message);
}

/**
 * Send raw keystrokes without Enter (unchecked — skips sessionExists guard)
 */
export function sendKeysUnchecked(sessionName: string, keys: string): boolean {
  try {
    execSync(`tmux send-keys -t "${sessionName}" ${keys}`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send raw keystrokes without Enter (for TUI navigation: arrows, numbers, Escape, Tab, Enter)
 */
export function sendKeys(sessionName: string, keys: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  return sendKeysUnchecked(sessionName, keys);
}

/**
 * Send control sequences (unchecked — skips sessionExists guard)
 */
export function sendControlUnchecked(sessionName: string, key: string): boolean {
  try {
    execSync(`tmux send-keys -t "${sessionName}" ${key}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send control sequences (C-c, C-d, etc.)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  return sendControlUnchecked(sessionName, key);
}

/**
 * Capture the current pane content (unchecked — skips sessionExists guard)
 */
export function capturePaneUnchecked(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  try {
    let cmd = `tmux capture-pane -t "${sessionName}" -p`;

    if (options.start !== undefined) {
      cmd += ` -S ${options.start}`;
    }

    const output = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (options.lines) {
      const allLines = output.split("\n");
      return allLines.slice(-options.lines).join("\n");
    }

    return output;
  } catch {
    return null;
  }
}

/**
 * Capture the current pane content
 */
export function capturePane(
  sessionName: string,
  options: { lines?: number; start?: number } = {}
): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  return capturePaneUnchecked(sessionName, options);
}

/**
 * Get the full scrollback buffer (unchecked — skips sessionExists guard)
 */
export function captureFullHistoryUnchecked(sessionName: string): string | null {
  try {
    const output = execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -`,
      {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    return output;
  } catch {
    return null;
  }
}

/**
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

  return captureFullHistoryUnchecked(sessionName);
}

export function killSessionUnchecked(sessionName: string): boolean {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  return killSessionUnchecked(sessionName);
}

export function listSessions(): TmuxSession[] {
  try {
    const output = execSync(
      `tmux list-sessions -F "#{session_name}|#{session_attached}|#{session_windows}|#{session_created}" 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    return output
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

export function getAttachCommand(sessionName: string): string {
  return `tmux attach -t "${sessionName}"`;
}

export function isSessionActive(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    const pid = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!pid) return false;

    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

export function watchSession(
  sessionName: string,
  callback: (content: string) => void,
  intervalMs: number = 1000
): { stop: () => void } {
  let lastContent = "";
  let running = true;

  const interval = setInterval(() => {
    if (!running) return;

    const content = capturePaneUnchecked(sessionName, { lines: 100 });
    if (content && content !== lastContent) {
      const newContent = content.replace(lastContent, "").trim();
      if (newContent) {
        callback(newContent);
      }
      lastContent = content;
    }

    if (!sessionExists(sessionName)) {
      running = false;
      clearInterval(interval);
    }
  }, intervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(interval);
    },
  };
}
