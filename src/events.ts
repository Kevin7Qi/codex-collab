// src/events.ts — Event dispatcher for app server notifications

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type {
  ItemStartedParams, ItemCompletedParams, DeltaParams,
  ErrorNotificationParams,
  FileChange, CommandExec,
  CommandExecutionItem, FileChangeItem, ExitedReviewModeItem,
  AgentMessageItem,
  RunPhase,
} from "./types";

type ProgressCallback = (line: string) => void;

export class EventDispatcher {
  private accumulatedOutput = "";
  private finalAnswerOutput = "";
  private filesChanged: FileChange[] = [];
  private commandsRun: CommandExec[] = [];
  private logBuffer: string[] = [];
  private logPath: string;
  private onProgress: ProgressCallback;
  private lastPhase: Map<string, string> = new Map();
  /** Item IDs that the server marked as phase "final_answer". */
  private finalAnswerItemIds: Set<string> = new Set();
  /** The item ID currently receiving deltas. */
  private currentDeltaItemId: string | null = null;

  constructor(
    shortId: string,
    logsDir: string,
    onProgress?: ProgressCallback,
  ) {
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    this.logPath = join(logsDir, `${shortId}.log`);
    this.onProgress = onProgress ?? ((line) => process.stderr.write(line + "\n"));
  }

  handleItemStarted(params: ItemStartedParams): void {
    const { item } = params;

    if (item.type === "commandExecution") {
      this.progress(`Running: ${(item as CommandExecutionItem).command}`);
    }

    // Track which item is receiving deltas and separate consecutive messages
    if (item.type === "agentMessage") {
      this.currentDeltaItemId = item.id;
      if (this.accumulatedOutput.length > 0) {
        this.accumulatedOutput += "\n";
      }
      if (this.finalAnswerOutput.length > 0 && this.finalAnswerItemIds.has(item.id)) {
        this.finalAnswerOutput += "\n";
      }
    }
  }

  handleItemCompleted(params: ItemCompletedParams): void {
    const { item } = params;

    // Track agent message phases for output filtering
    if (item.type === "agentMessage") {
      const agentMsg = item as AgentMessageItem;
      if (agentMsg.phase === "final_answer") {
        // Final answer: capture its text into finalAnswerOutput
        this.finalAnswerItemIds.add(item.id);
        if (agentMsg.text) {
          this.finalAnswerOutput = agentMsg.text;
        }
      } else if (agentMsg.text) {
        // Intermediate agent message (planning/status): show as progress
        const preview = agentMsg.text.length > 120
          ? agentMsg.text.slice(0, 117) + "..."
          : agentMsg.text;
        this.progress(preview);
      }
    }

    // Type assertions needed: GenericItem's `type: string` prevents discriminated union narrowing
    switch (item.type) {
      case "commandExecution": {
        const cmd = item as CommandExecutionItem;
        if (cmd.status !== "completed") {
          this.progress(`Command ${cmd.status}: ${cmd.command}`);
          break;
        }
        this.commandsRun.push({
          command: cmd.command,
          exitCode: cmd.exitCode ?? null,
          durationMs: cmd.durationMs ?? null,
        });
        const exit = cmd.exitCode ?? "?";
        this.log(`command: ${cmd.command} (exit ${exit})`);
        break;
      }
      case "fileChange": {
        const fc = item as FileChangeItem;
        if (fc.status !== "completed") {
          const paths = fc.changes.map(c => c.path).join(", ");
          this.progress(`File change ${fc.status}: ${paths || "(no paths)"}`);
          break;
        }
        for (const change of fc.changes) {
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
        const review = item as ExitedReviewModeItem;
        this.accumulatedOutput = review.review;
        this.log(`review output (${review.review.length} chars)`);
        break;
      }
    }
  }

  handleDelta(method: string, params: DeltaParams): void {
    if (method === "item/agentMessage/delta") {
      this.accumulatedOutput += params.delta;
      // If this delta belongs to a final_answer item, also accumulate separately
      if (this.currentDeltaItemId && this.finalAnswerItemIds.has(this.currentDeltaItemId)) {
        this.finalAnswerOutput += params.delta;
      }
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

  /** Get only the final answer output (agentMessage items with phase "final_answer").
   *  Falls back to full accumulated output if no final_answer phase was seen. */
  getFinalAnswerOutput(): string {
    return this.finalAnswerOutput || this.accumulatedOutput;
  }

  getFilesChanged(): FileChange[] {
    return [...this.filesChanged];
  }

  getCommandsRun(): CommandExec[] {
    return [...this.commandsRun];
  }

  /** Emit progress with optional phase tracking for dedup. */
  emitProgress(line: string, opts?: { phase?: string; threadId?: string }): void {
    if (opts?.phase && opts?.threadId) {
      const prev = this.lastPhase.get(opts.threadId);
      if (prev === opts.phase) return; // dedup: same phase for same thread
      this.lastPhase.set(opts.threadId, opts.phase);
    }
    this.progress(line);
  }

  reset(): void {
    this.accumulatedOutput = "";
    this.finalAnswerOutput = "";
    this.filesChanged = [];
    this.commandsRun = [];
    this.lastPhase.clear();
    this.finalAnswerItemIds.clear();
    this.currentDeltaItemId = null;
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

// --- Phase inference from log lines ---

const PHASE_PATTERNS: Array<[RegExp, RunPhase]> = [
  [/\bStarting\b/i, "starting"],
  [/\bstarted\b/i, "starting"],
  [/\bReviewing\b/i, "reviewing"],
  [/\breview\b/i, "reviewing"],
  [/\bEdit(?:ing|ed)\b/i, "editing"],
  [/\bVerify(?:ing)?\b/i, "verifying"],
  [/\bcheck(?:ing)?\b/i, "verifying"],
  [/\bRunning\b/i, "running"],
  [/\bExecut(?:ing|e)\b/i, "running"],
  [/\bInvestigat(?:ing|e)\b/i, "investigating"],
  [/\bFinaliz(?:ing|e)\b/i, "finalizing"],
  [/\bcompleted?\b/i, "finalizing"],
];

/** Infer a RunPhase from a log line by regex matching. Returns null if no match. */
export function inferPhaseFromLog(line: string): RunPhase | null {
  for (const [pattern, phase] of PHASE_PATTERNS) {
    if (pattern.test(line)) return phase;
  }
  return null;
}
