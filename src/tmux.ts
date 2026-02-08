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
      `model="${options.model}"`,
      `-c`,
      `model_reasoning_effort="${options.reasoningEffort}"`,
      `-c`,
      `skip_update_check=true`,
      `-a`,
      `never`,
      `-s`,
      options.sandbox,
    ].join(" ");

    const shellCmd = `script -q "${logFile}" codex ${codexArgs}; echo "\\n\\n[codex-collab: Session complete. Press Enter to close.]"; read`;

    execSync(
      `tmux new-session -d -s "${sessionName}" -c "${options.cwd}" '${shellCmd}'`,
      { stdio: "pipe", cwd: options.cwd }
    );

    // Give codex a moment to initialize
    spawnSync("sleep", ["1"]);

    // Skip update prompt if it appears
    execSync(`tmux send-keys -t "${sessionName}" "3"`, { stdio: "pipe" });
    spawnSync("sleep", ["0.5"]);
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: "pipe" });
    spawnSync("sleep", ["1"]);

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
 * Send text + Enter to a session (for chat input)
 */
export function sendMessage(sessionName: string, message: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

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
 * Send raw keystrokes without Enter (for TUI navigation: arrows, numbers, Escape, Tab, Enter)
 */
export function sendKeys(sessionName: string, keys: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

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
 * Send control sequences (C-c, C-d, etc.)
 */
export function sendControl(sessionName: string, key: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux send-keys -t "${sessionName}" ${key}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
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
 * Get the full scrollback buffer
 */
export function captureFullHistory(sessionName: string): string | null {
  if (!sessionExists(sessionName)) {
    return null;
  }

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

export function killSession(sessionName: string): boolean {
  if (!sessionExists(sessionName)) {
    return false;
  }

  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
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

    const content = capturePane(sessionName, { lines: 100 });
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
