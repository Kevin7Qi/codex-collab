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
import { NO_RESPONSE } from "./rpc";
import { isBrokerBusyError } from "./broker";
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
      // The recorded turn id can go stale mid-turn: long turns rotate ids
      // (context compaction spawns a new turn), and interrupting with the
      // original id fails with a mismatch — leaving the turn running as an
      // orphan (observed: a 20-minute review outliving its CLI timeout).
      // The rejection names the turn that was active AT THAT MOMENT.
      //
      // Interrupting that id is only safe while this invocation still owns
      // the thread. If ours ended and another invocation claimed it, the
      // named turn is THEIRS, and interrupting it cancels work nobody asked
      // to stop. Through the broker, ownership is the broker's to know and
      // it does this retarget itself. A direct connection to a PRIVATE
      // app-server owns it outright, so no other invocation can be running
      // there; on a shared server the named turn may be another client's.
      const found = client.isBrokered || client.server.kind !== "private"
        ? undefined
        : /expected active turn id \S+ but found (\S+)/.exec(e.message)?.[1];
      if (found && found !== turnId) {
        try {
          await client.request("turn/interrupt", { threadId, turnId: found });
          return;
        } catch { /* fall through to the warning */ }
      }
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
  /** The turn was JOINED, not started: on a shared app-server the thread
   *  already had another client's turn running and our input was steered
   *  into it. That turn is theirs — its approvals are theirs to answer, and
   *  a kill or timeout here stops our wait, never their turn. */
  onJoinedTurn?: () => void;
  /** The turn is known to be ours — normally as the start answers, but
   *  also late, when a kill overtook the start and its answer was
   *  awaited afterwards. The goal wrapper's brakes depend on it. */
  onTurnOwned?: () => void;
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

/** The id of the turn running on `threadId` right now, or null. Asked only
 *  on a shared app-server, where another client may be driving the thread. */
async function activeTurnOn(client: AppServerClient, threadId: string): Promise<string | null> {
  try {
    const read = await client.request<{ thread?: { turns?: Array<{ id?: unknown; status?: unknown }> } }>(
      "thread/read",
      { threadId, includeTurns: true },
    );
    const active = read.thread?.turns?.find((t) => t.status === "inProgress");
    return typeof active?.id === "string" ? active.id : null;
  } catch {
    return null; // an older server, or a thread we cannot read: start normally
  }
}

/**
 * turn/start — or, on a shared app-server whose thread already has a turn
 * running, turn/steer into it. Codex folds a turn/start's input into a
 * running turn anyway, but answers with a submission id the events never
 * carry, and the caller would wait out its timeout for a turn that
 * finished; steering names the turn that will actually answer.
 */
/** turn/start fields that describe how OUR turn should run. None of them
 *  can apply to a turn another client is running, and Codex would fold the
 *  input into that turn while silently keeping its settings. */
const TURN_OVERRIDE_KEYS = ["sandboxPolicy", "model", "effort", "approvalPolicy", "approvalsReviewer", "cwd"] as const;

/** A start refused because another client's turn holds the thread: the
 *  thread is live for that client, and the record of it must say so. */
export class ThreadBusyError extends Error {
  readonly threadLive = true;
  constructor(message: string) {
    super(message);
    this.name = "ThreadBusyError";
  }
}

/** The text items of a turn's input, for telling a turn that carries it. */
export function inputTexts(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((i): i is { type: "text"; text: string } => !!i && typeof i === "object" && (i as { type?: unknown }).type === "text" && typeof (i as { text?: unknown }).text === "string")
    .map((i) => i.text);
}

/** What one read of a thread says about a submission of ours: the turn
 *  in progress, and the turns whose record carries our input as a user
 *  message — the positive sign that a turn absorbed the submission. A
 *  shared server acknowledges a submission before its turn necessarily
 *  starts: the turn that just ended may have absorbed the input, or merely
 *  preceded a turn of ours; only its record tells which. The match is
 *  exact: a short prompt found inside someone else's message is no
 *  evidence. `readable` false: the server could not be asked. */
