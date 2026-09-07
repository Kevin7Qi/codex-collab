#!/usr/bin/env bun

/**
 * Broker server — a long-running detached process that multiplexes
 * JSON-RPC messages between socket clients and a single `codex app-server` child.
 *
 * Usage: bun run src/broker-server.ts serve --endpoint <value> [--cwd <path>] [--idle-timeout <ms>]
 *
 * Behavior:
 * - Spawns `codex app-server` as a child and connects via stdio
 * - Listens on a Unix socket (or Windows named pipe) for client connections
 * - Forwards JSON-RPC messages between socket clients and the app-server
 * - Thread-scoped routing: each thread's turn is owned by the socket that
 *   started it; notifications route by threadId, so clients on DIFFERENT
 *   threads run concurrently over the one app-server. Only same-thread
 *   contention returns error code -32001.
 * - Idle timeout: shuts down after N ms with no activity
 * - Handles SIGTERM/SIGINT gracefully
 */

import net from "node:net";
import fs, { chmodSync } from "node:fs";
import path from "node:path";
import { type AppServerClient } from "./client";
import { NO_RESPONSE } from "./rpc";
import { connectAppServer } from "./shared-server";
import { terminateProcessTree, waitForProcessTreeExit } from "./process";
import { parseEndpoint, BROKER_BUSY_RPC_CODE } from "./broker";
import { RpcError } from "./types";
import { config, sandboxModeOf } from "./config";
import { inputTexts, readThreadFacts } from "./turns";
import { adoptionFor, createPeer, type InternalOwner, type Peer } from "./peer";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Awaiting this parks the caller forever. Used where an async handler is
 *  already on its way to process.exit(): the point is to stop the main flow
 *  advancing in the meantime, not to ever resume. */
const untilProcessExits = (): Promise<never> => new Promise<never>(() => {});

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Methods that start a streaming turn on a thread named in their params —
 *  the socket that initiates one owns that thread until turn/completed. */
/** Methods whose response names a turn the caller must then receive events
 *  for. `turn/steer` joins a turn another client is running on a shared
 *  app-server; its claim is marked joined, since the turn is not ours. */
