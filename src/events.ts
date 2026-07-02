// src/events.ts — Event dispatcher for app server notifications

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  isKnownItem,
  type ItemStartedParams, type ItemCompletedParams, type DeltaParams,
  type ErrorNotificationParams,
  type FileChange, type CommandExec,
} from "./types";

type ProgressCallback = (line: string) => void;

export class EventDispatcher {
  private accumulatedOutput = "";
  private finalAnswerOutput = "";
  /** Set from `exitedReviewMode.review`. For review turns this IS the
   *  deliverable; it takes precedence over the short final_answer sign-off
   *  Codex tags on at the end (which used to shadow the full review body). */
  private reviewOutput = "";
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
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    this.logPath = join(logsDir, `${shortId}.log`);
    this.onProgress = onProgress ?? ((line) => process.stderr.write(line + "\n"));
  }

  handleItemStarted(params: ItemStartedParams): void {
    const { item } = params;
    if (!isKnownItem(item)) return;

    if (item.type === "commandExecution") {
      this.progress(`Running: ${item.command}`);
    }

    // Separate consecutive messages
    if (item.type === "agentMessage" && this.accumulatedOutput.length > 0) {
      this.accumulatedOutput += "\n";
    }
  }

  handleItemCompleted(params: ItemCompletedParams): void {
    const { item } = params;
    if (!isKnownItem(item)) return;

    // Track agent message phases for output filtering
    if (item.type === "agentMessage") {
      if (item.phase === "final_answer") {
        // Final answer: append text (supports multiple final_answer messages)
        if (item.text) {
          if (this.finalAnswerOutput.length > 0) {
            this.finalAnswerOutput += "\n";
          }
          this.finalAnswerOutput += item.text;
        }
      } else if (item.text) {
        // Intermediate agent message (planning/status): show as progress
        const preview = item.text.length > 120
          ? item.text.slice(0, 117) + "..."
          : item.text;
        this.progress(preview);
      }
    }

    switch (item.type) {
      case "commandExecution": {
        if (item.status !== "completed") {
          this.progress(`Command ${item.status}: ${item.command}`);
          break;
        }
        this.commandsRun.push({
          command: item.command,
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
        });
        const exit = item.exitCode ?? "?";
        this.log(`command: ${item.command} (exit ${exit})`);
        break;
      }
      case "fileChange": {
        if (item.status !== "completed") {
          const paths = item.changes.map(c => c.path).join(", ");
          this.progress(`File change ${item.status}: ${paths || "(no paths)"}`);
          break;
        }
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
      case "exitedReviewMode": {
        this.accumulatedOutput = item.review;
        this.reviewOutput = item.review;
        this.log(`review output (${item.review.length} chars)`);
        break;
      }
    }
  }

  handleDelta(method: string, params: DeltaParams): void {
    if (method === "item/agentMessage/delta") {
      this.accumulatedOutput += params.delta;
      // Final-answer text is captured whole from item/completed (deltas
      // always precede their item's completion), so no per-delta routing
      // into finalAnswerOutput is needed here.
    }
    // No per-character logging — accumulated text is logged at flush
  }

  handleError(params: ErrorNotificationParams): void {
    const retry = params.willRetry ? " (will retry)" : "";
    this.progress(`Error: ${params.error.message}${retry}`);
    this.log(`error: ${params.error.message}${retry}`);
  }

  getAccumulatedOutput(): string {
    return this.accumulatedOutput;
  }

  /** Output for `TurnResult.output`, with precedence:
   *  1. `reviewOutput` — set from an `exitedReviewMode` item; for review turns
   *     this is the structured deliverable and must NOT be shadowed by the
   *     short `final_answer` sign-off Codex emits at the end.
   *  2. `finalAnswerOutput` — agentMessage items with phase `"final_answer"`;
   *     for normal run turns this excludes intermediate planning/status noise.
   *  3. `accumulatedOutput` — fall back when neither of the above was seen. */
  getTurnOutput(): string {
    return this.reviewOutput || this.finalAnswerOutput || this.accumulatedOutput;
  }

  getFilesChanged(): FileChange[] {
    return [...this.filesChanged];
  }

  getCommandsRun(): CommandExec[] {
    return [...this.commandsRun];
  }

  reset(): void {
    this.accumulatedOutput = "";
    this.finalAnswerOutput = "";
    this.reviewOutput = "";
    this.filesChanged = [];
    this.commandsRun = [];
  }

  /** Write accumulated agent output to the log (called before final flush). */
  flushOutput(): void {
    if (this.accumulatedOutput) {
      this.log(`agent output:\n${this.accumulatedOutput}\n<<END_AGENT_OUTPUT>>`);
    }
  }

  flush(): void {
    if (this.logBuffer.length === 0) return;
    try {
      appendFileSync(this.logPath, this.logBuffer.join("\n") + "\n", { mode: 0o600 });
      this.logBuffer = [];
    } catch (e) {
      console.error(`[codex] Warning: Failed to write log to ${this.logPath}: ${e instanceof Error ? e.message : e}`);
      // Keep buffer — will retry on next flush
    }
  }

  private progress(text: string): void {
    this.onProgress(text);
    this.log(`[codex] ${text}`);
    this.flush();
  }

  private log(entry: string): void {
    const ts = new Date().toISOString();
    this.logBuffer.push(`${ts} ${entry}`);
    // Auto-flush every 20 entries
    if (this.logBuffer.length >= 20) this.flush();
  }
}
