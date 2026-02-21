// src/events.ts — Event dispatcher for app server notifications

import { appendFileSync, mkdirSync, existsSync } from "fs";
import type {
  ItemStartedParams, ItemCompletedParams, DeltaParams,
  FileChange, CommandExec,
} from "./types";

type ProgressCallback = (line: string) => void;

export class EventDispatcher {
  private accumulatedOutput = "";
  private filesChanged: FileChange[] = [];
  private commandsRun: CommandExec[] = [];
  private logBuffer: string[] = [];
  private logPath: string;
  private onProgress: ProgressCallback;

  constructor(
    shortId: string,
    logsDir: string,
    onProgress?: ProgressCallback,
  ) {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    this.logPath = `${logsDir}/${shortId}.log`;
    this.onProgress = onProgress ?? ((line) => process.stderr.write(line + "\n"));
  }

  handleItemStarted(params: ItemStartedParams): void {
    const { item } = params;
    this.log(`item/started: ${item.type} ${item.id}`);

    switch (item.type) {
      case "reasoning":
        this.progress("Reasoning...");
        break;
      case "commandExecution":
        this.progress(`Running: ${item.command}`);
        break;
      case "agentMessage":
        this.progress("Agent responding...");
        break;
    }
  }

  handleItemCompleted(params: ItemCompletedParams): void {
    const { item } = params;
    this.log(`item/completed: ${item.type} ${item.id}`);

    switch (item.type) {
      case "commandExecution": {
        this.commandsRun.push({
          command: item.command,
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
        });
        const duration = item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : "";
        const exit = item.exitCode !== null && item.exitCode !== undefined ? `exit ${item.exitCode}` : "";
        const parts = [exit, duration].filter(Boolean).join(", ");
        this.progress(`Command completed${parts ? ` (${parts})` : ""}`);
        break;
      }
      case "fileChange": {
        for (const change of item.changes) {
          this.filesChanged.push({
            path: change.path,
            kind: change.kind.type,
            diff: change.diff,
          });
          this.progress(`Edited: ${change.path} (${change.kind.type})`);
        }
        break;
      }
    }
  }

  handleDelta(method: string, params: DeltaParams): void {
    this.log(`${method}: +${params.delta.length} chars`);

    if (method === "item/agentMessage/delta") {
      this.accumulatedOutput += params.delta;
    }
    // commandExecution/outputDelta and fileChange/outputDelta are logged only
  }

  getAccumulatedOutput(): string {
    return this.accumulatedOutput;
  }

  getFilesChanged(): FileChange[] {
    return [...this.filesChanged];
  }

  getCommandsRun(): CommandExec[] {
    return [...this.commandsRun];
  }

  reset(): void {
    this.accumulatedOutput = "";
    this.filesChanged = [];
    this.commandsRun = [];
  }

  flush(): void {
    if (this.logBuffer.length === 0) return;
    try {
      appendFileSync(this.logPath, this.logBuffer.join("\n") + "\n");
    } catch (e) {
      console.error(`[codex] Warning: Failed to write log to ${this.logPath}: ${e instanceof Error ? e.message : e}`);
    }
    this.logBuffer = [];
  }

  private progress(text: string): void {
    this.onProgress(text);
    this.log(`[codex] ${text}`);
  }

  private log(entry: string): void {
    const ts = new Date().toISOString();
    this.logBuffer.push(`${ts} ${entry}`);
    // Auto-flush every 20 entries
    if (this.logBuffer.length >= 20) this.flush();
  }
}
