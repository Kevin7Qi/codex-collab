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
import {
  connectDirectWithRetry,
  type AppServerClient,
} from "./client";
import { terminateProcessTree, waitForProcessTreeExit } from "./process";
import { parseEndpoint, BROKER_BUSY_RPC_CODE } from "./broker";
import { RpcError } from "./types";
import { config } from "./config";
import { createPeer, type InternalOwner, type Peer } from "./peer";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Awaiting this parks the caller forever. Used where an async handler is
 *  already on its way to process.exit(): the point is to stop the main flow
 *  advancing in the meantime, not to ever resume. */
const untilProcessExits = (): Promise<never> => new Promise<never>(() => {});

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Methods that start a streaming turn on a thread named in their params —
 *  the socket that initiates one owns that thread until turn/completed. */
const STREAMING_METHODS = new Set(["turn/start", "review/start"]);

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
  const appClient = await connectDirectWithRetry({
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
  }>();
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
    request: (method, params) => appClient.request(method, params ?? {}),
    claimThread: (threadId, owner: InternalOwner) => {
      if (threads.has(threadId)) return false;
      threads.set(threadId, {
        socket: owner,
        turnId: null,
        requestPending: false,
        awaitingContinuation: false,
        watchdog: null,
      });
      return true;
    },
    releaseThread: (threadId) => {
      // Only entries the peer itself owns — a client socket's claim is not
      // the peer's to free.
      const entry = threads.get(threadId);
      if (entry && !(entry.socket instanceof net.Socket)) releaseThread(threadId);
    },
    threadHasTurn: (threadId) => threads.has(threadId),
    log: (line) => process.stderr.write(`[broker-server] ${line}\n`),
  });

  // Dynamic tool calls arrive as server-initiated requests on the shared
  // connection. Route by ownership: the peer answers for its conversations
  // (whoever runs the current turn — a CLI-driven turn on a peer thread
  // still consults through the peer, which declared the tool); any other
  // thread's calls forward to the client socket that owns it, since that
  // client declared whatever tools the thread has. Unknown threads fall
  // back to the peer's fail-open answer.
  appClient.onRequest("item/tool/call", (params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof p.threadId === "string" ? p.threadId : "";
    if (peer.ownsThread(threadId)) return peer.handleToolCall(p);
    const entry = threads.get(threadId);
    if (entry?.socket instanceof net.Socket && !entry.socket.destroyed) {
      return forwardRequestToSocket(entry.socket, "item/tool/call", p);
    }
    return peer.handleToolCall(p);
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

  /** Release a thread entry: clear its watchdog and forget it. */
  function releaseThread(threadId: string): void {
    const entry = threads.get(threadId);
    if (!entry) return;
    if (entry.watchdog) clearTimeout(entry.watchdog);
    threads.delete(threadId);
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
  appClient.onAny((method, notifParams) => {
    resetIdleTimer();
    const params = notifParams as Record<string, unknown> | undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;

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
        const goalContinues =
          goalActiveThreads.has(threadId) && ownerConnected;
        if (goalContinues) {
          // Between turns now — if the goal is paused/cleared before the
          // continuation starts, onGoalInactive frees the entry.
          entry.awaitingContinuation = true;
          entry.turnId = null;
        } else {
          releaseThread(threadId);
        }
      }
    }
  });

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
      pendingForwardedRequests.set(reqId, { resolve, reject, timer, target });
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
    appClient.onRequest(method, async (reqParams) => {
      resetIdleTimer();
      const threadId = (reqParams as { threadId?: unknown } | undefined)?.threadId;
      const entry = typeof threadId === "string" ? threads.get(threadId) : undefined;
      // Only client sockets can answer approvals interactively. Peer-owned
      // threads run with approvalPolicy "never", so an approval arriving for
      // one is unexpected — deny it (fail-closed: permission, not judgment).
      const target = entry?.socket instanceof net.Socket && !entry.socket.destroyed
        ? entry.socket
        : null;
      if (!target) {
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
    peer.stop();
    for (const [threadId] of threads) releaseThread(threadId);
    // Stop ACCEPTING now, before the app-server close below — that close can
    // run for seconds, and a client connecting during it would pass the
    // liveness probe, complete the broker-local initialize, then fail its
    // first forwarded request with no fallback. Refusing the connection sends
    // it down the direct path instead. The listener's own close completes
    // once existing sockets drain, which is awaited at the end.
    let listenerClosed: Promise<void>;
    try {
      listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      listenerClosed = Promise.resolve(); // already closed (double shutdown)
    }

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
  ): Promise<void> {
    const parentThreadId = typeof params?.threadId === "string" ? params.threadId : null;
    const entry = parentThreadId && claimed && threads.get(parentThreadId) === claimed
      ? claimed
      : undefined;

    if (result === null) {
      // Request failed — no turn started. Release the claim if it is still
      // this request's (turn/completed may already have raced it away).
      if (entry && entry.requestPending) releaseThread(parentThreadId!);
      return;
    }

    const turn = result?.turn as Record<string, unknown> | undefined;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
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
    }

    let reviewEntry: ThreadEntry | null = null;
    if (reviewThreadId) {
      // The turn runs on the subthread; the parent carried no turn at all.
      // Release the parent claim NOW rather than at socket close — holding
      // it would block same-thread turns for the connection's whole life.
      if (entry) releaseThread(parentThreadId!);

      if (!threads.has(reviewThreadId)) {
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
    if (orphanEntry && orphanEntry.socket === null && orphanThreadId) {
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
        },
      });
      return;
    }

    // Swallow initialized notification
    if (message.method === "initialized" && message.id === undefined) {
      return;
    }

    // Handle broker/shutdown
    if (message.id !== undefined && message.method === "broker/shutdown") {
      send(socket, { id: message.id, result: {} });
      await shutdown(server);
      process.exit(0);
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
    const params = message.params as Record<string, unknown> | undefined;

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
      };
      threads.set(streamThreadId, claimed);
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
        if (typeof thread?.id === "string") peer.adoptThread(thread.id);
      }

      if (isStreaming) {
        await settleStreamingRequest(socket, method, params, result as Record<string, unknown>, claimed);
      }

      send(socket, { id: message.id, result });
    } catch (error) {
      if (isStreaming) {
        await settleStreamingRequest(socket, method, params, null, claimed);
      }
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(
          error instanceof RpcError ? error.rpcCode : -32000,
          (error as Error).message,
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
      entry.reject(new Error("Client disconnected while awaiting approval response"));
      pendingForwardedRequests.delete(reqId);
    }
    for (const [threadId, entry] of threads) {
      if (entry.socket !== socket) continue;
      entry.socket = null;
      if (entry.requestPending) {
        // settleStreamingRequest will see socket === null and handle it.
        continue;
      }
      if (entry.turnId) {
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