export interface ThreadFacts {
  readable: boolean;
  active: string | null;
  carriers: string[];
}

export async function readThreadFacts(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  threadId: string,
  texts: string[],
): Promise<ThreadFacts> {
  const wanted = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  try {
    const read = await request("thread/read", { threadId, includeTurns: true }) as
      { thread?: { turns?: Array<{ id?: unknown; status?: unknown; items?: unknown }> } } | null;
    const turns = read?.thread?.turns ?? [];
    const active = turns.find((t) => t.status === "inProgress");
    const carriers: string[] = [];
    for (const turn of turns) {
      if (typeof turn.id !== "string" || wanted.length === 0) continue;
      const items = Array.isArray(turn.items) ? turn.items as Array<{ type?: unknown; content?: unknown }> : [];
      const carries = items.some((item) =>
        item?.type === "userMessage" && Array.isArray(item.content) &&
        (item.content as Array<{ type?: unknown; text?: unknown }>).some((c) =>
          c?.type === "text" && typeof c.text === "string" && wanted.includes(c.text.trim())));
      if (carries) carriers.push(turn.id);
    }
    return { readable: true, active: typeof active?.id === "string" ? active.id : null, carriers };
  } catch {
    return { readable: false, active: null, carriers: [] };
  }
}

/** What a start still in flight settles to, for whoever must stop the
 *  turn it became (a signal handler, say) before it is known. */
export interface SettledStart {
  joined: boolean;
  turnId: string;
  reviewThreadId: string | null;
}
const pendingStarts = new Map<string, Promise<SettledStart | null>>();

/** Wait (at most `timeoutMs`) for the start in flight on `threadId` to
 *  settle: null when none is pending, it failed, or time ran out. */
export async function awaitPendingStart(threadId: string, timeoutMs: number): Promise<SettledStart | null> {
  const pending = pendingStarts.get(threadId);
  if (!pending) return null;
  return Promise.race([pending, new Promise<null>((r) => setTimeout(r, timeoutMs))]);
}

/** What the thread's events said while the start was in flight: the turns
 *  that started and the turns that completed. A turn/start whose id never
 *  appears among them, while some other turn completed, was absorbed into
 *  that turn — which may already be over. */
export interface ObservedTurns {
  started: string[];
  completed: string[];
}

