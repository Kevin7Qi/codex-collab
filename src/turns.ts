// src/turns.ts — Turn lifecycle (runTurn, runReview)

import { existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import type { AppServerClient } from "./client";
import {
  isKnownItem,
  type UserInput, type TurnStartParams, type TurnStartResponse, type TurnCompletedParams,
  type ReviewTarget, type ReviewStartParams, type ReviewDelivery,
  type TurnResult, type ItemStartedParams, type ItemCompletedParams, type DeltaParams,
  type ErrorNotificationParams,
  type CommandApprovalRequest, type FileChangeApprovalRequest,
  type ApprovalPolicy, type ReasoningEffort,
  type ReasoningItem,
} from "./types";
import type { EventDispatcher } from "./events";
import type { ApprovalHandler } from "./approvals";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Check whether a notification belongs to the current turn.
 * Both threadId and turnId must match.
 */
export function belongsToTurn(
  params: { threadId: string; turnId: string },
  expectedThreadId: string,
  expectedTurnId: string,
): boolean {
  return params.threadId === expectedThreadId && params.turnId === expectedTurnId;
}

/**
 * Extract a single reasoning string from a completed reasoning item.
 * Joins summary and content arrays with newlines, deduplicates identical sections.
 */
export function extractReasoning(item: ReasoningItem): string | null {
  const parts: string[] = [];
  if (item.summary?.length) parts.push(...item.summary);
  if (item.content?.length) parts.push(...item.content);
  if (parts.length === 0) return null;
  // Deduplicate identical sections (preserve order)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return unique.join("\n");
}

/** Merge multiple reasoning strings, deduplicating identical sections. */
function mergeReasoningStrings(existing: string | null, addition: string): string {
  if (!existing) return addition;
  const allParts = [...existing.split("\n"), ...addition.split("\n")];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of allParts) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return unique.join("\n");
}

export interface TurnOptions {
  dispatcher: EventDispatcher;
  approvalHandler: ApprovalHandler;
  timeoutMs: number;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
  /** Directory for kill signal files. Defaults to config.killSignalsDir. */
  killSignalsDir?: string;
  /** Called with the turn ID once the turn/start (or review/start) response arrives.
   *  Used by the CLI signal handler to send turn/interrupt on Ctrl-C. */
  onTurnId?: (turnId: string) => void;
}

export interface ReviewOptions extends TurnOptions {
  delivery?: ReviewDelivery;
}

/**
 * Run a single turn: send input, wire up event/approval handlers,
 * wait for turn/completed, and return a structured TurnResult.
 */
export async function runTurn(
  client: AppServerClient,
  threadId: string,
  input: UserInput[],
  opts: TurnOptions,
): Promise<TurnResult> {
  const params: TurnStartParams = {
    threadId,
    input,
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    approvalPolicy: opts.approvalPolicy,
  };

  return executeTurn(client, "turn/start", params, opts);
}

/**
 * Run a review turn: same lifecycle as runTurn but sends review/start
 * instead of turn/start.
 */
export async function runReview(
  client: AppServerClient,
  threadId: string,
  target: ReviewTarget,
  opts: ReviewOptions,
): Promise<TurnResult> {
  const params: ReviewStartParams = {
    threadId,
    target,
    delivery: opts.delivery,
  };

  return executeTurn(client, "review/start", params, opts);
}

/** Error thrown when a kill signal file is detected during turn execution. */
class KillSignalError extends Error {
  constructor(public readonly threadId: string) {
    super(`Thread ${threadId} killed by user`);
    this.name = "KillSignalError";
  }
}

/**
 * Shared turn lifecycle: register handlers, send the start request,
 * wait for completion, collect results, and clean up.
 *
 * Notification buffering: notifications may arrive before turn/start returns
 * the turnId. We buffer them and replay once the turnId is known.
 *
 * Completion inference: if turn/completed is lost, we infer completion 250ms
 * after the last agentMessage item completes (debounced).
 */