const STREAMING_METHODS = new Set(["turn/start", "review/start", "turn/steer"]);

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  endpoint: string;
  cwd: string;
  idleTimeout: number;
} {
  let endpoint: string | undefined;
  let cwd = process.cwd();
  let idleTimeout = config.defaultBrokerIdleTimeout;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--endpoint" && i + 1 < argv.length) {
      endpoint = argv[++i];
    } else if (arg === "--cwd" && i + 1 < argv.length) {
      cwd = path.resolve(argv[++i]);
    } else if (arg === "--idle-timeout" && i + 1 < argv.length) {
      idleTimeout = Number(argv[++i]);
      if (!Number.isFinite(idleTimeout) || idleTimeout <= 0) {
        throw new Error(`Invalid --idle-timeout: ${argv[i]}`);
      }
    }
  }

  if (!endpoint) {
    throw new Error("Missing required --endpoint");
  }

  return { endpoint, cwd, idleTimeout };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket: net.Socket, message: Record<string, unknown>): void {
  if (socket.destroyed) return;
  socket.write(JSON.stringify(message) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error(
      "Usage: bun run src/broker-server.ts serve --endpoint <value> [--cwd <path>] [--idle-timeout <ms>]",
    );
  }

  const { endpoint, cwd, idleTimeout } = parseArgs(argv);
  const listenTarget = parseEndpoint(endpoint);
  /** Inode of the socket this process bound, for ownership checks at cleanup. */
  let listenInode: number | null = null;

  // Guard the startup window BEFORE spawning anything. The full signal
  // handlers below need `server`, which does not exist yet — but this is
  // exactly the window that matters: a parent that gives up on us sends
  // SIGTERM while this connect is still in flight, and with no handler
  // installed it hits default disposition and kills the broker outright. The
  // app-server is spawned detached, in its OWN process group, so it survives
  // the group signal aimed at us and nothing is left alive to close it — it
  // then holds codex's sqlite state lock indefinitely, which is precisely the
  // contention the parent is about to retry into.
  //
  // Killing the PID directly (rather than awaiting the client) is deliberate:
  // the handshake may never complete, since a wedged app-server is the usual
  // reason the parent gave up in the first place.
  let appServerPid: number | null = null;
  let startupSignalled = false;
  const startupGuard = (signal: NodeJS.Signals) => {
    if (startupSignalled) return;
    startupSignalled = true;
    void (async () => {
      process.stderr.write(`[broker-server] ${signal} while starting — stopping the app server before exit\n`);
      // Loop rather than read `appServerPid` once: connectDirectWithRetry runs
      // independently of this guard and can spawn a REPLACEMENT while we are
      // waiting on the one we just terminated. Exiting then would orphan it —
      // the very failure this guard exists to prevent. `reaped` bounds the
      // loop to the attempts that actually happened.
      const reaped = new Set<number>();
      while (appServerPid !== null && !reaped.has(appServerPid)) {
        const pid = appServerPid;
        reaped.add(pid);
        terminateProcessTree(pid);
        await waitForProcessTreeExit(pid, config.appServerReapTimeout);
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", startupGuard);
  process.on("SIGINT", startupGuard);

  // Spawn the real app-server. Retrying: a broker is usually spawned because
  // no connection existed yet, which is exactly when another app-server may
  // be starting or dying alongside it and contending for codex's sqlite
  // state. Losing that race here kills the broker before it ever binds, and
  // the client sees only "broker did not become ready in time".
  // Codex's shared server when its control socket answers (one writer per
  // thread, and every other client of that server sees these turns live),
  // else a private child as before. `onSpawn` fires only for the child.
  const appClient = await connectAppServer({
    cwd,
    onSpawn: (pid) => {
      appServerPid = pid;
      // Spawned behind a guard that is already unwinding — signal it now
      // rather than leave it initializing (and holding codex's sqlite state)
      // for however long the guard still spends reaping its predecessor.
      // The guard's loop picks this pid up and waits for it to go.
      if (startupSignalled) terminateProcessTree(pid);
    },
  });

  // Signalled while the handshake was completing: the guard is already
  // stopping the app server and will end the process. Park rather than fall
  // through and start serving traffic we are about to drop.
  if (startupSignalled) await untilProcessExits();

  // If the app-server exits unexpectedly, shut down the broker immediately
  // so the next ensureConnection() spawns a fresh broker + app-server.
  let shutdownInitiated = false;
  appClient.onClose(() => {
    if (shutdownInitiated) return;
    shutdownInitiated = true;
    process.stderr.write("[broker-server] App-server exited unexpectedly — shutting down\n");
    shutdown(server).then(() => process.exit(1));
  });

  // ─── State ──────────────────────────────────────────────────────────────

  /** Per-thread ownership. An entry exists while a turn is running (or
   *  starting) on the thread; it is the unit of routing, contention, goal
   *  retention, and orphan recovery. */
  interface ThreadEntry {
    /** Owner of this thread's turn: a client socket, or an internal owner
     *  (the workspace peer running a turn of its own). null = orphan
     *  sentinel: the owner disconnected but the turn is (or may be) still
     *  running, so the entry must keep blocking same-thread starts until
     *  the turn ends or the watchdog reaps it. */
    socket: net.Socket | InternalOwner | null;
    /** Turn to interrupt for orphan recovery. null between the streaming
     *  request being forwarded and turn/started (or the response) naming it. */
    turnId: string | null;
    /** True while the initiating streaming request's response is pending.
     *  The response path (not the close handler) performs orphan interrupts
     *  in this window because only it learns the turnId. */
    requestPending: boolean;
    /** Goal-mode: the previous turn completed and the server is about to
     *  start a continuation. If the goal leaves `active` in this gap
     *  (kill/timeout pausing it between turns), no continuation will start
     *  and no turn/completed will ever arrive — the entry must be released
     *  here or the thread reports busy until the orphan watchdog. */
    awaitingContinuation: boolean;
    /** Per-thread orphan watchdog (armed when the owner disconnects). */
    watchdog: ReturnType<typeof setTimeout> | null;
    /** The claim joined a turn another client of a shared app-server is
     *  running (`turn/steer`). Its approvals, questions and tool calls are
     *  that client's to answer; ours only routes the events. */
    joined?: boolean;
    /** A peer claim whose turn has neither started nor been joined yet.
     *  Requests arriving now (a pending question the server re-sends on
     *  the peer's rejoin, say) belong to whoever is running the thread. */
    settling?: boolean;
    /** Index into the settling buffer at which the claim's start was
     *  submitted: only events from there on say what that start became. */
    submittedAt?: number;
    /** The text of that submission: a turn that carries it as a user
     *  message is the one that absorbed it. */
    submittedInput?: string[];
    /** The server could not be read after the start answered: whose turn
     *  it became is not known. The claim keeps settling — events and
     *  requests held — while the read is retried; a turn/started under the
     *  accepted id settles it as ours meanwhile. */
    undecided?: boolean;
    /** A peer claim's hook to run before held events are let through, kept
     *  for a settlement that happens later than the start (see undecided). */
    beforeReplay?: (verdict: { ownSeen: boolean; absorbedBy: string | null }) => Promise<void> | void;
  }
  const threads = new Map<string, ThreadEntry>();
  /** All connected sockets. */
  const sockets = new Set<net.Socket>();
  /** Threads whose goal is currently active (tracked from thread/goal/*
   *  notifications and request traffic). Goal mode is server-driven
   *  multi-turn: a continuation turn starts the instant one completes, so
   *  releasing thread ownership at turn/completed would drop every
   *  continuation notification on the floor — the goal-following client
   *  only ever sees turn 1. While the goal is active and the owner is still
   *  connected, ownership spans the turns. */
  const goalActiveThreads = new Set<string>();
  /** Count of review/start responses pending. The review subthread's ID is
   *  only learned from the response, so notifications for it that arrive
   *  first have no owner yet — they are BUFFERED per thread (not routed to
   *  a guess: with two concurrent reviews, guessing leaks one review's
   *  output to the other's socket) and flushed to the owner the moment its
   *  response names the subthread. */
  let pendingReviewCount = 0;
  /** threadId → notifications that arrived before any owner existed. */
  const unclaimedNotifications = new Map<string, Array<{ method: string; params: unknown }>>();
  const MAX_UNCLAIMED_BUFFER = 500;
  /** Turns already settled — completed once, or interrupted by the orphan
   *  watchdog. A `turn/interrupt` RPC only acknowledges receipt, so the
   *  turn's own turn/completed can still arrive afterwards, by which time
   *  another turn may own the thread; acting on it would consume the new
   *  turn's output and release its claim, leaving it running unowned.
   *  Bounded — this only needs to cover the window around a handover. */
  /** Kept PER THREAD, most recent last. A turn id is only meaningful within
   *  its thread, and per-thread history cannot be evicted by traffic on
   *  other threads — a single global list can, and the entry it drops is
   *  exactly the one a quiet thread still needs when its orphan's late
   *  completion finally lands. */
  const endedTurns = new Map<string, string[]>();
  /** Threads this connection is subscribed to on the app-server — every
   *  thread/start or thread/resume that succeeded, minus every
   *  thread/unsubscribe. Subscription is what carries a thread's events to
   *  us: a turn started on an unsubscribed thread runs silently (verified),
   *  so anything that starts a turn must re-subscribe first. Idle threads
   *  are released (see releaseThread) so a private server can unload them
   *  — and with them Codex's per-thread writer lock, which is what lets the
   *  Codex app or a TUI open the thread afterwards. */
  const subscribedThreads = new Set<string>();
  /** Notifications that arrived for a peer claim on a shared server while
   *  it was still settling — before its turn started or was joined. They
   *  may belong to another client's turn (whose completion must not close
   *  the peer's run or release its claim) or to the peer's own fast turn
   *  (whose completion beat the turn/start response). Held until the claim
   *  learns its turn id, then replayed for that turn and dropped otherwise. */
  const settlingBuffers = new Map<string, Array<{ method: string; params: unknown }>>();
  /** Deltas held for a settling claim are capped; everything else — the
   *  turn's lifecycle, its items' starts and completions — is kept, or a
   *  finished turn could never be seen to finish. */
  const MAX_SETTLING_DELTAS = 200;
  const settlingDeltas = new Map<string, number>();
  /** Server REQUESTS (approvals, tool calls, questions) that arrived for a
   *  settling claim: answered once the claim knows whose turn they are for
   *  — handled normally for our own turn, left alone for a joined one. An
   *  approval for our own turn can precede its turn/start response, and
   *  dropping it would stall the turn. */
  interface HeldRequest {
    handle: () => unknown;
    resolve: (value: unknown) => void;
    /** The server's id for it: another client answering first retires it. */
    requestId: string | null;
    /** The turn it names: once the claim knows its turn, a request for
     *  another turn on the thread is not ours to answer. */
    turnId: string | null;
  }
  const heldRequests = new Map<string, HeldRequest[]>();

  /** Defer a request about a settling claim until settlement decides. */
  function holdUntilSettled(
    threadId: string,
    handle: () => unknown,
    ids: { requestId?: unknown; turnId?: unknown } = {},
  ): Promise<unknown> {
    return new Promise((resolve) => {
      const list = heldRequests.get(threadId) ?? [];
      list.push({
        handle,
        resolve,
        requestId: typeof ids.requestId === "string" || typeof ids.requestId === "number" ? String(ids.requestId) : null,
        turnId: typeof ids.turnId === "string" ? ids.turnId : null,
      });
      heldRequests.set(threadId, list);
    });
  }

  /** Another client answered a held request first: it is settled. */
  function retireHeldRequest(threadId: string, requestId: string): void {
    const list = heldRequests.get(threadId);
    if (!list) return;
    const kept: HeldRequest[] = [];
    for (const h of list) {
      if (h.requestId === requestId) h.resolve(NO_RESPONSE);
      else kept.push(h);
    }
    if (kept.length > 0) heldRequests.set(threadId, kept);
    else heldRequests.delete(threadId);
  }

  /** The turn in progress on `threadId` as the shared app-server reports
   *  it, null when idle, unreadable, or not a shared server at all. */
  async function activeTurnOf(threadId: string): Promise<string | null> {
    if (appClient.server.kind !== "shared") return null;
    return (await readThreadFacts((m, p) => appClient.request(m, p), threadId, [])).active;
  }

  interface Verdict {
    ownSeen: boolean;
    absorbedBy: string | null;
    /** The server could not be read and the held events decide nothing:
     *  the claim must keep settling rather than assume. */
    undecided: boolean;
  }

  /** Whose turn a settling claim's start became, once the start answered
   *  `turnId`: from the events held meanwhile — our turn seen starting
   *  (`ownSeen`), or, on a shared server, from one read of the thread: the
   *  turn it reports running (ours, or another client's that absorbed the
   *  input), else a turn already over whose record carries the submission.
   *  A foreign completion alone says nothing: the turn may merely have
   *  preceded ours. The claim keeps settling throughout. */
  async function verdictAfterStart(threadId: string, turnId: string | null): Promise<Verdict> {
    const own: Verdict = { ownSeen: true, absorbedBy: null, undecided: false };
    const absorbed = (by: string): Verdict => ({ ownSeen: false, absorbedBy: by, undecided: false });
    // Only events since the submission are evidence: a claim may have
    // buffered an earlier turn's completion before its start went out.
    const evidence = (): { ownSeen: boolean; candidates: string[] } => {
      const since = (settlingBuffers.get(threadId) ?? []).slice(threads.get(threadId)?.submittedAt ?? 0);
      const ownSeen = turnId !== null && since.some((n) =>
        n.method === "turn/started" && (n.params as { turn?: { id?: unknown } } | undefined)?.turn?.id === turnId);
      return { ownSeen, candidates: ownSeen ? [] : foreignCompletionsIn(since, turnId) };
    };
    if (evidence().ownSeen) return own;
    // No id to attribute by (nothing Codex answers today): as before claims settled.
    if (!turnId || appClient.server.kind !== "shared") return { ownSeen: false, absorbedBy: null, undecided: false };
    const facts = await readThreadFacts((m, p) => appClient.request(m, p), threadId, threads.get(threadId)?.submittedInput ?? []);
    // Events that arrived while the read was out may have settled it: a
    // fast turn of ours can have started and finished by now, with a goal
    // continuation running in its place — or a predecessor's completion
    // landed, which the thread reporting OUR turn running outranks.
    const seen = evidence();
    if (seen.ownSeen || facts.active === turnId) return own;
    if (facts.active) return absorbed(facts.active);
    if (!facts.readable) return { ownSeen: false, absorbedBy: null, undecided: true };
    const carrier = seen.candidates.find((id) => facts.carriers.includes(id));
    return carrier ? absorbed(carrier) : { ownSeen: false, absorbedBy: null, undecided: false };
  }

  /** Settle a claim whose start answered: as a turn of ours (the events
   *  held since the submission replayed as the thread's own story) or as
   *  a join of another client's turn (never answered for; its own events
   *  processed, the rest merely forwarded). One place for it: every path
   *  that settles — the start's answer, a steer, a client's own verdict, a
   *  retried read — must do exactly this. */
  function settleClaim(
    threadId: string,
    entry: ThreadEntry,
    verdict: { as: "own" | "joined"; turnId: string | null },
  ): void {
    if (!entry.settling) return;
    entry.settling = false;
    entry.undecided = false;
    entry.beforeReplay = undefined;
    const socket = entry.socket instanceof net.Socket ? entry.socket : null;
    if (verdict.as === "joined") {
      entry.joined = true;
      if (verdict.turnId) entry.turnId = verdict.turnId;
      if (socket) retireForwards(socket, threadId);
      replaySettled(threadId, entry.turnId, socket);
      settleHeldRequests(threadId, false);
      return;
    }
    if (verdict.turnId && !entry.turnId) entry.turnId = verdict.turnId;
    replaySettled(threadId, entry.turnId, socket, true, entry.submittedAt ?? 0);
    settleHeldRequests(threadId, true);
  }

  /** The verdict could not be reached (the server would not be read):
   *  keep the claim settling and ask again, a little later, a few times
   *  — then, still unknown, settle as a join: the safe side is answering
   *  for nothing rather than for another client. A turn/started under the
   *  accepted id settles the claim as ours meanwhile (see routeNotification). */
  function reverdictLater(threadId: string, entry: ThreadEntry, turnId: string | null, attempt: number): void {
    entry.undecided = true;
    const timer = setTimeout(async () => {
      if (threads.get(threadId) !== entry || !entry.settling) return;
      const verdict = await verdictAfterStart(threadId, turnId);
      if (threads.get(threadId) !== entry || !entry.settling) return;
      if (verdict.undecided && attempt < 10) { reverdictLater(threadId, entry, turnId, attempt + 1); return; }
      if (verdict.undecided) {
        process.stderr.write(`[broker-server] Warning: could not learn whose turn the start on ${threadId} became; treating it as another client's\n`);
      }
      const as = verdict.absorbedBy || verdict.undecided ? "joined" : "own";
      if (entry.beforeReplay) {
        try {
          await entry.beforeReplay({ ownSeen: verdict.ownSeen, absorbedBy: verdict.absorbedBy });
        } catch {
          entry.joined = true;
          entry.settling = false;
          releaseThread(threadId);
          return;
        }
        if (threads.get(threadId) !== entry || !entry.settling) return;
      }
      settleClaim(threadId, entry, { as, turnId: as === "joined" ? verdict.absorbedBy : turnId });
    }, 1000);
    timer.unref?.();
  }

  /** The claim on `threadId` settled: `own` runs the held handlers, a join
   *  (or a release) answers them with silence. */
  function settleHeldRequests(threadId: string, own: boolean): void {
    const list = heldRequests.get(threadId);
    heldRequests.delete(threadId);
    if (!list) return;
    const ours = threads.get(threadId)?.turnId ?? null;
    for (const { handle, resolve, turnId } of list) {
      // Not ours, or ours but for another turn on the thread (one that
      // began right after ours ended, say): silence.
      if (!own || (turnId !== null && ours !== null && turnId !== ours)) { resolve(NO_RESPONSE); continue; }
      Promise.resolve().then(handle).then(resolve, (e) => resolve(Promise.reject(e)));
    }
  }
  // Deep enough that a late completion is still recognized after several
  // more turns have come and gone on the thread. It cannot be unbounded, so
  // a replay older than this many turns — arriving while a fresh claim has
  // not yet learned its own turn id — remains theoretically possible.
  const ENDED_TURNS_PER_THREAD = 16;
  const MAX_ENDED_TURN_THREADS = 200;
  function markTurnEnded(threadId: string, turnId: string): void {
    const list = endedTurns.get(threadId) ?? [];
    if (!list.includes(turnId)) list.push(turnId);
    while (list.length > ENDED_TURNS_PER_THREAD) list.shift();
    endedTurns.delete(threadId);
    endedTurns.set(threadId, list); // re-insert so Map order tracks recency
    if (endedTurns.size > MAX_ENDED_TURN_THREADS) {
      const oldest = endedTurns.keys().next();
      if (!oldest.done) endedTurns.delete(oldest.value);
    }
  }
  function turnAlreadyEnded(threadId: string, turnId: string): boolean {
    return endedTurns.get(threadId)?.includes(turnId) ?? false;
  }

  function bufferUnclaimed(threadId: string, method: string, params: unknown): void {
    let list = unclaimedNotifications.get(threadId);
    if (!list) {
      list = [];
      unclaimedNotifications.set(threadId, list);
    }
    let total = 0;
    for (const l of unclaimedNotifications.values()) total += l.length;
    if (total >= MAX_UNCLAIMED_BUFFER) return; // cap: drop, matching pre-buffer behavior
    list.push({ method, params });
  }
  /** In-flight requests forwarded to the app-server (any kind). Idle
   *  shutdown must not fire while one is pending. */
  let inflightRequests = 0;
  /** Pending forwarded requests (e.g. approval requests sent to a client socket,
   *  awaiting a response routed through the main data handler). */
  const pendingForwardedRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    target: net.Socket;
    threadId: string | null;
  }>();

  /** Forwards to `target` about `threadId` end without an upstream reply:
   *  the claim turned out to be a join, so the requests were never ours to
   *  answer — and a rejection would settle another client's dialog. */
  function retireForwards(target: net.Socket, threadId: string): void {
    for (const [reqId, entry] of pendingForwardedRequests) {
      if (entry.target !== target || entry.threadId !== threadId) continue;
      clearTimeout(entry.timer);
      pendingForwardedRequests.delete(reqId);
      entry.resolve(NO_RESPONSE);
    }
  }
  /** Idle timer — shut down if no activity within idleTimeout. */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Orphan-turn watchdog delay — reuse the idle timeout (same magnitude).
   *  Fires per thread when its owner disconnected and no turn/completed has
   *  arrived. Without it, a stuck app-server (or a lost completion
   *  notification) would leave the thread blocked for same-thread starts
   *  forever. */
  const ORPHAN_WATCHDOG_MS = idleTimeout;

  // ─── Workspace peer ─────────────────────────────────────────────────────

  // The front-door peer: registers this broker in Claude Code's session
  // registry and serves the cross-session messaging protocol, so Claude
  // sessions can message the workspace's Codex natively. Inactive (a no-op
  // object) on Windows, without a registry, or with CODEX_COLLAB_PEER=off.
  const stateDir = listenTarget.kind === "unix"
    ? path.dirname(listenTarget.path)
    : path.join(cwd, ".codex-collab-state"); // pipe endpoints never activate the peer
  const peer: Peer = createPeer({
    cwd,
    stateDir,
    request: async (method, params) => {
      if (method === "turn/start" && typeof params?.threadId === "string") {
        const entry = threads.get(params.threadId);
        if (entry?.settling) {
          entry.submittedAt = (settlingBuffers.get(params.threadId) ?? []).length;
          entry.submittedInput = inputTexts(params.input);
        }
      }
      const result = await appClient.request(method, params ?? {});
      // The peer's own thread/start and thread/resume subscribe this
      // connection exactly as a client's do; keep the set truthful.
      if (method === "thread/start" || method === "thread/resume") {
        const id = (result as { thread?: { id?: unknown } } | undefined)?.thread?.id;
        if (typeof id === "string") subscribedThreads.add(id);
      } else if (method === "thread/unsubscribe" && typeof params?.threadId === "string") {
        subscribedThreads.delete(params.threadId);
      }
      return result;
    },
    ensureSubscribed: (threadId, resumeParams, opts) => ensureSubscribed(threadId, resumeParams, opts),
    releaseThreadSubscription: (threadId) => releaseIdleSubscription(threadId),
    claimThread: (threadId, owner: InternalOwner) => {
      if (threads.has(threadId)) return false;
      threads.set(threadId, {
        socket: owner,
        turnId: null,
        requestPending: false,
        awaitingContinuation: false,
        watchdog: null,
        // Only a shared server can make the start another client's.
        settling: appClient.server.kind === "shared",
      });
      return true;
    },
    turnStarted: async (threadId, turnId, beforeReplay) => {
      const undecided = { ownSeen: false, absorbedBy: null };
      const claimed = () => {
        const entry = threads.get(threadId);
        return entry && entry.socket !== null && !(entry.socket instanceof net.Socket) ? entry : null;
      };
      if (!claimed()) return undecided;
      const verdict = await verdictAfterStart(threadId, turnId);
      const entry = claimed();
      if (!entry) return undecided; // released meanwhile
      if (verdict.undecided) {
        // The server would not say: keep settling, ask again shortly, and
        // let the peer carry on as for a turn of its own — nothing is
        // answered or stopped for the claim until it is known.
        entry.requestPending = false;
        entry.beforeReplay = beforeReplay;
        reverdictLater(threadId, entry, turnId, 1);
        return { ownSeen: false, absorbedBy: null };
      }
      // Whatever the peer must know before the held events — and the
      // reply they may carry — are let through (the sandbox a joined turn
      // runs under, which the reply attests). If that cannot be
      // established, the wait ends here: the claim is let go as a join —
      // the turn is another client's, not to be interrupted — and the
      // held reply with it.
      if (beforeReplay) {
        try {
          await beforeReplay({ ownSeen: verdict.ownSeen, absorbedBy: verdict.absorbedBy });
        } catch (e) {
          const failing = claimed();
          if (failing) {
            failing.joined = true;
            failing.settling = false;
            releaseThread(threadId);
          }
          throw e;
        }
        if (claimed() !== entry) return undecided;
      }
      if (verdict.absorbedBy) {
        settleClaim(threadId, entry, { as: "joined", turnId: verdict.absorbedBy });
        return { ownSeen: false, absorbedBy: verdict.absorbedBy };
      }
      settleClaim(threadId, entry, { as: "own", turnId });
      return { ownSeen: verdict.ownSeen, absorbedBy: null };
    },
    releaseThread: (threadId) => {
      // Only entries the peer itself owns — a client socket's claim is not
      // the peer's to free.
      const entry = threads.get(threadId);
      if (!entry || entry.socket === null || entry.socket instanceof net.Socket) return;
      // turn/started can land before the request that started it settles.
      // The peer is releasing because that request failed — but a turn
      // was announced, so it is running with nobody listening. Freeing
      // the thread would let the next message start a second turn beside
      // it; treat it as the orphan it is, as a client's failed request is.
      if (entry.turnId) {
        void orphanUnheardTurn(threadId, entry);
        return;
      }
      releaseThread(threadId);
    },
    threadHasTurn: (threadId) => threads.has(threadId),
    turnIsForeign: (threadId) => {
      const entry = threads.get(threadId);
      return !!entry && (entry.joined === true || entry.settling === true);
    },
    activeExternalTurn: activeTurnOf,
    joinTurn: async (threadId, expectedTurnId, input) => {
      const steered = await appClient.request<{ turnId: string }>("turn/steer", { threadId, expectedTurnId, input });
      const entry = threads.get(threadId);
      // The peer's claim now stands for a turn it only joined.
      if (entry && entry.socket !== null && !(entry.socket instanceof net.Socket)) {
        entry.settling = true; // a steer settles at once, as a join
        settleClaim(threadId, entry, { as: "joined", turnId: steered.turnId });
      }
      return steered.turnId;
    },
    interruptThread: async (threadId) => {
      const entry = threads.get(threadId);
      // Not a peer turn (none, an orphan, or a client's): nothing to stop.
      if (!entry || entry.socket === null || entry.socket instanceof net.Socket) return false;
      // A joined turn is another client's: nothing here to stop either.
      if (entry.joined) return false;
      if (!entry.turnId) throw new Error("the turn has not announced its id yet");
      // Goal first, interrupt second (same order as `kill` and the orphan
      // watchdog): with an active goal, interrupt alone makes the server
      // start a fresh continuation turn.
      if (goalActiveThreads.has(threadId)) {
        try {
          await appClient.request("thread/goal/set", { threadId, status: "paused" });
        } catch (e) {
          process.stderr.write(`[broker-server] Warning: could not pause the goal on ${threadId} before interrupting: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      await appClient.request("turn/interrupt", { threadId, turnId: entry.turnId });
      return true;
    },
    log: (line) => process.stderr.write(`[broker-server] ${line}\n`),
  });

  // Dynamic tool calls arrive as server-initiated requests on the shared
  // connection. Route by ownership: the peer answers for its conversations
  // (whoever runs the current turn — a CLI-driven turn on a peer thread
  // still consults through the peer, which declared the tool); any other
  // thread's calls forward to the client socket that owns it, since that
  // client declared whatever tools the thread has. A thread that is
  // nobody's here gets no answer at all: on a shared app-server the call
  // fans out to every subscribed client, and the one that declared the
  // tool is the one meant to answer it.
  appClient.onRequest("item/tool/call", (params, requestId) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof p.threadId === "string" ? p.threadId : "";
    const rid = typeof requestId === "string" || typeof requestId === "number" ? String(requestId) : null;
    // The peer's consult tool is the peer's to implement on every turn of
    // a thread it declared it on — a turn the Codex app runs there, or one
    // a CLI invocation joined, can call it, and nobody else can deliver
    // the question to Claude. Only the peer that DECLARED it: a broker that
    // merely adopted the thread through a CLI run must not answer beside it.
    if (p.tool === "consult" && peer.declaresConsultOn(threadId)) {
      const claim = threads.get(threadId);
      // A claim still settling may stand for another client's turn too.
      const peerTurn = !!claim && claim.socket !== null && !(claim.socket instanceof net.Socket) && !claim.joined && !claim.settling;
      if (!peerTurn && appClient.server.kind === "shared") {
        // Another client's turn (the app's, a TUI's, one a CLI joined): the
        // question is attested with the sandbox that turn runs under, not
        // the one the conversation last recorded — the receiver gates on it.
        return (async () => {
          let mode: ReturnType<typeof sandboxModeOf>;
          try {
            const resumed = await appClient.request<{ sandbox?: unknown }>("thread/resume", { threadId });
            subscribedThreads.add(threadId); // a resume subscribes, like every other
            mode = sandboxModeOf(resumed?.sandbox);
          } catch { /* unverifiable: refused below */ }
          // Fail closed: an attestation the receiver gates on is never
          // made on a stale record.
          if (!mode) throw new Error("consult not relayed: the sandbox this turn runs under could not be verified");
          peer.noteThreadSandbox(threadId, mode);
          return peer.handleToolCall(p, rid);
        })();
      }
      return peer.handleToolCall(p, rid);
    }
    const entry = threads.get(threadId);
    if (entry?.joined) return NO_RESPONSE;
    if (entry?.settling && appClient.server.kind === "shared") {
      return holdUntilSettled(threadId, () => {
        const now = threads.get(threadId);
        if (!now || now.joined) return NO_RESPONSE;
        if (now.socket instanceof net.Socket && !now.socket.destroyed) return forwardRequestToSocket(now.socket, "item/tool/call", p);
        return NO_RESPONSE;
      }, { requestId: rid, turnId: p.turnId });
    }
    // On a shared server any other tool is another client's.
    if (appClient.server.kind === "shared") return NO_RESPONSE;
    if (entry?.socket instanceof net.Socket && !entry.socket.destroyed) {
      return forwardRequestToSocket(entry.socket, "item/tool/call", p);
    }
    return NO_RESPONSE;
  });

  // Every other server-sent request — user-input questions, MCP
  // elicitations, permission approvals, whatever the protocol adds — used
  // to be answered "method not found", which the server takes as a
  // decline. That is right for our own turns and wrong for anyone else's:
  // on a shared app-server the request also reaches the client that can
  // answer it, and the first reply settles it. Stay silent for turns that
  // are not ours.
  appClient.onAnyRequest((method, params, requestId) => {
    const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
    if (typeof threadId === "string") {
      // Ownership of the TURN decides, not of the conversation: a thread the
      // peer keeps loaded can be running the Codex app's turn, and that
      // turn's questions are the app's to answer.
      const entry = threads.get(threadId);
      if (!entry || entry.joined) return NO_RESPONSE;
      if (entry.settling && appClient.server.kind === "shared") {
        return holdUntilSettled(threadId, () => {
          const err = new Error(`Method not found: ${method}`) as Error & { code: number };
          err.code = -32601;
          throw err;
        }, { requestId, turnId: (params as { turnId?: unknown } | undefined)?.turnId });
      }
    } else if (appClient.server.kind === "shared") {
      // No thread at all — a connection-global request such as an auth
      // token refresh, broadcast to every client of the shared server and
      // settled by the first reply. It belongs to the client that holds
      // what it asks for, never to an idle broker.
      return NO_RESPONSE;
    }
    const err = new Error(`Method not found: ${method}`) as Error & { code: number };
    err.code = -32601;
    throw err;
  });

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (threads.size > 0 || inflightRequests > 0 || pendingForwardedRequests.size > 0) {
        resetIdleTimer();
        return;
      }
      // A peer exists so Claude sessions can message Codex at any moment —
      // stay resident while any live session might. The scan is one readdir
      // per idle period; when the last session exits, the next fire ends us.
      if (peer.active && peer.hasLiveSessions()) {
        resetIdleTimer();
        return;
      }
      process.stderr.write("[broker-server] Idle timeout — shutting down\n");
      shutdown(server).then(() => process.exit(0));
    }, idleTimeout);
  }

  /** Release a thread entry: clear its watchdog and forget it. Every release
   *  (except shutdown's sweep) tells the peer the thread's turn is over, so
   *  a message injected mid-turn that the departed turn never sampled gets a
   *  turn of its own — this is the ONE choke point, deliberately: releases
   *  also happen on failed streaming requests, review-parent handoff, goal
   *  deactivation between turns, and watchdog reaps, and a wake skipped on
   *  any of them would strand the message as silent context forever. */
  function releaseThread(threadId: string): void {
    const entry = threads.get(threadId);
    if (!entry) return;
    if (entry.watchdog) clearTimeout(entry.watchdog);
    threads.delete(threadId);
    settlingBuffers.delete(threadId);
    settlingDeltas.delete(threadId);
    settleHeldRequests(threadId, false);
    notifyTurnEnded(threadId);
    // Deferred like the peer hook, and after it: the hook may start a
    // replacement turn on this thread, which must find it still subscribed.
    setImmediate(() => releaseIdleSubscription(threadId));
  }

  /** Drop our subscription to a thread nothing here still needs: no turn
   *  runs on it, no goal is between turns, and the peer is not keeping it
   *  (a conversation the peer started keeps its consult tool only while it
   *  stays loaded, so the peer holds those until their thread peer
   *  retires). On a shared app-server this is what stops other clients'
   *  turns on the thread from streaming here; it also lets the server
   *  unload the thread — and release Codex's writer lock — where it does
   *  that for unsubscribed idle threads (0.153.4 was not observed to).
   *  Anything that runs a turn here later re-subscribes first. */
  function releaseIdleSubscription(threadId: string): void {
    if (shutdownInitiated || !subscribedThreads.has(threadId)) return;
    if (threads.has(threadId) || goalActiveThreads.has(threadId)) return;
    if (peer.keepsThreadLoaded(threadId)) return;
    unsubscribeThread(threadId);
  }

  function unsubscribeThread(threadId: string): void {
    subscribedThreads.delete(threadId);
    appClient.request("thread/unsubscribe", { threadId }).catch((e) => {
      process.stderr.write(`[broker-server] Warning: thread/unsubscribe failed for ${threadId}: ${e instanceof Error ? e.message : String(e)}\n`);
    });
  }

  /** Make sure this connection is subscribed to `threadId` before a turn
   *  starts on it. A still-loaded thread is rejoined as it is (a bare
   *  resume, so its tools and instructions survive); one the server has
   *  unloaded is resumed with the peer's resume instructions, which say the
   *  consult tool is gone. Returns the mode the thread runs under, from the
   *  server's own answer. */
  async function ensureSubscribed(
    threadId: string,
    resumeParams: Record<string, unknown>,
    /** Rejoin only a thread the server still holds loaded; never resume
     *  (and take the writer lock of) one it does not. */
    opts: { onlyIfLoaded?: boolean } = {},
  ): Promise<Record<string, unknown> | null> {
    if (subscribedThreads.has(threadId)) return null;
    // Whether the server holds the thread loaded matters only when there
    // is something to override (ignored on a loaded thread) or when an
    // unloaded thread must not be resumed: a bare resume is right either way.
    let loaded = false;
    if (Object.keys(resumeParams).length > 0 || opts.onlyIfLoaded) {
      try {
        const list = await appClient.request<{ data?: unknown }>("thread/loaded/list", {});
        loaded = Array.isArray(list?.data) && list.data.includes(threadId);
      } catch { /* older server: treat as unloaded and send the instructions */ }
    }
    if (opts.onlyIfLoaded && !loaded) return null;
    const result = await appClient.request<Record<string, unknown>>(
      "thread/resume",
      loaded ? { threadId } : { threadId, ...resumeParams },
    );
    subscribedThreads.add(threadId);
    return result;
  }

  /** Tell the peer a thread's turn is over, on the NEXT tick. Deferring is
   *  the point: the hook can claim the thread and start a replacement turn,
   *  and every releaseThread caller — including the peer's own turn-start
   *  failure path — must finish unwinding before that happens. Running it
   *  inline re-enters the peer mid-cleanup, and the cleanup then tears down
   *  the replacement's state. */
  function notifyTurnEnded(threadId: string): void {
    if (shutdownInitiated) return;
    setImmediate(() => {
      if (shutdownInitiated) return;
      try {
        peer.onThreadTurnEnded(threadId);
      } catch (e) {
        process.stderr.write(`[broker-server] peer turn-ended hook failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    });
  }

  /** The goal on `threadId` left `active`. If the entry was retained across
   *  a turn boundary awaiting a continuation that now will not start,
   *  release it. */
  function onGoalInactive(threadId: string): void {
    goalActiveThreads.delete(threadId);
    const entry = threads.get(threadId);
    if (entry?.awaitingContinuation) releaseThread(threadId);
  }

  /** Learn goal state from request/response traffic passing through the
   *  broker. Notifications cover goals that CHANGE, but a goal that
   *  predates every client (resumed goal-mode thread) may never fire one
   *  before the first turn/completed — the goal-following client's own
   *  pre-turn thread/goal/get is then the broker's only signal to retain
   *  ownership across the continuation turns. */
  function learnGoalFromTraffic(method: unknown, params: unknown, result: unknown): void {
    if (method === "thread/goal/get" || method === "thread/goal/set") {
      const goal = (result as { goal?: { threadId?: unknown; status?: unknown } } | undefined)?.goal;
      if (!goal || typeof goal.threadId !== "string") return;
      if (goal.status === "active") {
        goalActiveThreads.add(goal.threadId);
      } else {
        onGoalInactive(goal.threadId);
      }
    } else if (method === "thread/goal/clear") {
      const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId === "string") onGoalInactive(threadId);
    }
  }

  /** Arm the per-thread watchdog after its owner disconnected mid-turn. If
   *  turn/completed doesn't arrive, interrupt the orphaned turn and free the
   *  thread so same-thread starts stop bouncing off a dead reservation.
   *  Interrupt failures are informational: an RpcError means the app-server
   *  is alive and the turn is simply gone already (release is correct); a
   *  transport-level failure means the app-server connection itself broke,
   *  and appClient.onClose is already shutting the broker down. */
  function armOrphanWatchdog(threadId: string, entry: ThreadEntry): void {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    entry.watchdog = setTimeout(() => {
      entry.watchdog = null;
      // The whole timer body must be guarded — Bun and Node 15+ treat
      // unhandled rejections as fatal by default, and the broker is long-
      // lived, so any escape here would kill it.
      void (async () => {
        // Completed naturally, or reclaimed — nothing to do.
        if (threads.get(threadId) !== entry || entry.socket !== null) return;
        // A joined claim never owned its turn: nothing to interrupt or pause.
        if (entry.joined) { releaseThread(threadId); return; }
        if (entry.turnId) {
          process.stderr.write(`[broker-server] Orphan-turn watchdog firing — interrupting ${threadId}\n`);
          // Goal first, interrupt second (same order as `kill`): with an
          // active goal, interrupt alone just makes the server start a
          // fresh continuation turn — headless, with no owner to route to.
          // Pausing keeps the goal resumable by a later turn.
          if (goalActiveThreads.has(threadId)) {
            try {
              await appClient.request("thread/goal/set", { threadId, status: "paused" });
            } catch (e) {
              process.stderr.write(`[broker-server] Warning: could not pause orphaned goal on ${threadId}: ${e instanceof Error ? e.message : String(e)}\n`);
            }
          }
          // Settled from here on: the interrupt is only an acknowledgement,
          // so this turn's completion may still arrive — after the thread
          // has been released and possibly re-claimed. Recording it now is
          // what lets that late completion be recognized as stale.
          markTurnEnded(threadId, entry.turnId);
          try {
            await appClient.request("turn/interrupt", { threadId, turnId: entry.turnId });
          } catch (e) {
            process.stderr.write(`[broker-server] Warning: orphan-turn interrupt failed for ${threadId}/${entry.turnId}: ${e instanceof Error ? e.message : String(e)}\n`);
          }
        }
        // Release iff still ours: turn/completed may have raced the
        // interrupt and released already, and a new owner may have claimed.
        if (threads.get(threadId) === entry && entry.socket === null) {
          releaseThread(threadId);
        }
      })().catch((e) => {
        // Catch-of-last-resort: if the body throws unexpectedly, the thread
        // would otherwise stay reserved until idle timeout. Releasing here
        // recovers the slot; logging surfaces the bug.
        process.stderr.write(`[broker-server] Watchdog body crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`);
        if (threads.get(threadId) === entry && entry.socket === null) {
          releaseThread(threadId);
        }
      });
    }, ORPHAN_WATCHDOG_MS);
    entry.watchdog.unref?.();
    // Keep the broker alive long enough for the watchdog to run. Registering
    // the idle timer after the watchdog means equal deadlines run watchdog
    // recovery first instead of shutting the broker down before it can clean up.
    resetIdleTimer();
  }

  // ─── Notification routing ───────────────────────────────────────────────

  // Forward every notification the app-server sends — including methods we
  // don't know about — by threadId to the socket owning that thread. An
  // allowlist would silently drop new protocol notifications added by Codex.
  // Notifications without a threadId are genuinely global (account, skills,
  // MCP status, …) and broadcast to every connected socket.
  function routeNotification(method: string, notifParams: unknown): void {
    resetIdleTimer();
    const params = notifParams as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;

    // A peer claim still settling on a shared server: whose turn these
    // events describe is not known yet. Hold them — before the ended-turn
    // bookkeeping below, which must not settle a turn that may be ours.
    if (threadId && appClient.server.kind === "shared") {
      const entry = threads.get(threadId);
      if (entry?.settling) {
        const held = settlingBuffers.get(threadId) ?? [];
        if (method.endsWith("/delta")) {
          const n = settlingDeltas.get(threadId) ?? 0;
          if (n < MAX_SETTLING_DELTAS) { held.push({ method, params: notifParams }); settlingDeltas.set(threadId, n + 1); }
        } else {
          held.push({ method, params: notifParams });
        }
        settlingBuffers.set(threadId, held);
        // A claim the server would not be read for learns its turn from
        // the turn's own announcement.
        if (entry.undecided && method === "turn/started" && entry.turnId
          && (params as { turn?: { id?: unknown } } | undefined)?.turn?.id === entry.turnId) {
          settleClaim(threadId, entry, { as: "own", turnId: entry.turnId });
        }
        return;
      }
    }

    // Drop a completion that belongs to an already-settled turn before it
    // can be routed or acted on: the thread may have changed hands since.
    // Settled-ness is tracked explicitly — every path that abandons a turn
    // records it: the watchdog before interrupting, the streaming failure
    // path before releasing, and this guard when a completion passes. That
    // coverage is what makes the id check below unnecessary. Do NOT
    // additionally reject a completion for not
    // matching the thread's CURRENT turn: a thread can legitimately carry
    // more than one turn. Codex runs a review inline on the parent thread,
    // announcing an inner turn whose turn/started retargets entry.turnId,
    // and the review's own completion then arrives under the id the claim
    // was made for. Rejecting it stranded every review — the client waits
    // on exactly that id, and the thread is never released either.
    if (method === "turn/completed" && threadId) {
      const endedId = (params?.turn as { id?: unknown } | undefined)?.id;
      if (typeof endedId === "string") {
        if (turnAlreadyEnded(threadId, endedId)) return;
        markTurnEnded(threadId, endedId);
      }
    }

    if (threadId) {
      const entry = threads.get(threadId);
      if (entry) {
        if (entry.socket instanceof net.Socket) {
          if (!entry.socket.destroyed) send(entry.socket, { method, params: notifParams });
        } else if (entry.socket) {
          entry.socket.onNotification(method, notifParams as Record<string, unknown> | undefined);
        }
        // Orphan sentinel (socket null): drop the payload, but fall through —
        // lifecycle tracking below must still see turn/completed.
      } else if (pendingReviewCount > 0) {
        // Unowned thread while a review/start response is pending: this is
        // (most likely) the review subthread announcing itself before the
        // response names it. Buffer until the response claims the thread —
        // guessing a recipient would leak one review's output into another
        // review's socket when two run concurrently.
        bufferUnclaimed(threadId, method, notifParams);
      }
    } else {
      for (const socket of sockets) {
        send(socket, { method, params: notifParams });
      }
    }

    // ── Lifecycle tracking ──

    // A request of the thread's was answered by another client first (on a
    // shared server the first answer wins): a consult the peer is still
    // relaying was settled without Claude's answer, which the peer then
    // delivers another way.
    if (method === "serverRequest/resolved" && threadId) {
      const rid = (params as { requestId?: unknown } | undefined)?.requestId;
      const requestId = typeof rid === "string" || typeof rid === "number" ? String(rid) : null;
      if (requestId !== null) retireHeldRequest(threadId, requestId);
      try { peer.onRequestResolvedElsewhere(threadId, requestId); } catch { /* best-effort */ }
    }

    // Track goal state per thread — it decides whether turn/completed
    // releases the thread (see goalActiveThreads).
    if (method === "thread/goal/updated") {
      const p = params as { threadId?: unknown; goal?: { status?: unknown } } | undefined;
      if (typeof p?.threadId === "string") {
        if (p.goal?.status === "active") {
          goalActiveThreads.add(p.threadId);
        } else {
          onGoalInactive(p.threadId);
        }
      }
    } else if (method === "thread/goal/cleared") {
      const p = params as { threadId?: unknown } | undefined;
      if (typeof p?.threadId === "string") onGoalInactive(p.threadId);
    }

    // turn/started names the turn actually running on the thread. For a
    // fresh claim this fills in the turnId the request-time claim lacked;
    // for a goal continuation it re-targets orphan bookkeeping at the
    // CURRENT turn, not the long-finished first one.
    if (method === "turn/started" && threadId) {
      const entry = threads.get(threadId);
      const turn = params?.turn as Record<string, unknown> | undefined;
      if (entry && typeof turn?.id === "string") {
        entry.turnId = turn.id;
        entry.awaitingContinuation = false;
      }
    }

    // turn/completed releases the thread — unless an active goal is about to
    // start a continuation turn for a still-connected owner.
    if (method === "turn/completed" && threadId) {
      const entry = threads.get(threadId);
      if (entry) {
        // Internal owners live as long as the broker itself, so they count
        // as connected for goal retention.
        const ownerConnected = entry.socket !== null &&
          (!(entry.socket instanceof net.Socket) || sockets.has(entry.socket));
        // A joined claim stood for another client's turn, and any goal
        // driving continuations on the thread is theirs too: the claim ends
        // with the turn rather than following the goal.
        const goalContinues =
          goalActiveThreads.has(threadId) && ownerConnected && !entry.joined;
        if (goalContinues) {
          // Between turns now — if the goal is paused/cleared before the
          // continuation starts, onGoalInactive frees the entry.
          entry.awaitingContinuation = true;
          entry.turnId = null;
        } else {
          releaseThread(threadId);
        }
      } else {
        // No entry (e.g. a peer-claimed turn whose claim was already
        // released): still settle any pending mid-turn message.
        notifyTurnEnded(threadId);
      }
    }
  }
  appClient.onAny(routeNotification);

  /** The settling peer claim on `threadId` now stands for `turnId`: replay
   *  what was held for that turn, in order, and drop the rest — events of
   *  a turn that was never ours, or a turn-less notification whose moment
   *  has passed. */
  function replaySettled(
    threadId: string,
    turnId: string | null,
    forwardOthersTo: net.Socket | null = null,
    /** False: the claim owns nothing here; every held event is merely
     *  forwarded, none drives the lifecycle. */
    attribute = true,
    /** The claim's turn is its own: every event since the submission is
     *  the thread's own story — our turn, and any goal continuation that
     *  followed it — and drives the lifecycle whatever id it carries.
     *  Only events from before the submission are judged by id. */
    ownedFrom: number | null = null,
  ): void {
    const held = settlingBuffers.get(threadId);
    settlingBuffers.delete(threadId);
    settlingDeltas.delete(threadId);
    if (!held) return;
    const idOf = (n: { params: unknown }): string | null => {
      const p = n.params as { turn?: { id?: unknown }; turnId?: unknown } | undefined;
      return typeof p?.turn?.id === "string" ? p.turn.id : (typeof p?.turnId === "string" ? p.turnId : null);
    };
    // The thread's own story begins where our turn first appears: what
    // came before it since the submission — a predecessor's completion,
    // say — is judged by id, or it would end the claim before its turn
    // even started. A continuation can only follow our turn.
    const ownStart = ownedFrom === null || turnId === null
      ? -1
      : held.findIndex((n, index) => index >= ownedFrom && idOf(n) === turnId);
    held.forEach((n, index) => {
      const id = idOf(n);
      const owned = ownStart !== -1 && index >= ownStart;
      // No turn id to attribute by (a start that failed after announcing a
      // turn, an inline review completing before its response): the events
      // drive the lifecycle in full, as they did before claims settled.
      if (!attribute || (!owned && turnId !== null && id !== null && id !== turnId)) {
        if (forwardOthersTo && !forwardOthersTo.destroyed) send(forwardOthersTo, { method: n.method, params: n.params });
        return;
      }
      routeNotification(n.method, n.params);
    });
  }

  /** Among the events held for a settling claim, a turn that was seen to
   *  start and finish while the claim's own turn id never appeared: the
   *  peer's input was absorbed into it, and it is already over. */
  function foreignCompletionsIn(held: Array<{ method: string; params: unknown }>, ownId: string | null): string[] {
    const started = new Set<string>();
    const completed: string[] = [];
    for (const n of held) {
      const id = (n.params as { turn?: { id?: unknown } } | undefined)?.turn?.id;
      if (typeof id !== "string") continue;
      if (n.method === "turn/started") started.add(id);
      if (n.method === "turn/completed") completed.push(id);
    }
    if (ownId && started.has(ownId)) return [];
    return completed.filter((id) => id !== ownId);
  }

  /** Forward a server-initiated request to a client socket and await its
   *  response via the main data handler (which checks
   *  pendingForwardedRequests). The 1-hour timeout matches the client-side
   *  approval timeout — interactive decisions need human time. */
  function forwardRequestToSocket(
    target: net.Socket,
    method: string,
    reqParams: unknown,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reqId = `broker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingForwardedRequests.delete(reqId);
        reject(new Error("Request forwarding timed out"));
      }, 3_600_000);
      const threadId = (reqParams as { threadId?: unknown } | undefined)?.threadId;
      pendingForwardedRequests.set(reqId, { resolve, reject, timer, target, threadId: typeof threadId === "string" ? threadId : null });
      send(target, { id: reqId, method, params: reqParams });
    });
  }

  // Also forward server-sent requests (like approval requests). These carry
  // threadId, so they route to the owner of the thread that asked.
  const SERVER_REQUEST_METHODS = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ];

  for (const method of SERVER_REQUEST_METHODS) {
    appClient.onRequest(method, async (reqParams, approvalRequestId) => {
      resetIdleTimer();
      const threadId = (reqParams as { threadId?: unknown } | undefined)?.threadId;
      const entry = typeof threadId === "string" ? threads.get(threadId) : undefined;
      // Only client sockets can answer approvals interactively. Peer-owned
      // threads run with approvalPolicy "never", so an approval arriving for
      // one is unexpected — deny it (fail-closed: permission, not judgment).
      // A thread with no claim here is someone else's turn on a shared
      // app-server — the Codex app's or a TUI's — and the request reached
      // us only because we are subscribed to the thread. Stay silent: the
      // first answer settles the request, and a denial from here would
      // override the dialog the user is looking at.
      if (!entry || entry.joined) return NO_RESPONSE;
      if (entry.settling && appClient.server.kind === "shared") {
        return holdUntilSettled(threadId as string, () => {
          const now = threads.get(threadId as string);
          if (!now || now.joined) return NO_RESPONSE;
          if (now.socket instanceof net.Socket && !now.socket.destroyed) return forwardRequestToSocket(now.socket, method, reqParams);
          throw new Error("No active client to forward approval request");
        }, { requestId: approvalRequestId, turnId: (reqParams as { turnId?: unknown } | undefined)?.turnId });
      }
      const target = entry.socket instanceof net.Socket && !entry.socket.destroyed
        ? entry.socket
        : null;
      if (!target) {
        // A settled, non-joined peer claim IS our turn: deny, fail-closed,
        // as before — silence would stall it until its deadline when the
        // thread's approval policy asks a human. (Settling and joined
        // claims returned above: those requests are not ours.)
        throw new Error("No active client to forward approval request");
      }
      return forwardRequestToSocket(target, method, reqParams);
    });
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  /** True iff the socket at our path is the one we bound. Anything else — a
   *  replacement's socket, or nothing — is not ours to remove. */
  function socketIsStillOurs(): boolean {
    if (listenInode === null) return false;
    try { return fs.statSync(listenTarget.path).ino === listenInode; } catch { return false; }
  }

  async function shutdown(server: net.Server): Promise<void> {
    shutdownInitiated = true;
    if (idleTimer) clearTimeout(idleTimer);
    // Stop ACCEPTING first, before anything below is awaited — the stops
    // on a shared server, the app-server close, either can run for
    // seconds. A client connecting meanwhile would pass the liveness
    // probe, complete the broker-local initialize, then fail its first
    // forwarded request with no fallback; refusing the connection sends
    // it down the direct path instead. And a turn started here after the
    // stops were decided would outlive the broker unstopped: new
    // streaming requests are refused too (see processMessage). The
    // listener's own close completes once existing sockets drain, which
    // is awaited at the end.
    let listenerClosed: Promise<void>;
    try {
      listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      listenerClosed = Promise.resolve(); // already closed (double shutdown)
    }
    // A private app-server dies with this broker and takes its turns with
    // it. A shared one keeps running everything: stop the turns that are
    // ours — a goal paused first, so the interrupt does not spawn a
    // headless continuation — and leave joined turns, other clients'
    // work and the server itself untouched.
    // The peer takes in nothing new from here on, and submits no more
    // turns: one submitted during the wait below would be skipped by the
    // stops as undecided, and run on after the broker is gone.
    peer.quiesce();
    if (appClient.server.kind === "shared") {
      // A start still in flight decides whether its turn is ours to stop:
      // give it a moment to answer and settle before deciding anything.
      const settleBy = Date.now() + 5000;
      while (Date.now() < settleBy && [...threads.values()].some((e) => e.settling)) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    peer.stop();
    if (appClient.server.kind === "shared") {
      const stops: Array<Promise<void>> = [];
      for (const [threadId, entry] of threads) {
        if (entry.joined || entry.settling) continue;
        const turnId = entry.turnId; // null between goal turns: still ours to pause
        stops.push((async () => {
          if (goalActiveThreads.has(threadId)) {
            await appClient.request("thread/goal/set", { threadId, status: "paused" }).catch(() => undefined);
          }
          if (turnId) await appClient.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        })());
      }
      await Promise.race([Promise.all(stops), new Promise((r) => setTimeout(r, 5000))]);
    }
    for (const [threadId] of threads) releaseThread(threadId);

    // Reject all pending forwarded requests before closing sockets
    for (const [reqId, entry] of pendingForwardedRequests) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Broker shutting down"));
      pendingForwardedRequests.delete(reqId);
    }
    for (const socket of sockets) {
      socket.end();
    }
    try {
      await appClient.close();
    } catch (e) {
      process.stderr.write(`[broker-server] Warning: app-server close failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    // Bound the close wait: a client that never drains its half-closed socket
    // (or a platform quirk that drops the close callback) must not wedge
    // shutdown — the signal/idle paths that call this expect to reach
    // process.exit(). Destroy stragglers once the grace period lapses.
    await Promise.race([
      listenerClosed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve();
        }, 2000);
      }),
    ]);
    if (listenTarget.kind === "unix" && socketIsStillOurs()) {
      try {
        fs.unlinkSync(listenTarget.path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          process.stderr.write(
            `[broker-server] Warning: socket cleanup failed: ${(e as Error).message}\n`,
          );
        }
      }
    }
  }

  // ─── Approval response fast-path ─────────────────────────────────────

  // Routes approval responses synchronously, bypassing the per-socket message
  // queue. This prevents deadlocks when a client's approval response is queued
  // behind an RPC request that the app-server can't complete until the approval
  // is received.
  function tryRouteApprovalResponse(socket: net.Socket, parsed: Record<string, unknown>): boolean {
    if (typeof parsed !== "object" || parsed === null) return false;
    // Approval responses have id but no method
    if (parsed.id === undefined || "method" in parsed) return false;
    const reqId = String(parsed.id);
    const entry = pendingForwardedRequests.get(reqId);
    if (!entry) return false; // Not a pending forwarded request — let the queue handle it
    resetIdleTimer();
    if (entry.target !== socket) {
      process.stderr.write(
        `[broker-server] Warning: forwarded response id=${reqId} from wrong socket — ignoring\n`,
      );
      return true;
    }
    pendingForwardedRequests.delete(reqId);
    clearTimeout(entry.timer);
    if ("result" in parsed) {
      entry.resolve(parsed.result);
    } else if ("error" in parsed) {
      const errObj = parsed.error as Record<string, unknown> | undefined;
      const code = typeof errObj?.code === "number" ? errObj.code : -32000;
      const message = (errObj?.message as string) ?? "Client error";
      // Preserve the JSON-RPC code so the app-server (and any inspecting
      // client) sees the original error class, not a generic -32000.
      const err = new Error(message) as Error & { code: number; data?: unknown };
      err.code = code;
      if (errObj && "data" in errObj) err.data = errObj.data;
      entry.reject(err);
    } else {
      entry.reject(new Error("Malformed forwarded response: missing both 'result' and 'error'"));
    }
    return true;
  }

  /** Retry a rejected turn/interrupt against the turn the server says is
   *  actually active, but only for the client that owns the thread. Returns
   *  the successful result, or null to let the original error through. */
  async function retargetInterrupt(
    socket: net.Socket,
    params: Record<string, unknown> | undefined,
    error: unknown,
  ): Promise<{ result: unknown } | null> {
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return null;
    const entry = threads.get(threadId);
    if (!entry || entry.socket !== socket) return null;
    // A joined claim's active turn is another client's, and an undecided
    // one's may be: the turn the server names is not this caller's to stop.
    if (entry.joined || entry.settling) return null;
    const message = error instanceof Error ? error.message : String(error);
    const found = /expected active turn id \S+ but found (\S+)/.exec(message)?.[1];
    if (!found || found === params?.turnId) return null;
    // On a shared server the turn the server names may be anyone's: only
    // one this claim was told of (its own, or a continuation of it) is
    // this caller's to stop.
    if (appClient.server.kind === "shared" && found !== entry.turnId) return null;
    try {
      return { result: await appClient.request("turn/interrupt", { threadId, turnId: found }) };
    } catch {
      return null; // the original error is the more useful one to report
    }
  }

  /** A turn was announced for a request that then failed, so it runs with
   *  nobody listening. Hold the reservation, interrupt the turn, and let
   *  turn/completed — or the watchdog, on a turn that never tears down —
   *  release it. If the server does not know the turn, nothing is running
   *  after all: release now rather than block the thread for half an hour
   *  over a turn that never existed. */
  async function orphanUnheardTurn(threadId: string, entry: ThreadEntry): Promise<void> {
    if (!entry.turnId) return;
    if (entry.joined) { releaseThread(threadId); return; } // another client's turn
    entry.socket = null;
    entry.settling = false;
    armOrphanWatchdog(threadId, entry);
    try {
      await appClient.request("turn/interrupt", { threadId, turnId: entry.turnId });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (/not found|no active turn|not running/i.test(detail)) {
        markTurnEnded(threadId, entry.turnId);
        releaseThread(threadId);
      } else {
        process.stderr.write(
          `[broker-server] Warning: could not interrupt turn ${entry.turnId} after its request failed: ${detail}\n`,
        );
      }
    }
  }

  // ─── Streaming request settlement ──────────────────────────────────────

  /** A streaming request's response (or error) arrived. Fill in what only
   *  the response knows (turnId, review subthread), and run orphan recovery
   *  if the initiator disconnected while the request was in flight — this
   *  path, not the close handler, owns that window because only it learns
   *  the turnId to interrupt.
   *
   *  `claimed` is the entry THIS request created. Every mutation is guarded
   *  by an identity check against the live map: after a fast turn releases
   *  the claim, another client can claim the same thread before this
   *  response settles, and touching the map's current entry would corrupt
   *  the new owner's state (clear its requestPending, install our turnId,
   *  or release its live claim). */
  async function settleStreamingRequest(
    socket: net.Socket,
    method: string,
    params: Record<string, unknown> | undefined,
    result: Record<string, unknown> | null,
    claimed: ThreadEntry | null,
  ): Promise<{ absorbedBy: string | null } | undefined> {
    const parentThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    const entry = parentThreadId && claimed && threads.get(parentThreadId) === claimed
      ? claimed
      : undefined;

    if (result === null) {
      // Request failed. Usually no turn started — but turn/started is a
      // notification and can land BEFORE the RPC settles, so the server may
      // be running a turn this failed request will never report.
      if (entry && entry.requestPending) {
        entry.requestPending = false;
        entry.settling = false;
        // On a shared server a turn announced while the failed start was out
        // cannot be told from another client's: it must not become this
        // claim's — and be interrupted as abandoned — on the strength of a
        // notification alone. Hand the events on, own nothing, let go.
        const unattributable = appClient.server.kind === "shared" && !entry.turnId;
        replaySettled(parentThreadId!, entry.turnId, entry.socket instanceof net.Socket ? entry.socket : null, !unattributable);
        settleHeldRequests(parentThreadId!, false);
        if (!entry.turnId) {
          // Nothing was ever announced (or nothing attributable): no turn to worry about.
          releaseThread(parentThreadId!);
          return;
        }
        // A turn WAS announced and its initiator has just been handed an
        // error, so nobody is listening to it. Releasing the thread here
        // would let a retry start a second turn beside one that is still
        // running and still editing the workspace, unobserved. Treat it as
        // an orphan — the same handling an initiator that disconnected
        // mid-request gets, for the same reason.
        await orphanUnheardTurn(parentThreadId!, entry);
      }
      return;
    }

    const turn = result?.turn as Record<string, unknown> | undefined;
    // turn/steer answers with the joined turn's id at the top level.
    const turnId = typeof turn?.id === "string"
      ? turn.id
      : (typeof result?.turnId === "string" ? result.turnId : null);
    // review/start runs the turn on a distinct review subthread that only
    // the response names; interrupting the parent is a no-op.
    const reviewThreadId = method === "review/start" && typeof result?.reviewThreadId === "string"
      ? (result.reviewThreadId as string)
      : null;

    if (!entry) {
      // Fast turn: turn/completed already landed and released the claim
      // while the response was in flight (or another client has since
      // claimed the thread — not ours to touch). For a review, the
      // subthread may still need claiming below.
      if (!reviewThreadId) return;
    } else {
      entry.requestPending = false;
      if (!reviewThreadId && entry.turnId === null && turnId) entry.turnId = turnId;
      if (entry.settling) {
        // On a shared server the start may have been absorbed into a turn
        // another client began meanwhile — one that may still be running,
        // and whose requests are held here. Decide before answering any,
        // and tell the client in the answer, which spares it the reads.
        if (method === "turn/start" && appClient.server.kind === "shared") {
          const verdict = await verdictAfterStart(parentThreadId!, turnId);
          if (threads.get(parentThreadId!) !== entry) return; // released meanwhile
          if (verdict.undecided) {
            // The server would not say: the claim keeps settling (events
            // and requests held, nothing stopped for it) while the read is
            // retried; the client decides for itself meanwhile.
            reverdictLater(parentThreadId!, entry, turnId, 1);
            return undefined;
          }
          settleClaim(parentThreadId!, entry, verdict.absorbedBy
            ? { as: "joined", turnId: verdict.absorbedBy }
            : { as: "own", turnId });
          return { absorbedBy: verdict.absorbedBy };
        }
        settleClaim(parentThreadId!, entry, { as: method === "turn/steer" ? "joined" : "own", turnId: entry.turnId });
      }
    }

    let reviewEntry: ThreadEntry | null = null;
    if (reviewThreadId) {
      // The turn runs on the subthread; the parent carried no turn at all.
      // Release the parent claim NOW rather than at socket close — holding
      // it would block same-thread turns for the connection's whole life.
      if (entry) releaseThread(parentThreadId!);

      // An inline review runs on the parent thread itself. If its completion
      // landed before this response, it was routed through the parent claim
      // and released it — recreating a claim for a finished turn would hold
      // the thread until the watchdog.
      if (!threads.has(reviewThreadId) && !(turnId && turnAlreadyEnded(reviewThreadId, turnId))) {
        reviewEntry = {
          socket: entry ? entry.socket : socket.destroyed ? null : socket,
          turnId,
          requestPending: false,
          awaitingContinuation: false,
          watchdog: null,
        };
        threads.set(reviewThreadId, reviewEntry);
      }

      // Flush notifications that arrived before this response named the
      // subthread, in order, to the owner — then apply the lifecycle they
      // carry: a buffered turn/completed means the review already finished
      // and the fresh claim must be released immediately, or nothing ever
      // would release it.
      const buffered = unclaimedNotifications.get(reviewThreadId);
      unclaimedNotifications.delete(reviewThreadId);
      if (buffered && reviewEntry) {
        const owner = reviewEntry.socket;
        let completed = false;
        for (const n of buffered) {
          if (owner instanceof net.Socket && !owner.destroyed) {
            send(owner, { method: n.method, params: n.params });
          }
          if (n.method === "turn/completed") completed = true;
        }
        if (completed) {
          releaseThread(reviewThreadId);
          reviewEntry = null;
        }
      }
    }

    // Initiator gone: the turn started with nobody listening. Interrupt it
    // now that the turnId is known, keep the reservation, and let
    // turn/completed (or the watchdog, on a stuck turn) release it. A
    // successful interrupt RPC only acknowledges receipt — it does not
    // guarantee the turn is fully torn down.
    const orphanEntry = reviewThreadId ? reviewEntry : entry;
    const orphanThreadId = reviewThreadId ?? parentThreadId;
    if (orphanEntry && orphanEntry.socket === null && orphanThreadId && orphanEntry.joined) {
      // The initiator left a turn it had only joined: the turn is another
      // client's and keeps running for them. Just free the claim.
      releaseThread(orphanThreadId);
    } else if (orphanEntry && orphanEntry.socket === null && orphanThreadId) {
      // The response's turn id is authoritative for the turn this request
      // started.
      const interruptTurnId = turnId ?? orphanEntry.turnId;
      armOrphanWatchdog(orphanThreadId, orphanEntry);
      if (interruptTurnId) {
        try {
          await appClient.request("turn/interrupt", { threadId: orphanThreadId, turnId: interruptTurnId });
        } catch (e) {
          process.stderr.write(
            `[broker-server] Warning: failed to interrupt orphaned turn ${interruptTurnId}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
          // Reservation already in place — watchdog continues to guard.
        }
      }
    }
  }

  // ─── Per-socket message handler ────────────────────────────────────────

  // Processes a single JSON-RPC message from a client socket. Extracted from
  // the data handler so messages can be chained via a per-socket Promise
  // queue, preventing async reentrancy on the shared buffer. The message is
  // parsed once in the data handler and shared with the approval fast-path.
  async function processMessage(socket: net.Socket, message: Record<string, unknown>): Promise<void> {
    resetIdleTimer();

    // Handle initialize locally — don't forward to app-server
    if (message.id !== undefined && message.method === "initialize") {
      send(socket, {
        id: message.id,
        result: {
          userAgent: "codex-collab-broker",
          // Thread-scoped routing: the broker as a whole is never busy.
          // Same-thread contention is reported per request with -32001.
          busy: false,
          // Which app-server this broker runs turns on, for `health`.
          server: appClient.server,
        },
      });
      return;
    }

    // Swallow initialized notification
    if (message.method === "initialized" && message.id === undefined) {
      return;
    }

    const params = message.params as Record<string, unknown> | undefined;

    // Handle broker/shutdown. `ifIdle` makes it conditional: a replacement
    // (`peer up`) must not kill a turn that claimed a thread after the
    // caller looked — only the broker knows, so only the broker decides.
    if (message.id !== undefined && message.method === "broker/shutdown") {
      const ifIdle = (params as { ifIdle?: unknown } | undefined)?.ifIdle === true;
      if (ifIdle && (threads.size > 0 || inflightRequests > 0 || pendingForwardedRequests.size > 0)) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "A turn is running on this broker."),
        });
        return;
      }
      send(socket, { id: message.id, result: {} });
      await shutdown(server);
      process.exit(0);
    }

    // An interrupt from a client whose claim only joined another client's
    // turn — or is still undecided — names a turn that is not its to stop:
    // refused here rather than sent on, where a stale id would be
    // retargeted onto whatever runs.
    if (message.id !== undefined && message.method === "turn/interrupt") {
      const tid = typeof params?.threadId === "string" ? params.threadId : null;
      const entry = tid ? threads.get(tid) : undefined;
      const namesClaimedTurn = !!entry && typeof params?.turnId === "string" && params.turnId === entry.turnId;
      // From the claim's own socket, or from anyone naming the turn the
      // claim only joined (a `kill` on its own connection, say).
      if (entry && (entry.joined || entry.settling) && (entry.socket === socket || namesClaimedTurn)) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(-32000, "The turn running on this thread belongs to another client of the shared app-server; it was not interrupted."),
        });
        return;
      }
    }

    // Handle broker/joined: a client's turn/start was absorbed into a turn
    // another client had started meanwhile (see startOrJoinTurn). Its
    // claim now stands for that turn, as a join — never to be interrupted.
    if (message.id !== undefined && message.method === "broker/joined") {
      const p = params as { threadId?: unknown; turnId?: unknown } | undefined;
      const entry = typeof p?.threadId === "string" ? threads.get(p.threadId) : undefined;
      if (entry && entry.socket === socket) {
        const turnId = typeof p?.turnId === "string" ? p.turnId : null;
        if (entry.settling) {
          settleClaim(p!.threadId as string, entry, { as: "joined", turnId });
        } else {
          entry.joined = true;
          if (turnId) entry.turnId = turnId;
          retireForwards(socket, p!.threadId as string);
        }
      }
      send(socket, { id: message.id, result: { joined: !!entry && entry.socket === socket } });
      return;
    }

    // Handle broker/cancelJoined: `kill` on a conversation whose message
    // joined another client's turn. The peer's wait ends and its claim is
    // released; the turn itself is not touched.
    if (message.id !== undefined && message.method === "broker/cancelJoined") {
      const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
      const entry = typeof threadId === "string" ? threads.get(threadId) : undefined;
      const cancelled = typeof threadId === "string" && !!entry && (entry.joined || entry.settling)
        && entry.socket !== null && !(entry.socket instanceof net.Socket)
        && peer.cancelJoinedWait(threadId);
      // A settling attempt keeps its claim: it may already have submitted a
      // turn, which it stops itself once the request answers.
      if (cancelled && !entry!.settling) releaseThread(threadId as string);
      send(socket, { id: message.id, result: { cancelled } });
      return;
    }

    // Ignore notifications (no id) from clients
    if (message.id === undefined) {
      return;
    }

    // Responses (id + result/error, no method) that reach the queue were
    // already checked against pendingForwardedRequests by the fast-path in
    // the data handler, which consumes every match — so this can only be an
    // unknown or expired forwarded-request id.
    if (message.id !== undefined && !("method" in message)) {
      process.stderr.write(
        `[broker-server] Warning: received response for unknown/expired forwarded request id=${String(message.id)}\n`,
      );
      return;
    }

    const method = message.method as string;

    // ─── Same-thread contention ───────────────────────────────

    // A streaming method claims its thread at REQUEST time — the threadId is
    // in the params, and claiming before forwarding means notifications that
    // race the response (turn/started, even turn/completed for a fast turn)
    // always find an owner. A thread already claimed by anyone (including an
    // orphan sentinel still unwinding) refuses a second stream.
    const isStreaming = STREAMING_METHODS.has(method);
    const streamThreadId = isStreaming && typeof params?.threadId === "string"
      ? params.threadId
      : null;

    if (isStreaming && shutdownInitiated) {
      // Nothing new starts on a broker that is stopping: a turn started
      // now would be released unstopped when the stops already decided
      // are done — and on a shared server it would run on without us.
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(-32000, "The broker is shutting down; nothing new is started here. Retry in a moment."),
      });
      return;
    }
    if (streamThreadId && threads.has(streamThreadId)) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(
          BROKER_BUSY_RPC_CODE,
          "A turn is already running on this thread.",
        ),
      });
      return;
    }

    let claimed: ThreadEntry | null = null;
    if (streamThreadId) {
      claimed = {
        socket,
        turnId: null,
        requestPending: true,
        awaitingContinuation: false,
        watchdog: null,
        joined: method === "turn/steer",
        // Until the response names the turn, another client's completion on
        // a shared server must neither reach this client nor release the
        // claim; the response settles it (see settleStreamingRequest).
        settling: appClient.server.kind === "shared",
        submittedAt: 0,
        submittedInput: inputTexts(params?.input),
      };
      threads.set(streamThreadId, claimed);
      // The thread may have been released (unsubscribed) since the client
      // resumed it — a failed steer's fallback lands here. A turn on an
      // unsubscribed thread streams nothing back, so re-subscribe first.
      if (!subscribedThreads.has(streamThreadId)) {
        try {
          await ensureSubscribed(streamThreadId, {});
        } catch (e) {
          process.stderr.write(`[broker-server] Warning: could not re-subscribe to ${streamThreadId} before ${method}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
    if (isStreaming && method === "review/start") {
      pendingReviewCount++;
    }

    // ─── Request forwarding (concurrent — no global lock) ─────

    inflightRequests++;
    try {
      const result = await appClient.request(method, params ?? {});
      learnGoalFromTraffic(method, params, result);

      // A CLI client just created or resumed a thread: give it a peer
      // address too, so `run` does not foreclose ever messaging that
      // conversation. Peer-created threads bypass this path entirely
      // (the peer calls the app-server directly), so there is no double
      // registration.
      if (method === "thread/start" || method === "thread/resume") {
        const thread = (result as { thread?: { id?: unknown } } | undefined)?.thread;
        if (typeof thread?.id === "string") subscribedThreads.add(thread.id);
        const adopt = adoptionFor(thread?.id, params);
        if (adopt) peer.adoptThread(adopt.threadId, adopt.sandbox);
      } else if (method === "thread/unsubscribe" && typeof params?.threadId === "string") {
        subscribedThreads.delete(params.threadId);
      }
      // A per-turn sandbox override persists in Codex for the turns that
      // follow, so a conversation the peer tracks must record it — its
      // attested from-mode is derived from that record.
      if (method === "turn/start" && streamThreadId && params?.sandboxPolicy !== undefined && peer.ownsThread(streamThreadId)) {
        const mode = sandboxModeOf(params.sandboxPolicy);
        if (mode) peer.noteThreadSandbox(streamThreadId, mode);
      }

      let decided: { absorbedBy: string | null } | undefined;
      if (isStreaming) {
        decided = await settleStreamingRequest(socket, method, params, result as Record<string, unknown>, claimed);
      }

      // The broker's verdict rides on the answer: a client that sees it
      // need not read the thread again.
      send(socket, { id: message.id, result: decided && result && typeof result === "object" ? { ...(result as object), absorbedBy: decided.absorbedBy } : result });
    } catch (error) {
      // A stale interrupt names a turn that has since rotated (context
      // compaction starts a new one), and the rejection names the turn that
      // is active now. Retargeting it is only safe for the client that owns
      // the thread: if the caller's own turn ended and another invocation
      // claimed it, the named turn is that invocation's, and interrupting it
      // cancels work nobody asked to stop. Ownership is only knowable here,
      // which is why the CLI defers this to the broker.
      if (method === "turn/interrupt") {
        const retargeted = await retargetInterrupt(socket, params, error);
        if (retargeted) {
          send(socket, { id: message.id, result: retargeted.result });
          return;
        }
      }
      if (isStreaming) {
        await settleStreamingRequest(socket, method, params, null, claimed);
      }
      send(socket, {
        id: message.id,
        // Forward the server's own message, not our prefixed display form:
        // the client prefixes once more on receipt, and a doubled
        // "JSON-RPC error -32600: JSON-RPC error -32600: …" is what it
        // used to print.
        error: buildJsonRpcError(
          error instanceof RpcError ? error.rpcCode : -32000,
          error instanceof RpcError && error.detail !== undefined ? error.detail : (error as Error).message,
        ),
      });
    } finally {
      if (method === "review/start") {
        pendingReviewCount--;
        // No review pending → any leftover buffer belongs to a review that
        // errored before naming its subthread. Drop it.
        if (pendingReviewCount === 0) unclaimedNotifications.clear();
      }
      inflightRequests--;
      resetIdleTimer();
    }
  }

  // ─── Socket server ─────────────────────────────────────────────────────

  /** Handle a socket going away (close or error): reject its pending
   *  approval forwards and orphan every thread it owns. Threads with a
   *  running turn keep their entry as a sentinel — nulling the socket while
   *  the entry stays blocks same-thread starts until turn/completed clears
   *  it — and arm the watchdog so a stuck/lost completion does not block
   *  forever. Threads whose streaming request is still in flight defer to
   *  the response path, which learns the turnId needed to interrupt. */
  function handleSocketGone(socket: net.Socket): void {
    sockets.delete(socket);
    for (const [reqId, entry] of pendingForwardedRequests) {
      if (entry.target !== socket) continue;
      clearTimeout(entry.timer);
      pendingForwardedRequests.delete(reqId);
      // A request about a turn this client only joined was never its to
      // answer; an error upstream would settle the owner's dialog.
      if (entry.threadId && threads.get(entry.threadId)?.joined) entry.resolve(NO_RESPONSE);
      else entry.reject(new Error("Client disconnected while awaiting approval response"));
    }
    for (const [threadId, entry] of threads) {
      if (entry.socket !== socket) continue;
      entry.socket = null;
      if (entry.requestPending) {
        // settleStreamingRequest will see socket === null and handle it.
        continue;
      }
      if (entry.turnId && !entry.joined) {
        process.stderr.write(`[broker-server] Warning: client disconnected while a turn is active on ${threadId}\n`);
        armOrphanWatchdog(threadId, entry);
      } else {
        // No turn running and no response pending — stale claim.
        releaseThread(threadId);
      }
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    resetIdleTimer();

    let messageQueue: Promise<void> = Promise.resolve();

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_SIZE) {
        process.stderr.write("[broker-server] Client buffer exceeded maximum size, disconnecting\n");
        socket.destroy();
        return;
      }
      // Extract complete lines synchronously to prevent async reentrancy
      // on the shared buffer when multiple data events overlap.
      const lines: string[] = [];
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) lines.push(line);
      }
      for (const line of lines) {
        // Parse once here; both the approval fast-path and the queued
        // handler receive the parsed message.
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch (err) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${(err as Error).message}`),
          });
          continue;
        }
        // Approval responses bypass the queue to prevent deadlocks when
        // queued behind an RPC request awaiting the same approval.
        if (!tryRouteApprovalResponse(socket, message)) {
          // Log unexpected rejections so the queue doesn't silently swallow
          // them; the queue itself recovers because we re-assign with `.then`
          // on the previous (now-resolved) promise.
          messageQueue = messageQueue
            .then(() => processMessage(socket, message))
            .catch((err) => {
              process.stderr.write(`[broker-server] processMessage failed: ${err instanceof Error ? err.message : String(err)}\n`);
            });
        }
      }
    });

    socket.on("close", () => {
      handleSocketGone(socket);
    });

    socket.on("error", (err) => {
      process.stderr.write(`[broker-server] Client socket error: ${err.message}\n`);
      handleSocketGone(socket);
    });
  });

  // ─── Signal handlers ──────────────────────────────────────────────────

  // Only now is it safe to drop the startup guard: until this point a signal
  // would hit the default disposition and orphan the detached app-server,
  // which is the whole race the guard exists to close. Everything between the
  // handshake and here is synchronous today, but that is an accident of
  // layout, not a guarantee.
  process.off("SIGTERM", startupGuard);
  process.off("SIGINT", startupGuard);

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  // ─── Start listening ──────────────────────────────────────────────────

  // Remove stale socket file before listening (Unix only)
  if (listenTarget.kind === "unix") {
    try {
      fs.unlinkSync(listenTarget.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  // Unix sockets: create the file 0o700 atomically by masking group/other
  // bits during bind. The socket is connectable the moment bind() creates it
  // — before the listen callback runs — so the callback's chmod alone leaves
  // a window with default (usually 0o755) permissions that is both a small
  // security gap and an observable race (flaked the permissions test on a
  // slow macOS CI runner).
  const prevUmask = listenTarget.kind === "unix" ? process.umask(0o077) : null;
  server.listen(listenTarget.path, () => {
    // Remember which socket is ours. The path is fixed per workspace, so a
    // replacement can bind it while we are still shutting down — the listener
    // closes first, so our liveness probe fails and the next invocation
    // spawns — and a blind unlink at the end of shutdown would then strand a
    // live broker behind a path with no socket.
    if (listenTarget.kind === "unix") {
      try { listenInode = fs.statSync(listenTarget.path).ino; } catch { listenInode = null; }
    }
    if (prevUmask !== null) process.umask(prevUmask);
    process.stderr.write(
      `[broker-server] Listening on ${endpoint} (idle timeout: ${idleTimeout}ms)\n`,
    );
    if (listenTarget.kind === "unix") {
      chmodSync(listenTarget.path, 0o700); // belt-and-braces; the umask is the real guarantee
    }
  });

  resetIdleTimer();
}

main().catch((error) => {
  process.stderr.write(
    `[broker-server] Fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
