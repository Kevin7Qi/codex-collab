// src/turns.ts — Turn lifecycle (runTurn, runReview)

import { existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import type { AppServerClient } from "./client";
import {
  isKnownItem,
  TurnTimeoutError,
  type UserInput, type TurnStartParams, type TurnStartResponse, type TurnCompletedParams,
  type TurnStartedParams, type ThreadGoal, type ThreadGoalUpdatedParams, type ThreadGoalClearedParams,
  type ReviewTarget, type ReviewStartParams, type ReviewDelivery,
  type TurnResult, type ItemStartedParams, type ItemCompletedParams, type DeltaParams,
  type ErrorNotificationParams, type AutoApprovalReviewParams,
  type CommandApprovalRequest, type FileChangeApprovalRequest,
  type ApprovalPolicy, type ApprovalsReviewer, type ReasoningEffort,
} from "./types";
import type { EventDispatcher } from "./events";
import type { ApprovalHandler } from "./approvals";
import { config } from "./config";
import { pauseThreadGoal, readThreadGoal } from "./goals";

const STALE_KILL_SIGNAL_MS = 1000;

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
 * Best-effort `turn/interrupt`. Swallows "not found" / "already" errors —
 * those indicate the turn already finished (or another caller interrupted
 * it first), which is the desired post-state. Logs every other failure.
 */
export async function tryInterruptTurn(
  client: AppServerClient,
  threadId: string,
  turnId: string,
  context?: string,
): Promise<void> {
  try {
    await client.request("turn/interrupt", { threadId, turnId });
  } catch (e) {
    if (e instanceof Error
        && !e.message.includes("not found")
        && !e.message.includes("already")) {
      const prefix = context ? `could not interrupt turn ${context}` : "could not interrupt turn";
      console.error(`[codex] Warning: ${prefix}: ${e.message}`);
    }
  }
}

export interface TurnOptions {
  dispatcher: EventDispatcher;
  approvalHandler: ApprovalHandler;
  timeoutMs: number;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
  /** Per-turn approval reviewer override ("auto_review" = Guardian). Like
   *  sandboxPolicy below, per-turn is the reliable application path when the
   *  thread is already loaded in the long-lived (broker) app-server. */
  approvalsReviewer?: ApprovalsReviewer;
  /** Per-turn sandbox override (wire shape, e.g. {type:"workspaceWrite"}).
   *  Re-applies the sandbox on resume, where thread/resume's `sandbox` is
   *  ignored for a thread already loaded in the long-lived app-server. */
  sandboxPolicy?: unknown;
  /** Directory for kill signal files. Defaults to config.killSignalsDir. */
  killSignalsDir?: string;
  /** Called with the turn ID once the turn/start (or review/start) response arrives.
   *  Used by the CLI signal handler to send turn/interrupt on Ctrl-C. */
  onTurnId?: (turnId: string) => void;
  /** Called with the review subthread ID once review/start responds. Lets the
   *  CLI signal handler target the right thread for `turn/interrupt`. Never
   *  fires for normal turns. */
  onReviewThreadId?: (reviewThreadId: string) => void;
  /** Called BEFORE the cleanup turn/interrupt on abnormal exits (timeout,
   *  kill, errors). Goal-following installs its pause brake here: with an
   *  active goal, interrupting first lets the server spawn one more
   *  headless continuation in the gap before the wrapper's own pause runs.
   *  Failures are swallowed — the interrupt must still happen. */
  onBeforeInterrupt?: () => Promise<void>;
}

/** Run the pre-interrupt hook, never letting its failure block the interrupt. */
async function runBeforeInterruptHook(opts: TurnOptions): Promise<void> {
  try {
    await opts.onBeforeInterrupt?.();
  } catch (e) {
    console.error(`[codex] Warning: pre-interrupt hook failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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
    approvalsReviewer: opts.approvalsReviewer,
    sandboxPolicy: opts.sandboxPolicy,
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

export interface GoalRunOptions extends TurnOptions {
  /** Fired on every goal mutation seen during the run (create_goal /
   *  update_goal / server budget stamps) and once per followed continuation
   *  turn — callers mirror this onto the run record for observers. */
  onGoalUpdate?: (goal: ThreadGoal, continuationTurns: number) => void;
}

export interface GoalRunResult extends TurnResult {
  /** Final goal state: null when no goal ever appeared OR the goal was
   *  cleared after being seen (disambiguate with goalSeen). Completion
   *  normally arrives as status "complete" with the goal still present. */
  goal: ThreadGoal | null;
  /** A goal existed at some point during this run. */
  goalSeen: boolean;
  /** Server-driven continuation turns this run followed (0 = single turn). */
  continuationTurns: number;
}

/** How long past turn/completed we keep waiting for the server to start the
 *  continuation turn before re-polling goal state. Continuations start
 *  within milliseconds (verified 0.142.3); the re-poll loop is the backstop
 *  for pause/clear landing from elsewhere while we wait. */
const GOAL_CONTINUATION_POLL_MS = 500;
/** Re-read thread/goal/get at this cadence while waiting for a continuation
 *  turn, in case a goal/updated notification was lost. */
const GOAL_REPOLL_INTERVAL_MS = 5_000;

/**
 * Run a turn, then — if the thread has an active goal — keep following the
 * server's continuation turns in the same dispatcher/log until the goal is
 * terminal. This makes a `run` correspond to the unit of work: Codex's goal
 * runtime auto-starts a new turn the instant one completes while the goal
 * is active, so returning after the first turn would leave the goal working
 * headless and unobserved (issue #19).
 *
 * `opts.timeoutMs` is GOAL-SCOPED here: one deadline for the whole span. On
 * expiry the goal is paused BEFORE the active turn is interrupted (interrupt
 * alone just makes the server start a fresh continuation), then a
 * TurnTimeoutError propagates as usual. A kill signal mid-goal takes the
 * same pause-then-interrupt path and returns status "interrupted".
 */
export async function runTurnWithGoalFollow(
  client: AppServerClient,
  threadId: string,
  input: UserInput[],
  opts: GoalRunOptions,
): Promise<GoalRunResult> {
  const deadlineMs = Date.now() + opts.timeoutMs;
  const startTime = Date.now();

  // Goal tracking spans the whole run: a goal created mid-turn-1 (create_goal
  // tool call) is seen live, and its updates mirror onto the run record.
  let lastGoal: ThreadGoal | null = null;
  let goalSeen = false;
  let goalCleared = false;
  let continuationTurns = 0;
  const unsubs: Array<() => void> = [];
  const notifyGoal = (goal: ThreadGoal): void => {
    lastGoal = goal;
    goalSeen = true;
    goalCleared = false;
    try {
      opts.onGoalUpdate?.(goal, continuationTurns);
    } catch (e) {
      console.error(`[codex] Warning: goal-update observer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  unsubs.push(client.on("thread/goal/updated", (params) => {
    const p = params as ThreadGoalUpdatedParams;
    if (p?.threadId !== threadId || !p.goal) return;
    notifyGoal(p.goal);
  }));
  unsubs.push(client.on("thread/goal/cleared", (params) => {
    if ((params as ThreadGoalClearedParams)?.threadId !== threadId) return;
    lastGoal = null;
    goalCleared = true;
  }));

  // Continuation turns are buffered from the START of the run: the server
  // begins a continuation within milliseconds of turn/completed, easily
  // beating the goal/get round-trip that decides whether to follow. Our own
  // turn is filtered out via onTurnId. Item ROUTING is gated on the follow
  // phase — during the first turn executeTurn owns routing, and dispatching
  // here too would duplicate output and progress lines.
  const ownTurnIds = new Set<string>();
  const followedTurnIds = new Set<string>();
  const startedTurnIds: string[] = [];
  let following = false;
  const wrappedOpts: GoalRunOptions = {
    ...opts,
    onTurnId: (id) => {
      // turn/started for our own turn can beat the turn/start response —
      // un-queue it, or the follow loop would try to follow our own turn.
      ownTurnIds.add(id);
      followedTurnIds.delete(id);
      const queued = startedTurnIds.indexOf(id);
      if (queued !== -1) startedTurnIds.splice(queued, 1);
      opts.onTurnId?.(id);
    },
    // executeTurn's abnormal-exit cleanup interrupts the FIRST turn before
    // our catch handlers run — with an active goal, that interrupt spawns
    // one more headless continuation in the gap. The hook pauses first,
    // preserving pause-before-interrupt on the first turn too. (defined
    // below; only invoked during runTurn's cleanup, long after init)
    onBeforeInterrupt: () => pauseIfActive("before interrupt"),
  };
  unsubs.push(client.on("turn/started", (params) => {
    const p = params as TurnStartedParams;
    if (p?.threadId !== threadId || !p.turn?.id || ownTurnIds.has(p.turn.id)) return;
    followedTurnIds.add(p.turn.id);
    startedTurnIds.push(p.turn.id);
  }));
  unsubs.push(...DISPATCHED_NOTIFICATION_METHODS.map((method) =>
    client.on(method, (params) => {
      if (!following) return;
      const routing = params as { threadId?: unknown; turnId?: unknown };
      if (routing?.threadId !== threadId) return;
      if (typeof routing?.turnId === "string" && !followedTurnIds.has(routing.turnId)) return;
      dispatchNotification(opts.dispatcher, method, params);
    }),
  ));
  // Buffers turn/completed from the start too — a fast continuation can
  // complete before the follow loop reaches waitFor.
  const completion = createTurnCompletionAwaiter(client, opts.timeoutMs);
  unsubs.push(completion.unsubscribe);

  // Connection loss must never read as "goal completed": a dead connection
  // makes getThreadGoal return null, which the follow loop would otherwise
  // take for a cleared (= completed) goal.
  let connectionDown: Error | null = null;

  /** Authoritative goal state; refreshes lastGoal/goalSeen. A FAILED read
   *  returns the last known state instead of null — one transient RPC error
   *  must not read as "goal cleared" (= completed) and end the follow with
   *  a false success while the server keeps working. The repoll cadence
   *  retries; the deadline is the backstop if reads never recover. */
  const readGoal = async (): Promise<ThreadGoal | null> => {
    const { goal, ok } = await readThreadGoal(client, threadId);
    if (!ok) return lastGoal;
    if (goal) notifyGoal(goal);
    else if (goalSeen && connectionDown === null) {
      lastGoal = null;
      goalCleared = true;
    }
    return goal;
  };

  /** Pause the goal iff it is (or may be) active. Fresh read first:
   *  `kill --clear` may have already cleared (or paused) the goal, and
   *  pausing a goal that no longer exists is noise, not a brake. Skip ONLY
   *  on a positive answer — a failed read must not skip the pause (fail
   *  closed: this is the lever that stops headless token burn). */
  const pauseIfActive = async (context: string): Promise<void> => {
    const { goal: current, ok } = await readThreadGoal(client, threadId);
    if (ok && (current === null || current.status !== "active")) return;
    const paused = await pauseThreadGoal(client, threadId);
    if (!paused) {
      opts.dispatcher.progressLine(
        `WARNING: could not pause the goal ${context} — it may keep running headless. ` +
        `Stop it with: codex-collab kill <id> (or --clear to abandon it).`,
      );
    } else {
      opts.dispatcher.progressLine(`Goal paused ${context} — resume by running a new turn on this thread.`);
      // Stamp the pause locally: the server's goal/updated notification races
      // our exit, and losing that race would leave the terminal run record
      // claiming an "active" goal that is in fact paused.
      const stamped = current ?? (lastGoal as ThreadGoal | null);
      if (stamped) notifyGoal({ ...stamped, status: "paused" });
    }
  };

  /** The brake for every abnormal exit while a goal is active: pause FIRST
   *  (so no fresh continuation spawns), then interrupt the live turn. */
  const pauseAndInterrupt = async (activeTurnId: string | null, context: string): Promise<void> => {
    await pauseIfActive(context);
    if (activeTurnId !== null) {
      await tryInterruptTurn(client, threadId, activeTurnId, context);
    }
  };

  const finish = (result: TurnResult): GoalRunResult => ({
    ...result,
    durationMs: Date.now() - startTime,
    goal: lastGoal,
    goalSeen,
    continuationTurns,
  });

  /** Follow-phase kill: brake, flush, clean up the signal file (executeTurn's
   *  finally only covers the first turn), and shape the interrupted result. */
  const finishKilled = async (activeTurnId: string | null): Promise<GoalRunResult> => {
    await pauseAndInterrupt(activeTurnId, "on kill");
    opts.dispatcher.flushOutput();
    opts.dispatcher.flush();
    removeOwnKillSignal(opts.killSignalsDir ?? config.killSignalsDir, threadId);
    return finish({
      status: "interrupted",
      output: opts.dispatcher.getTurnOutput(),
      filesChanged: opts.dispatcher.getFilesChanged(),
      commandsRun: opts.dispatcher.getCommandsRun(),
      error: "Thread killed by user",
      durationMs: 0,
    });
  };

  try {
    // Read the goal BEFORE the turn: a goal that predates this run (resumed
    // goal-mode thread) fires no goal/updated during our turn, and every
    // abnormal-exit brake below keys off knowing it exists. The get also
    // travels through the broker, which learns the active goal from it and
    // retains stream ownership across the coming continuation turns.
    await readGoal();

    let first: TurnResult;
    try {
      first = await runTurn(client, threadId, input, wrappedOpts);
    } catch (e) {
      // A first-turn timeout with an active goal must not leave the goal
      // burning headless after the CLI exits with code 3. pauseAndInterrupt
      // does its own authoritative read — cached flags would miss a goal
      // that appeared mid-turn without any notification reaching us.
      if (e instanceof TurnTimeoutError) {
        await pauseAndInterrupt(null, "on timeout");
      }
      throw e;
    }

    if (first.status === "interrupted") {
      // Killed during turn 1. The goal-aware `kill` pauses the goal itself,
      // but older kills, SIGINT paths, and server-side interrupts don't —
      // never exit "interrupted" while the server keeps continuing.
      await pauseAndInterrupt(null, "on kill");
      return finish(first);
    }

    // Goal check is authoritative (not just notifications): a goal created
    // before this run — e.g. resuming a goal-mode thread — never fires
    // goal/updated during our turn.
    let goal = await readGoal();
    if (!goal || goal.status !== "active") return finish(first);

    opts.dispatcher.progressLine(
      `Goal active — following continuation turns (${goalProgress(goal)}). Objective: ${clipLine(goal.objective)}`,
    );

    // --- Follow phase ---------------------------------------------------
    // The server owns turn creation now; we attach to each continuation
    // turn as it starts and stream it into the same dispatcher/log.
    const followAbort = new AbortController();
    const followUnsubs: Array<() => void> = [];
    try {
      following = true;
      followUnsubs.push(...registerApprovalHandlers(client, opts, followAbort.signal));

      let connectionLost: ((err: Error) => void) | null = null;
      const connectionLossPromise = new Promise<never>((_resolve, reject) => {
        connectionLost = reject;
      });
      connectionLossPromise.catch(() => {});
      followUnsubs.push(client.onClose(() => {
        connectionDown = new Error("Connection to Codex lost mid-goal (app-server or broker exited)");
        connectionLost?.(connectionDown);
      }));

      const killSignal = createKillSignalAwaiter(
        threadId, opts.killSignalsDir ?? config.killSignalsDir, 500, followAbort.signal,
      );
      let killed = false;
      killSignal.catch((e) => {
        if (e instanceof KillSignalError) killed = true;
        else console.error(`[codex] Unexpected error in kill signal awaiter: ${e instanceof Error ? e.message : String(e)}`);
      });

      let lastTurnStatus: TurnResult["status"] = first.status;
      let lastTurnError: string | undefined = first.error;
      for (;;) {
        if (connectionDown !== null) throw connectionDown;
        if (goal === null || goal.status !== "active") break;

        // Wait for the continuation turn to start; re-check the world as we
        // wait (kill, deadline, goal changed under us, lost notifications).
        let turnId: string | null = null;
        let lastRepoll = Date.now();
        while (turnId === null) {
          const next = startedTurnIds.shift();
          if (next !== undefined) { turnId = next; break; }
          if (killed) break;
          if (connectionDown !== null) throw connectionDown;
          if (Date.now() >= deadlineMs) {
            await pauseAndInterrupt(null, "on timeout");
            throw new TurnTimeoutError(
              `Goal did not complete within ${Math.round(opts.timeoutMs / 1000)}s — goal paused (resume with a new turn, or kill --clear to abandon)`,
            );
          }
          if (goalCleared || (lastGoal !== null && (lastGoal as ThreadGoal).status !== "active")) break;
          if (Date.now() - lastRepoll >= GOAL_REPOLL_INTERVAL_MS) {
            lastRepoll = Date.now();
            await readGoal();
          }
          await new Promise((r) => setTimeout(r, GOAL_CONTINUATION_POLL_MS));
        }
        if (killed) return await finishKilled(turnId);
        if (turnId === null) { goal = await readGoal(); continue; }

        continuationTurns++;
        opts.onTurnId?.(turnId);
        if (lastGoal) notifyGoal(lastGoal as ThreadGoal); // refresh continuationTurns on the record
        opts.dispatcher.progressLine(`Goal continuation turn ${continuationTurns} started${lastGoal ? ` (${goalProgress(lastGoal as ThreadGoal)})` : ""}`);

        try {
          const completed = await Promise.race([
            completion.waitFor(turnId, Math.max(1, deadlineMs - Date.now())),
            killSignal,
            connectionLossPromise,
          ]);
          lastTurnStatus = completed.turn.status as TurnResult["status"];
          lastTurnError = completed.turn.error?.message;
        } catch (e) {
          if (e instanceof KillSignalError) {
            return await finishKilled(turnId);
          }
          if (e instanceof TurnTimeoutError) {
            await pauseAndInterrupt(turnId, "on timeout");
            throw new TurnTimeoutError(
              `Goal did not complete within ${Math.round(opts.timeoutMs / 1000)}s — goal paused (resume with a new turn, or kill --clear to abandon)`,
            );
          }
          // Connection loss and everything else: the goal may genuinely keep
          // running server-side (that can be desirable — broker path), but we
          // can no longer observe or brake it. Surface loudly and rethrow.
          throw e;
        }

        opts.dispatcher.flushOutput();
        opts.dispatcher.flush();
        goal = await readGoal();
      }

      // Goal reached a non-active state. Success is status "complete"
      // (observed live) — a cleared goal after being seen reads the same.
      const endGoal = lastGoal as ThreadGoal | null;
      if (endGoal === null || endGoal.status === "complete") {
        opts.dispatcher.progressLine(
          `Goal complete after ${continuationTurns + 1} turns${endGoal ? ` (${goalProgress(endGoal)})` : ""}.`,
        );
      } else {
        opts.dispatcher.progressLine(`Goal ${endGoal.status} after ${continuationTurns + 1} turns (${goalProgress(endGoal)}).`);
      }
      return finish({
        status: lastTurnStatus,
        output: opts.dispatcher.getTurnOutput(),
        filesChanged: opts.dispatcher.getFilesChanged(),
        commandsRun: opts.dispatcher.getCommandsRun(),
        error: lastTurnError,
        durationMs: 0,
      });
    } finally {
      followAbort.abort();
      for (const unsub of followUnsubs) unsub();
    }
  } finally {
    for (const unsub of unsubs) unsub();
  }
}

/** "12,345 tokens used" / "12,345 / 100,000 tokens" for progress lines. */
function goalProgress(goal: ThreadGoal): string {
  const used = goal.tokensUsed.toLocaleString("en-US");
  return goal.tokenBudget !== null
    ? `${used} / ${goal.tokenBudget.toLocaleString("en-US")} tokens`
    : `${used} tokens used`;
}

/** First ~80 chars of a goal objective for a progress line. */
function clipLine(text: string): string {
  const firstLine = text.split("\n", 1)[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine;
}

/** Error thrown when a kill signal file is detected during turn execution. */
class KillSignalError extends Error {
  constructor(public readonly threadId: string) {
    super(`Thread ${threadId} killed by user`);
    this.name = "KillSignalError";
  }
}

/** Remove a kill-signal file iff it targets this process (empty, wildcard,
 *  or our PID) — a different LIVE pid's signal belongs to a concurrent run
 *  on the thread, and deleting it would make that kill silently never land. */
function removeOwnKillSignal(signalsDir: string, threadId: string): void {
  const signalPath = join(signalsDir, threadId);
  try {
    const content = readFileSync(signalPath, "utf-8").trim();
    if (content === "" || content === "*" || content === String(process.pid)) {
      unlinkSync(signalPath);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[codex] Warning: could not clean up kill signal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Notification methods routed into the EventDispatcher — shared by the
 *  single-turn path (executeTurn) and the goal-following path. */
const DISPATCHED_NOTIFICATION_METHODS = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "guardianWarning",
  "error",
] as const;

/** Route one already-filtered notification into the dispatcher. Callers own
 *  the turn/thread filtering — this is just the method→handler fan-out. */
function dispatchNotification(dispatcher: EventDispatcher, method: string, params: unknown): void {
  switch (method) {
    case "item/started":
      dispatcher.handleItemStarted(params as ItemStartedParams);
      break;
    case "item/completed":
      dispatcher.handleItemCompleted(params as ItemCompletedParams);
      break;
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
      dispatcher.handleDelta(method, params as DeltaParams);
      break;
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
      dispatcher.handleAutoApprovalReview(method, params as AutoApprovalReviewParams);
      break;
    case "guardianWarning":
      dispatcher.handleGuardianWarning(params as { message?: unknown });
      break;
    case "error":
      dispatcher.handleError(params as ErrorNotificationParams);
      break;
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

  // Process an item/completed notification for completion inference
  function processItemCompleted(itemParams: ItemCompletedParams): void {
    const { item } = itemParams;
    if (!isKnownItem(item)) return;

    // Completion inference: agentMessage with phase "final_answer" (normal turns)
    // or exitedReviewMode (reviews) starts the debounce timer. Work-in-progress
    // items (command execution, file changes, non-final agent messages) clear
    // the timer to prevent premature inference. Reasoning items are ignored —
    // the model can finish reasoning *after* emitting its final answer, and
    // clearing the timer there would force the turn to wait the full timeout.
    if (inferenceResolver) {
      if (
        (item.type === "agentMessage" && item.phase === "final_answer") ||
        item.type === "exitedReviewMode"
      ) {
        resetInferenceTimer();
      } else if (item.type !== "reasoning") {
        clearInferenceTimer();
      }
    }
  }

  // AbortController for cancelling in-flight approval polls on turn completion/timeout
  const abortController = new AbortController();
  const unsubs = registerApprovalHandlers(client, opts, abortController.signal);

  // For reviews the running turn fires its item events on the review
  // subthread (set below after the start response returns). Predicate is
  // captured as a closure so it picks up reviewSubthreadId once it's known.
  let reviewSubthreadId: string | null = null;
  const belongsToActiveTurn = (
    p: { threadId: string; turnId: string },
    expectedTurnId: string,
  ): boolean =>
    belongsToTurn(p, threadId, expectedTurnId)
    || (reviewSubthreadId !== null && belongsToTurn(p, reviewSubthreadId, expectedTurnId));

  // Route a notification to the dispatcher and the completion-inference
  // logic, dropping events that belong to a different turn. On a shared
  // (broker) app-server, an orphaned turn from a previous client can still
  // be emitting items — without this filter its output would contaminate
  // this run's captured output, log, and persisted RunRecord. Events that
  // don't carry routing info are processed (fail-open) so protocol additions
  // aren't silently dropped.
  function routeNotification(method: string, params: unknown): void {
    const routing = params as { threadId?: unknown; turnId?: unknown };
    if (turnId !== null && typeof routing?.threadId === "string") {
      if (typeof routing?.turnId === "string") {
        if (!belongsToActiveTurn({ threadId: routing.threadId, turnId: routing.turnId }, turnId)) {
          return;
        }
      } else if (routing.threadId !== threadId && routing.threadId !== reviewSubthreadId) {
        // Thread-scoped notifications without a turnId (e.g. guardianWarning)
        // still must not leak across threads on a shared broker.
        return;
      }
    }
    dispatchNotification(opts.dispatcher, method, params);
    if (method === "item/started") {
      // Completion inference: if new non-reasoning work starts after a
      // final_answer, cancel the inference timer to avoid premature
      // completion synthesis. Reasoning items are excluded: the model can
      // begin a reasoning trace concurrent with or after the final answer
      // without that implying further work.
      if (inferenceResolver) {
        const item = (params as ItemStartedParams).item as { type?: string } | undefined;
        if (item?.type !== "reasoning") clearInferenceTimer();
      }
    } else if (method === "item/completed") {
      processItemCompleted(params as ItemCompletedParams);
    }
  }

  for (const method of DISPATCHED_NOTIFICATION_METHODS) {
    unsubs.push(
      client.on(method, (params) => {
        if (turnId === null) {
          // Buffer — replayed in arrival order once turnId is known, so
          // fast-turn events that beat the turn/start response are still
          // filtered and processed exactly once.
          notificationBuffer.push({ method, params });
          return;
        }
        routeNotification(method, params);
      }),
    );
  }

  // Detect connection loss mid-turn. Neither completion.waitFor nor the
  // inference promise fires when the app-server or broker dies, so without
  // this the CLI would silently wait the full turn timeout (default 20 min)
  // and then report a misleading "Turn timed out".
  let connectionLost: ((err: Error) => void) | null = null;
  const connectionLossPromise = new Promise<never>((_resolve, reject) => {
    connectionLost = reject;
  });
  connectionLossPromise.catch(() => {}); // avoid unhandled rejection if no race is pending
  unsubs.push(
    client.onClose(() => {
      connectionLost?.(new Error("Connection to Codex lost mid-turn (app-server or broker exited)"));
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

  // Remove leftover signals from a previous (crashed) run while preserving
  // fresh ones from a concurrent `kill`. Modern `kill` writes the target
  // run's PID or "*". A different PID is only stale if that process is gone
  // — a live PID means the signal targets a concurrent run on this thread
  // (possible via the broker-busy → direct-connection fallback) and deleting
  // it would make that kill silently never land. Empty content (legacy
  // `kill`) and wildcards fall back to a wall-clock mtime check —
  // process.uptime would mis-classify a kill issued just before this
  // process started.
  const myPid = String(process.pid);
  try {
    const content = readFileSync(signalPath, "utf-8").trim();
    if (content && content !== "*" && content !== myPid) {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) {
        unlinkSync(signalPath);
      }
    } else if (!content || content === "*") {
      const st = statSync(signalPath);
      if (st.mtimeMs < Date.now() - STALE_KILL_SIGNAL_MS) unlinkSync(signalPath);
    }
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
    const startResponse = await Promise.race([
      client.request<TurnStartResponse & { reviewThreadId?: string }>(method, params),
      killSignal,
      connectionLossPromise,
    ]);
    const { turn } = startResponse;
    if (typeof startResponse.reviewThreadId === "string") {
      // For reviews, the running turn lives on a *review* subthread distinct
      // from params.threadId. The interrupt cleanup paths below must target
      // that subthread; otherwise the review keeps running and the broker
      // stream stays busy until the orphan watchdog fires.
      reviewSubthreadId = startResponse.reviewThreadId;
      opts.onReviewThreadId?.(startResponse.reviewThreadId);
    }

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
      routeNotification(buffered.method, buffered.params);
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
      connectionLossPromise,
    ]);

    opts.dispatcher.flushOutput();
    opts.dispatcher.flush();

    // Output comes from accumulated item/agentMessage/delta notifications
    // (for normal turns) or from exitedReviewMode item/completed notification
    // (for reviews). Note: turn/completed Turn.items is always [] per protocol
    // spec — items are only populated on thread/resume or thread/fork.
    // Use final answer output (excludes intermediate planning/status messages).
    // Falls back to full accumulated output if no final_answer phase was seen.
    const output = opts.dispatcher.getTurnOutput();

    return {
      status: completedTurn.turn.status as TurnResult["status"],
      output,
      filesChanged: opts.dispatcher.getFilesChanged(),
      commandsRun: opts.dispatcher.getCommandsRun(),
      error: completedTurn.turn.error?.message,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    // Both branches need to stop the server-side turn. Without this, the
    // client closes but the turn keeps running on the app-server: the broker
    // stream stays busy until the orphan watchdog (~30 min) fires, blocking
    // every subsequent invocation. The separate `kill` command may have
    // already interrupted — "not found" / "already" errors are expected.
    const interruptThreadId = reviewSubthreadId ?? threadId;
    if (e instanceof KillSignalError) {
      opts.dispatcher.flushOutput();
      opts.dispatcher.flush();
      if (turnId !== null) {
        await runBeforeInterruptHook(opts);
        await tryInterruptTurn(client, interruptThreadId, turnId, "on kill");
      }
      return {
        status: "interrupted",
        output: opts.dispatcher.getTurnOutput(),
        filesChanged: opts.dispatcher.getFilesChanged(),
        commandsRun: opts.dispatcher.getCommandsRun(),
        error: "Thread killed by user",
        durationMs: Date.now() - startTime,
      };
    }
    if (turnId !== null) {
      await runBeforeInterruptHook(opts);
      await tryInterruptTurn(client, interruptThreadId, turnId);
    }
    throw e;
  } finally {
    clearInferenceTimer();
    inferenceResolver = null;
    killAbort.abort();
    abortController.abort();
    for (const unsub of unsubs) unsub();
    // Clean up the signal file — but only if it targets this run. A signal
    // tagged with another live run's PID belongs to that run; deleting it
    // here would make its kill silently never land.
    try {
      const content = readFileSync(signalPath, "utf-8").trim();
      if (content === "" || content === "*" || content === myPid) {
        unlinkSync(signalPath);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not clean up kill signal: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

/** True iff a process with the given PID exists (EPERM counts as alive). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Register approval request handlers on the client. Notification routing
 * lives in executeTurn, where it can filter by the active turn.
 * Returns an array of unsubscribe functions for cleanup.
 */
function registerApprovalHandlers(client: AppServerClient, opts: TurnOptions, signal: AbortSignal): Array<() => void> {
  const { approvalHandler } = opts;
  const unsubs: Array<() => void> = [];

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
  const myPid = String(process.pid);
  const signalPath = join(signalsDir, threadId);

  /** A signal file is targeting THIS run iff its content is empty (legacy
   *  caller — startup check already vetted freshness), our PID, or the
   *  wildcard "*". A different PID means the signal is for some other run. */
  function targetsUs(): boolean {
    try {
      const content = readFileSync(signalPath, "utf-8").trim();
      return content === "" || content === "*" || content === myPid;
    } catch (e) {
      // ENOENT = no signal; anything else = bail and let caller log
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  // Suppress repeated identical poll-loop warnings — a persistent permission
  // problem on the signals dir would otherwise spam stderr at the poll rate
  // (~2 Hz) for the entire turn duration.
  let lastPollErrorMsg: string | null = null;
  let pollErrorBurst = 0;

  function logPollError(e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === lastPollErrorMsg) {
      pollErrorBurst++;
      // Re-emit at exponentially decreasing rate so a long-running issue is
      // still occasionally visible without flooding.
      if ((pollErrorBurst & (pollErrorBurst - 1)) !== 0) return; // not a power of 2
    } else {
      lastPollErrorMsg = msg;
      pollErrorBurst = 1;
    }
    console.error(`[codex] Warning: kill signal poll error (will retry): ${msg}`);
  }

  return new Promise<never>((_resolve, reject) => {
    // Check immediately. Wrap in try/catch — the previous existsSync-only
    // check returned false on permission errors; targetsUs() reads file
    // content and can rethrow non-ENOENT errors, which would otherwise
    // escape the Promise executor as an uncaught rejection.
    try {
      if (existsSync(signalPath) && targetsUs()) {
        reject(new KillSignalError(threadId));
        return;
      }
    } catch (e) {
      logPollError(e);
    }

    const timer = setInterval(() => {
      try {
        if (signal.aborted) {
          clearInterval(timer);
          return;
        }
        if (existsSync(signalPath) && targetsUs()) {
          clearInterval(timer);
          reject(new KillSignalError(threadId));
        }
      } catch (e) {
        // Log but keep polling — the error may be transient (e.g. momentary EACCES).
        logPollError(e);
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
  waitFor: (turnId: string, timeoutOverrideMs?: number) => Promise<TurnCompletedParams>;
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
    // timeoutOverrideMs: per-call budget (goal following hands each
    // continuation turn whatever remains of the goal-scoped deadline).
    waitFor(turnId: string, timeoutOverrideMs?: number): Promise<TurnCompletedParams> {
      const found = buffer.find((p) => p.turn.id === turnId);
      if (found) return Promise.resolve(found);
      const effectiveTimeoutMs = timeoutOverrideMs ?? timeoutMs;

      return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          resolver = null;
          targetId = null;
          unsub();
          reject(new TurnTimeoutError(`Turn timed out after ${Math.round(effectiveTimeoutMs / 1000)}s`));
        }, effectiveTimeoutMs);
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