async function executeTurn(
  client: AppServerClient,
  method: string,
  params: TurnStartParams | ReviewStartParams,
  opts: TurnOptions,
): Promise<TurnResult> {
  const startTime = Date.now();
  opts.dispatcher.reset();

  const signalsDir = opts.killSignalsDir ?? config.killSignalsDir;
  const threadId = params.threadId;
  const signalPath = join(signalsDir, threadId);

  // --- Notification buffering ---
  // Before turnId is known, queue notifications. Once turn/start responds
  // with the turnId, replay buffered notifications through handlers.
  type BufferedNotification = { method: string; params: unknown };
  const notificationBuffer: BufferedNotification[] = [];
  let turnId: string | null = null;

  // --- Turn-level structured capture ---
  let turnReasoning: string | null = null;

  // --- Completion inference ---
  let inferenceTimer: ReturnType<typeof setTimeout> | undefined;
  let inferenceResolver: (() => void) | null = null;

  function clearInferenceTimer(): void {
    if (inferenceTimer !== undefined) {
      clearTimeout(inferenceTimer);
      inferenceTimer = undefined;
    }
  }

  function resetInferenceTimer(): void {
    clearInferenceTimer();
    if (inferenceResolver) {
      inferenceTimer = setTimeout(() => {
        if (inferenceResolver) inferenceResolver();
      }, 250);
    }
  }

  // Process an item/completed notification for reasoning extraction & completion inference
  function processItemCompleted(itemParams: ItemCompletedParams): void {
    const { item } = itemParams;
    if (!isKnownItem(item)) return;

    // Reasoning extraction
    if (item.type === "reasoning") {
      const extracted = extractReasoning(item);
      if (extracted) {
        turnReasoning = mergeReasoningStrings(turnReasoning, extracted);
      }
    }
    // Completion inference: agentMessage with phase "final_answer" (normal turns)
    // or exitedReviewMode (reviews) starts the debounce timer. Other item types
    // clear the timer to prevent premature inference while the agent is still working.
    if (inferenceResolver) {
      if (
        (item.type === "agentMessage" && item.phase === "final_answer") ||
        item.type === "exitedReviewMode"
      ) {
        resetInferenceTimer();
      } else {
        clearInferenceTimer();
      }
    }
  }

  // AbortController for cancelling in-flight approval polls on turn completion/timeout
  const abortController = new AbortController();
  const unsubs = registerEventHandlers(client, opts, abortController.signal);

  // Wire up item/started interception for completion inference — if new work
  // starts after a final_answer, cancel the inference timer to avoid premature
  // completion synthesis.
  unsubs.push(
    client.on("item/started", (params) => {
      const p = params as ItemStartedParams;
      if (turnId !== null && belongsToTurn(p, threadId, turnId) && inferenceResolver) {
        clearInferenceTimer();
      }
    }),
  );

  // Wire up item/completed interception for reasoning & structured capture.
  // This runs alongside the dispatcher's handler (registered in registerEventHandlers).
  unsubs.push(
    client.on("item/completed", (params) => {
      const p = params as ItemCompletedParams;
      if (turnId !== null) {
        if (belongsToTurn(p, threadId, turnId)) {
          processItemCompleted(p);
        }
      } else {
        // Buffer — will be replayed once turnId is known
        notificationBuffer.push({ method: "item/completed", params });
      }
    }),
  );

  // Subscribe to turn/completed BEFORE sending the request to prevent
  // a race where fast turns complete before we call waitFor(). In the
  // read loop (client.ts), a single read() chunk may contain both
  // the response and turn/completed. The while-loop dispatches them
  // synchronously, so the notification handler fires during dispatch —
  // before the response promise resolves (promise continuations are
  // microtasks). This means waitFor() would be called too late.
  const completion = createTurnCompletionAwaiter(client, opts.timeoutMs);
  unsubs.push(completion.unsubscribe);

  // AbortController specifically for kill signal polling — aborted when
  // the turn completes normally or on timeout so the poll interval stops.
  const killAbort = new AbortController();

  // Remove signal files left over from a previous (crashed) run, but preserve
  // fresh signals written by a concurrent `kill` targeting this thread.
  // Heuristic: files created before this process started are stale.
  const processStartMs = Date.now() - process.uptime() * 1000;
  try {
    const st = statSync(signalPath);
    if (st.mtimeMs < processStartMs) unlinkSync(signalPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[codex] Warning: could not check/remove stale kill signal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Start kill signal polling before the request so kills are detected even
  // if turn/start is slow or stuck.
  const killSignal = createKillSignalAwaiter(
    threadId, signalsDir, 500, killAbort.signal,
  );
  killSignal.catch((e) => {
    if (!(e instanceof KillSignalError)) {
      console.error(`[codex] Unexpected error in kill signal awaiter: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  try {
    const { turn } = await Promise.race([
      client.request<TurnStartResponse>(method, params),
      killSignal,
    ]);

    // turnId is now known — notify caller and replay buffered notifications
    turnId = turn.id;
    opts.onTurnId?.(turnId);

    // Set up completion inference BEFORE replaying buffered items — if a fast
    // turn delivered its final_answer item/completed before turn/start resolved,
    // the replay below needs inferenceResolver to be armed so the debounce
    // timer starts. Otherwise the turn waits for the full timeout.
    const inferencePromise = new Promise<void>((resolve) => {
      inferenceResolver = resolve;
    });

    for (const buffered of notificationBuffer) {
      if (buffered.method === "item/completed") {
        const p = buffered.params as ItemCompletedParams;
        if (belongsToTurn(p, threadId, turnId)) {
          processItemCompleted(p);
        }
      }
    }
    notificationBuffer.length = 0;

    const completedTurn = await Promise.race([
      completion.waitFor(turn.id).then((p) => {
        // Normal path: turn/completed arrived — cancel inference timer
        clearInferenceTimer();
        inferenceResolver = null;
        return p;
      }),
      inferencePromise.then(() => {
        // Inference path: turn/completed was lost — synthesize result
        return {
          threadId,
          turn: { id: turn.id, items: [], status: "completed" as const, error: null },
        } as TurnCompletedParams;
      }),
      killSignal,
    ]);

    opts.dispatcher.flushOutput();
    opts.dispatcher.flush();

    // Output comes from accumulated item/agentMessage/delta notifications
    // (for normal turns) or from exitedReviewMode item/completed notification
    // (for reviews). Note: turn/completed Turn.items is always [] per protocol
    // spec — items are only populated on thread/resume or thread/fork.
    // Use final answer output (excludes intermediate planning/status messages).
    // Falls back to full accumulated output if no final_answer phase was seen.
    const output = opts.dispatcher.getFinalAnswerOutput();

    return {
      status: completedTurn.turn.status as TurnResult["status"],
      output,
      reasoning: turnReasoning,
      filesChanged: opts.dispatcher.getFilesChanged(),
      commandsRun: opts.dispatcher.getCommandsRun(),
      error: completedTurn.turn.error?.message,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    if (e instanceof KillSignalError) {
      opts.dispatcher.flushOutput();
      opts.dispatcher.flush();
      return {
        status: "interrupted",
        output: opts.dispatcher.getFinalAnswerOutput(),
        reasoning: turnReasoning,
        filesChanged: opts.dispatcher.getFilesChanged(),
        commandsRun: opts.dispatcher.getCommandsRun(),
        error: "Thread killed by user",
        durationMs: Date.now() - startTime,
      };
    }
    throw e;
  } finally {
    clearInferenceTimer();
    inferenceResolver = null;
    killAbort.abort();
    abortController.abort();
    for (const unsub of unsubs) unsub();
    // Clean up signal file
    try { unlinkSync(signalPath); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not clean up kill signal: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/**
 * Register notification and approval request handlers on the client.
 * Returns an array of unsubscribe functions for cleanup.
 */
function registerEventHandlers(client: AppServerClient, opts: TurnOptions, signal: AbortSignal): Array<() => void> {
  const { dispatcher, approvalHandler } = opts;
  const unsubs: Array<() => void> = [];

  // Notification handlers
  unsubs.push(
    client.on("item/started", (params) => {
      dispatcher.handleItemStarted(params as ItemStartedParams);
    }),
  );

  unsubs.push(
    client.on("item/completed", (params) => {
      dispatcher.handleItemCompleted(params as ItemCompletedParams);
    }),
  );

  // Delta notifications
  for (const method of [
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
  ]) {
    unsubs.push(
      client.on(method, (params) => {
        dispatcher.handleDelta(method, params as DeltaParams);
      }),
    );
  }

  // Mid-turn error notifications (e.g. retryable API errors)
  unsubs.push(
    client.on("error", (params) => {
      dispatcher.handleError(params as ErrorNotificationParams);
    }),
  );

  // Approval requests (server -> client requests expecting a response).
  // The AppServerClient.onRequest handler returns the result directly;
  // the client takes care of sending the JSON-RPC response.
  unsubs.push(
    client.onRequest(
      "item/commandExecution/requestApproval",
      async (params) => {
        const decision = await approvalHandler.handleCommandApproval(
          params as CommandApprovalRequest,
          signal,
        );
        return { decision };
      },
    ),
  );

  unsubs.push(
    client.onRequest(
      "item/fileChange/requestApproval",
      async (params) => {
        const decision = await approvalHandler.handleFileChangeApproval(
          params as FileChangeApprovalRequest,
          signal,
        );
        return { decision };
      },
    ),
  );

  return unsubs;
}

/**
 * Create a promise that rejects with KillSignalError when a kill signal file
 * appears for the given thread. Polls the filesystem at the given interval.
 * Stops polling when the provided AbortSignal fires (i.e. when the turn finishes for any reason).
 */
function createKillSignalAwaiter(
  threadId: string,
  signalsDir: string,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    // Check immediately
    if (existsSync(join(signalsDir, threadId))) {
      reject(new KillSignalError(threadId));
      return;
    }

    const timer = setInterval(() => {
      try {
        if (signal.aborted) {
          clearInterval(timer);
          return;
        }
        if (existsSync(join(signalsDir, threadId))) {
          clearInterval(timer);
          reject(new KillSignalError(threadId));
        }
      } catch (e) {
        // Log but keep polling — the error may be transient (e.g. momentary EACCES).
        console.error(`[codex] Warning: kill signal poll error (will retry): ${e instanceof Error ? e.message : String(e)}`);
      }
    }, pollIntervalMs);

    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  });
}

/**
 * Create a turn/completed awaiter that buffers events from the moment it's
 * created. Call waitFor(turnId) after the request to resolve with the matching
 * completion — even if it arrived before waitFor was called.
 *
 * This eliminates the race between client.request() resolving and registering
 * the turn/completed handler. If turn/completed does not arrive within
 * timeoutMs, the returned promise rejects with a timeout error.
 */
function createTurnCompletionAwaiter(
  client: AppServerClient,
  timeoutMs: number,
): {
  waitFor: (turnId: string) => Promise<TurnCompletedParams>;
  unsubscribe: () => void;
} {
  const buffer: TurnCompletedParams[] = [];
  let resolver: ((p: TurnCompletedParams) => void) | null = null;
  let targetId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsub = client.on("turn/completed", (params) => {
    const p = params as TurnCompletedParams;
    if (targetId !== null && p.turn.id === targetId && resolver) {
      clearTimeout(timer);
      resolver(p);
      resolver = null;
    } else {
      buffer.push(p);
    }
  });

  return {
    waitFor(turnId: string): Promise<TurnCompletedParams> {
      const found = buffer.find((p) => p.turn.id === turnId);
      if (found) return Promise.resolve(found);

      return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          resolver = null;
          targetId = null;
          unsub();
          reject(new Error(`Turn timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        // Set resolver before targetId so the notification handler never
        // sees targetId set without a resolver to call.
        resolver = (p) => {
          clearTimeout(timer);
          resolve(p);
        };
        targetId = turnId;
      });
    },
    unsubscribe() {
      unsub();
      clearTimeout(timer);
    },
  };
}