async function startOrJoinTurn(
  client: AppServerClient,
  method: string,
  params: TurnStartParams | ReviewStartParams,
  opts: TurnOptions,
  observed: () => ObservedTurns = () => ({ started: [], completed: [] }),
  onAccepted?: (turnId: string) => void,
): Promise<{
  response: TurnStartResponse & { reviewThreadId?: string };
  joined: boolean;
  /** Overrides the prompt was submitted with that a turn it was absorbed
   *  into does not run under. */
  overridesUnapplied?: readonly string[];
}> {
  const overrides = method === "turn/start"
    ? TURN_OVERRIDE_KEYS.filter((k) => (params as unknown as Record<string, unknown>)[k] !== undefined)
    : [];
  if (method === "turn/start" && client.server.kind === "shared") {
    // A steer names the turn it expects; when that turn has ended and
    // another is running (a goal continuation, say), read again and steer
    // that one. Only a thread with no turn in progress gets one of ours.
    let active = await activeTurnOn(client, params.threadId);
    for (let attempt = 0; active && attempt < 3; attempt++) {
      if (overrides.length > 0) {
        throw new ThreadBusyError(
          "Another client of the shared app-server is running a turn on this thread, and a " +
          `${overrides.map((k) => `\`${k}\``).join("/")} override cannot apply to it. ` +
          "Retry without overrides to add your prompt to that turn, or wait for it to finish.",
        );
      }
      try {
        const steered = await client.request<{ turnId: string }>("turn/steer", {
          threadId: params.threadId,
          expectedTurnId: active,
          input: (params as TurnStartParams).input,
        });
        opts.dispatcher.progressLine("Joined the turn already running on this thread");
        return {
          response: { turn: { id: steered.turnId, items: [], status: "inProgress", error: null } } as TurnStartResponse,
          joined: true,
        };
      } catch (e) {
        // Another invocation through this broker owns the thread: that is
        // the documented retryable condition, not a failure to join.
        if (isBrokerBusyError(e)) throw e;
        const again = await activeTurnOn(client, params.threadId);
        if (again === active) {
          // The turn is still running and would not take the steer. A
          // turn/start now would be folded into it unobserved.
          throw new ThreadBusyError(
            `Another client of the shared app-server is running a turn on this thread and it could not be joined ` +
            `(${e instanceof Error ? e.message : String(e)}). Retry once it finishes.`,
          );
        }
        active = again;
      }
    }
    if (active) {
      throw new ThreadBusyError("Another client of the shared app-server keeps starting turns on this thread faster than they can be joined. Retry in a moment.");
    }
  }
  const before = observed();
  const response = await client.request<TurnStartResponse & { reviewThreadId?: string }>(method, params);
  if (method === "turn/start" && client.server.kind === "shared" && !observed().started.includes(response.turn.id)) {
    // Between the read and this start another client may have started a
    // turn; Codex then folded our input into it and answered with an id
    // its events never carry. (A start already seen starting is ours and
    // needs no further look.) The thread's active turn is the truth — and
    // when that turn already finished, the events seen since the
    // submission are: a completion for a turn that is not ours, none for
    // the id we got. (A completion seen before the submission belongs to
    // an earlier turn and says nothing about this one.)
    // The id is recorded before the read: a kill landing meanwhile must be
    // able to stop the turn this may turn out to be.
    onAccepted?.(response.turn.id);
    // A broker has already decided this, from the same evidence, before it
    // answered — its answer says so, and the reads below are spared.
    const decided = (response as { absorbedBy?: unknown }).absorbedBy;
    let absorbedBy: string | null;
    if (client.isBrokered && (decided === null || typeof decided === "string")) {
      absorbedBy = decided;
    } else {
      let facts = await readThreadFacts(
        (m, p) => client.request(m, p), params.threadId, inputTexts((params as { input?: unknown }).input),
      );
      // A failed read is no evidence of ownership. Keep requests held
      // while retrying briefly; a turn/started naming our accepted id
      // can establish ownership even when the read remains unavailable.
      for (let attempt = 1; !facts.readable && !observed().started.includes(response.turn.id) && attempt < 3; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (observed().started.includes(response.turn.id)) break;
        facts = await readThreadFacts(
          (m, p) => client.request(m, p), params.threadId, inputTexts((params as { input?: unknown }).input),
        );
      }
      const seen = observed();
      if (!facts.readable && !seen.started.includes(response.turn.id)) {
        throw new ThreadBusyError(
          "Could not determine turn ownership on the shared app-server: the thread could not be read. " +
          "The prompt was submitted and may be running in another client's turn. " +
          "Check the thread before retrying; its turn and goal were left untouched.",
        );
      }
      const completedSince = seen.completed.slice(before.completed.length);
      // A turn of ours that was seen starting, or reported running, is ours
      // whatever else happened: it may have finished already, with another
      // client's turn or a goal continuation active since. Only an id the
      // events never announced was absorbed — into the active turn, or into
      // a turn already over whose record carries our input (a completion
      // alone says nothing: the turn may merely have preceded ours).
      absorbedBy = seen.started.includes(response.turn.id) || facts.active === response.turn.id
        ? null
        : facts.active
          ?? completedSince.find((id) => id !== response.turn.id && facts.carriers.includes(id))
          ?? null;
      if (absorbedBy && client.isBrokered) {
        // The broker's claim must stand for the joined turn too, or its
        // orphan recovery would later interrupt another client's work.
        await client.request("broker/joined", { threadId: params.threadId, turnId: absorbedBy }).catch(() => undefined);
      }
    }
    if (absorbedBy) {
      opts.dispatcher.progressLine("Joined the turn that started on this thread in the meantime");
      // The prompt is in that turn now, under that turn's settings: an
      // override asked for here did not apply, and the caller must not be
      // told the turn ran under it (see executeTurn).
      return { response: { ...response, turn: { ...response.turn, id: absorbedBy } }, joined: true, overridesUnapplied: overrides };
    }
  }
  return { response, joined: false };
}

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
    // A goal on a thread whose turn is another client's is that client's:
    // never this run's to record (or to exit blocked on).
    if (owned()) notifyGoal(p.goal);
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
  // Unknown until the start settles: a kill during a shared server's read
  // or steer ends the first turn "interrupted" before either callback ran,
  // and a goal on the thread may well be another client's.
  // (Read through a function: the closures below mutate it, which TypeScript
  // does not see when narrowing the variable at the checks further down.)
  let ownershipState: "unknown" | "own" | "joined" = "unknown";
  const ownership = (): "unknown" | "own" | "joined" => ownershipState;
  // On a private server no other client can own a turn: a start whose
  // answer never settled here still owned whatever it accepted.
  const owned = (): boolean => ownershipState === "own" || (ownershipState === "unknown" && client.server.kind === "private");
  const wrappedOpts: GoalRunOptions = {
    ...opts,
    onJoinedTurn: () => {
      ownershipState = "joined";
      opts.onJoinedTurn?.();
    },
    onTurnOwned: () => {
      if (ownershipState === "unknown") ownershipState = "own";
      opts.onTurnOwned?.();
    },
    onTurnId: (id) => {
      if (ownershipState === "unknown") ownershipState = "own";
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
  // A continuation can start AND stream while we are still doing the
  // post-turn goal read — before `following` arms. Those events are
  // buffered (not dropped) and replayed the moment follow mode starts.
  // Only events carrying a followed turn's id land here, and own turns
  // never enter followedTurnIds, so nothing double-dispatches with
  // executeTurn's routing during the first turn.
  const preFollowBuffer: Array<{ method: string; params: unknown }> = [];
  unsubs.push(...DISPATCHED_NOTIFICATION_METHODS.map((method) =>
    client.on(method, (params) => {
      const routing = params as { threadId?: unknown; turnId?: unknown };
      if (routing?.threadId !== threadId) return;
      if (typeof routing?.turnId === "string" && !followedTurnIds.has(routing.turnId)) return;
      if (!following) {
        // No-turnId events stay dropped pre-follow: ownership is ambiguous
        // with the first turn's own routing.
        if (typeof routing?.turnId === "string") preFollowBuffer.push({ method, params });
        return;
      }
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
  const readGoal = async (opts2: { record?: boolean } = {}): Promise<ThreadGoal | null> => {
    const { goal, ok } = await readThreadGoal(client, threadId);
    if (!ok) return lastGoal;
    if (goal && opts2.record === false) return goal; // learned, not yet recorded: whose it is is not known
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
    // retains stream ownership across the coming continuation turns. It is
    // not recorded yet: on a shared server the turn may turn out to be
    // another client's, and so would the goal.
    await readGoal({ record: false });

    let first: TurnResult;
    try {
      first = await runTurn(client, threadId, input, wrappedOpts);
    } catch (e) {
      // A first-turn timeout with an active goal must not leave the goal
      // burning headless after the CLI exits with code 3. pauseAndInterrupt
      // does its own authoritative read — cached flags would miss a goal
      // that appeared mid-turn without any notification reaching us.
      if (e instanceof TurnTimeoutError && owned()) {
        await pauseAndInterrupt(null, "on timeout");
      }
      throw e;
    }

    // A joined turn was another client's, and so is any goal on the thread:
    // nothing here to pause, follow, interrupt — or report as this run's.
    // (A start that never settled is unknown, and only a private server
    // lets that count as ours.)
    if (!owned()) return { ...finish(first), goal: null, goalSeen: false };

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
      // Replay events a fast continuation streamed before follow mode armed.
      // Synchronous — no await between arming and replay, so live events
      // cannot interleave out of order.
      for (const buffered of preFollowBuffer.splice(0)) {
        dispatchNotification(opts.dispatcher, buffered.method, buffered.params);
      }
      followUnsubs.push(...registerApprovalHandlers(client, opts, followAbort.signal, undefined, () => ({ threadIds: [threadId], turnId: null })));
      followUnsubs.push(declineUnhandledRequests(client, threadId, () => null, async () => owned()));

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
      let lastTurnErrorInfo: TurnResult["errorInfo"] = first.errorInfo ?? null;
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
          lastTurnErrorInfo = completed.turn.error?.codexErrorInfo ?? null;
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
        errorInfo: lastTurnErrorInfo,
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
  /** The id the server accepted for a start whose ownership is still being read: a target for a kill, not yet an id to route by. */
  let acceptedTurnId: string | null = null;
  let startAttempt: ReturnType<typeof startOrJoinTurn> | null = null;

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

  // Whose turn the requests arriving here belong to. Unknown until the
  // start settles; a joined turn belongs to another client of a shared
  // app-server (see startOrJoinTurn), and nothing below may answer for it
  // or stop it. While unknown, a shared server's requests are still not
  // ours to settle — they may be for the turn we are about to join.
  let ownership: "unknown" | "own" | "joined" = "unknown";
  let ownershipKnown!: () => void;
  const ownershipSettled = new Promise<void>((resolve) => { ownershipKnown = resolve; });
  const settleOwnership = (value: "own" | "joined"): void => {
    if (ownership !== "unknown") return;
    ownership = value;
    ownershipKnown();
  };
  const joinedTurn = (): boolean => ownership === "joined";
  const ownedTurn = (): boolean => ownership === "own";
  const ownershipUnknown = (): boolean => ownership === "unknown";
  /** Whether a request arriving now is ours to answer. On a shared server an
   *  unknown ownership means WAIT, not decline: an approval for our own turn
   *  can arrive in the same read as the turn/start response, and a reply of
   *  silence would strand that turn. Held requests are answered once the
   *  start settles — ours, or left alone. */
  const ours = async (): Promise<boolean> => {
    if (ownership === "unknown" && client.server.kind === "shared") await ownershipSettled;
    return ownership !== "joined";
  };

  // AbortController for cancelling in-flight approval polls on turn completion/timeout
  const abortController = new AbortController();
  const unsubs = registerApprovalHandlers(client, opts, abortController.signal, ours, () => ({
    threadIds: reviewSubthreadId ? [threadId, reviewSubthreadId] : [threadId],
    // A review's approvals may carry its inner turn's id: scope by thread alone there.
    turnId: reviewSubthreadId ? null : turnId,
  }));
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

  unsubs.push(declineUnhandledRequests(client, threadId, () => reviewSubthreadId, ours, () => (reviewSubthreadId ? null : turnId)));

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

  // The thread's turn lifecycle as seen from here, from before the start:
  // the item buffer above holds only dispatched item events, and a start
  // absorbed into another client's turn is recognized by these.
  const seenTurns: ObservedTurns = { started: [], completed: [] };
  for (const lifecycle of ["turn/started", "turn/completed"] as const) {
    unsubs.push(client.on(lifecycle, (params) => {
      const p = params as { threadId?: unknown; turn?: { id?: unknown } } | undefined;
      if (p?.threadId !== threadId || typeof p?.turn?.id !== "string") return;
      (lifecycle === "turn/started" ? seenTurns.started : seenTurns.completed).push(p.turn.id);
    }));
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
    const observed = (): ObservedTurns => ({ started: [...seenTurns.started], completed: [...seenTurns.completed] });
    // A turn the server accepted is recorded as soon as it is, so that a
    // kill landing while its ownership is still being read can stop it —
    // as a target only: events keep buffering until the id they should
    // be filtered by is known, which for an absorbed start is another.
    startAttempt = startOrJoinTurn(client, method, params, opts, observed, (id) => { acceptedTurnId = id; });
    startAttempt.catch(() => undefined); // its failure surfaces through the race below
    const settled = startAttempt.then(
      (s) => ({ joined: s.joined, turnId: s.response.turn.id, reviewThreadId: typeof s.response.reviewThreadId === "string" ? s.response.reviewThreadId : null }),
      () => null,
    );
    pendingStarts.set(threadId, settled);
    settled.finally(() => { if (pendingStarts.get(threadId) === settled) pendingStarts.delete(threadId); });
    const started = await Promise.race([
      startAttempt,
      killSignal,
      connectionLossPromise,
    ]);
    const startResponse = started.response;
    settleOwnership(started.joined ? "joined" : "own");
    if (started.joined) opts.onJoinedTurn?.();
    else opts.onTurnOwned?.();
    if (started.overridesUnapplied && started.overridesUnapplied.length > 0) {
      // Too late to refuse: Codex folded the prompt into the other
      // client's turn. What can still be refused is reporting success
      // for settings that turn does not run under.
      const named = started.overridesUnapplied.map((k) => `\`${k}\``).join("/");
      throw new ThreadBusyError(
        "Another client of the shared app-server started a turn on this thread just as this prompt was " +
        `submitted, and Codex folded the prompt into that turn — which does not run under the ${named} ` +
        "override asked for here. That turn is the other client's; its outcome is not reported here. " +
        "Retry once it finishes.",
      );
    }
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
      errorInfo: completedTurn.turn.error?.codexErrorInfo ?? null,
      durationMs: Date.now() - startTime,
    };
  } catch (e) {
    // Both branches need to stop the server-side turn. Without this, the
    // client closes but the turn keeps running on the app-server: the broker
    // stream stays busy until the orphan watchdog (~30 min) fires, blocking
    // every subsequent invocation. The separate `kill` command may have
    // already interrupted — "not found" / "already" errors are expected.
    // A joined turn is another client's: a kill or timeout here ends our
    // wait and leaves their turn — and their goal — alone.
    let stopId = turnId ?? acceptedTurnId;
    if (e instanceof KillSignalError) {
      opts.dispatcher.flushOutput();
      opts.dispatcher.flush();
      if (ownershipUnknown() && startAttempt !== null) {
        // Whose turn the start became is not known yet: its answer, or the
        // read of the thread after it, is still out. Wait (briefly) for
        // the verdict — a turn of ours is stopped with its goal paused
        // first, here and in the goal wrapper; another client's is left
        // alone. On a direct shared connection nothing else would: the
        // server outlives the connection, and no broker recovers what it
        // accepted. On a private server the answer can only be ours, but
        // the goal it may carry is still paused only once that is known.
        const late = await Promise.race([
          startAttempt.then((s) => s, () => null),
          new Promise<null>((r) => setTimeout(r, 5000)),
        ]);
        if (late) {
          settleOwnership(late.joined ? "joined" : "own");
          if (late.joined) opts.onJoinedTurn?.();
          else {
            opts.onTurnOwned?.();
            stopId = late.response.turn.id;
            // A review runs on the subthread the answer names.
            if (typeof late.response.reviewThreadId === "string") {
              reviewSubthreadId = late.response.reviewThreadId;
              opts.onReviewThreadId?.(reviewSubthreadId);
            }
          }
        }
      }
      // The answer may have landed during the wait while its ownership
      // read ran on: what it accepted is still ours to stop by id.
      if (stopId === null) stopId = turnId ?? acceptedTurnId;
      const interruptThreadId = reviewSubthreadId ?? threadId;
      if (stopId !== null && !joinedTurn()) {
        // A turn whose ownership was still being read is stopped by id
        // alone (the server refuses an id that is not its active turn);
        // its goal, if any, is paused only once the turn is known ours.
        if (ownedTurn()) await runBeforeInterruptHook(opts);
        await tryInterruptTurn(client, interruptThreadId, stopId, "on kill");
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
    // An ownership read that failed after submission leaves only an
    // unverified submission id. Do not mutate the thread on that failure.
    if (stopId !== null && !joinedTurn() && !(e instanceof ThreadBusyError)) {
      if (ownedTurn()) await runBeforeInterruptHook(opts);
      await tryInterruptTurn(client, reviewSubthreadId ?? threadId, stopId);
    }
    throw e;
  } finally {
    // A start that failed or was abandoned never owned a turn: requests
    // held for it are released as not ours.
    settleOwnership("joined");
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
/**
 * Every server request the run has no handler for — a user-input question,
 * an elicitation, a tool call — is declined by "method not found" for our
 * own turn (the server takes it as a decline and moves on), and left to its
 * owner for a joined one. Through the broker this never fires; on a direct
 * shared connection it is the only guard, and there a request that names
 * no thread of ours — another client's, or one to the connection itself,
 * such as an auth-token refresh — is not ours to answer either: the first
 * answer wins, and a decline from here would fail it for its owner.
 */
function declineUnhandledRequests(
  client: AppServerClient,
  threadId: string,
  subthread: () => string | null,
  ours: () => Promise<boolean>,
  /** Our turn, once known: a request naming another turn on the thread —
   *  a successor's question arriving with our completion — is its. */
  turn: () => string | null = () => null,
): () => void {
  return client.onAnyRequest(async (method, params) => {
    if (client.server.kind === "shared") {
      const p = params as { threadId?: unknown; turnId?: unknown } | null | undefined;
      const forThread = p?.threadId;
      if (forThread !== threadId && forThread !== subthread()) return NO_RESPONSE;
      // A dynamic tool belongs to whoever declared it on the thread — the
      // broker's `consult`, say, on a thread the peer created — not to the
      // connection running the turn; this one implements none.
      if (method === "item/tool/call") return NO_RESPONSE;
    }
    if (!(await ours())) return NO_RESPONSE;
    // Ownership may have been unknown above. Read the settled turn id
    // now, or a foreign question held during start could be declined as
    // ours merely because both requests name the same thread.
    if (client.server.kind === "shared") {
      const own = turn();
      const p = params as { turnId?: unknown } | null | undefined;
      if (own !== null && typeof p?.turnId === "string" && p.turnId !== own) return NO_RESPONSE;
    }
    const err = new Error(`Method not found: ${method}`) as Error & { code: number };
    err.code = -32601;
    throw err;
  });
}

/** What an approval must name to be this run's to answer on a shared
 *  server: one of its threads, and — once known — its turn. */
interface ApprovalScope {
  threadIds: string[];
  turnId: string | null;
}

function withinScope(params: unknown, scope: ApprovalScope): boolean {
  const p = params as { threadId?: unknown; turnId?: unknown } | null | undefined;
  if (typeof p?.threadId === "string" && !scope.threadIds.includes(p.threadId)) return false;
  if (scope.turnId !== null && typeof p?.turnId === "string" && p.turnId !== scope.turnId) return false;
  return true;
}

function registerApprovalHandlers(
  client: AppServerClient,
  opts: TurnOptions,
  signal: AbortSignal,
  ours: () => boolean | Promise<boolean> = () => true,
  /** On a shared server approvals fan out to every subscribed client and
   *  can name another client's turn — one that started right after ours
   *  ended, say. Only those within scope are answered. */
  scope?: () => ApprovalScope,
): Array<() => void> {
  const { approvalHandler } = opts;
  const unsubs: Array<() => void> = [];
  const answerable = async (params: unknown): Promise<boolean> => {
    if (!(await ours())) return false;
    if (scope && client.server.kind === "shared" && !withinScope(params, scope())) return false;
    return true;
  };

  // Approval requests (server -> client requests expecting a response).
  // The AppServerClient.onRequest handler returns the result directly;
  // the client takes care of sending the JSON-RPC response. On a shared
  // app-server they fan out to every client subscribed to the thread and
  // the first answer wins: for a turn we only joined, the answer is the
  // owning client's to give, so ours is silence.
  unsubs.push(
    client.onRequest(
      "item/commandExecution/requestApproval",
      async (params) => {
        if (!(await answerable(params))) return NO_RESPONSE;
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
        if (!(await answerable(params))) return NO_RESPONSE;
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
