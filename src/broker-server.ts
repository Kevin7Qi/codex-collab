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
 * - Exclusive lock: only one client's request streams at a time
 * - Returns error code -32001 when busy
 * - Idle timeout: shuts down after N ms with no activity
 * - Handles SIGTERM/SIGINT gracefully
 */

import net from "node:net";
import fs, { chmodSync } from "node:fs";
import path from "node:path";
import {
  connectDirect,
  parseMessage,
  type AppServerClient,
} from "./client";
import { parseEndpoint, BROKER_BUSY_RPC_CODE } from "./broker";
import { RpcError } from "./types";
import { config } from "./config";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Methods that start a streaming turn — the socket that initiated the stream
 *  owns notifications until turn/completed arrives. */
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

function buildStreamTargets(
  method: string,
  params: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
): Map<string, string> {
  const targets = new Map<string, string>();
  const turn = result?.turn as Record<string, unknown> | undefined;
  const turnId = typeof turn?.id === "string" ? turn.id : null;
  if (!turnId) return targets;
  if (params?.threadId && typeof params.threadId === "string") {
    targets.set(params.threadId, turnId);
  }
  if (method === "review/start" && typeof result?.reviewThreadId === "string") {
    targets.set(result.reviewThreadId, turnId);
  }
  return targets;
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

  // Spawn the real app-server
  const appClient = await connectDirect({ cwd });

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

  /** Socket that currently owns a pending request (waiting for response). */
  let activeRequestSocket: net.Socket | null = null;
  /** Whether the pending request will claim stream ownership if it succeeds. */
  let activeRequestIsStreaming = false;
  /** Socket that owns the current streaming turn (notifications routed here). */
  let activeStreamSocket: net.Socket | null = null;
  /** Active stream targets keyed by thread ID with the turn ID to interrupt. */
  let activeStreamTargets: Map<string, string> | null = null;
  /** All connected sockets. */
  const sockets = new Set<net.Socket>();
  /** Turn IDs whose turn/completed arrived during the streaming request
   *  itself — prevents claiming stream ownership for a turn that already
   *  finished. Keyed by turnId (unique per turn) so a leaked entry from a
   *  prior turn cannot poison a future turn on the same thread. */
  const completedStreamTurnIds = new Set<string>();
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
  /** Orphan-turn watchdog — fires when the stream-owning client has
   *  disconnected and no turn/completed has arrived. Without this, a stuck
   *  app-server (or a lost completion notification) would leave the broker
   *  reporting busy forever, blocking every subsequent client with -32001. */
  let orphanWatchdog: ReturnType<typeof setTimeout> | null = null;
  const ORPHAN_WATCHDOG_MS = idleTimeout; // Reuse the idle timeout for orphan recovery — same magnitude

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (activeRequestSocket !== null || activeStreamSocket !== null || pendingForwardedRequests.size > 0) {
        resetIdleTimer();
        return;
      }
      process.stderr.write("[broker-server] Idle timeout — shutting down\n");
      shutdown(server).then(() => process.exit(0));
    }, idleTimeout);
  }

  /** Arm the watchdog after a stream owner disconnects mid-turn. If
   *  turn/completed doesn't arrive, force the orphaned turn to end so the
   *  broker can serve other clients again. */
  function armOrphanWatchdog(orphanedTargets: Map<string, string>): void {
    if (orphanWatchdog) clearTimeout(orphanWatchdog);
    const targets = [...orphanedTargets].map(([threadId, turnId]) => ({ threadId, turnId }));
    // Capture ownership at arm time. If this orphan completes and another
    // client starts a new stream before the timer fires, do not clear it.
    const ownedTargets = orphanedTargets;
    orphanWatchdog = setTimeout(() => {
      // The whole timer body must be guarded — Bun and Node 15+ treat
      // unhandled rejections as fatal by default, and the broker is long-
      // lived, so any escape here would kill it.
      orphanWatchdog = null;
      // If the turn already completed by the time we wake up, nothing to do.
      if (activeStreamSocket === null) return;
      /** Release stream ownership iff we still own it. Used by the normal
       *  exit path AND the catch-of-last-resort, so a watchdog crash
       *  between the await and the cleanup cannot leave the broker
       *  permanently busy. */
      const releaseOwnershipIfStillOurs = (): void => {
        if (activeStreamSocket !== null && activeStreamTargets === ownedTargets) {
          activeStreamSocket = null;
          activeStreamTargets = null;
          // Don't touch activeRequestSocket — a fresh non-streaming request
          // (kill, threads, etc.) may have claimed it during the await.
        }
      };

      (async () => {
        process.stderr.write(`[broker-server] Orphan-turn watchdog firing — interrupting ${targets.length} thread(s)\n`);
        // Treat ANY rejection as failure: matching message text proved
        // fragile (a previous regex once swallowed "Method not found"
        // -32601). Cost: occasional unnecessary respawn when the turn
        // naturally ended right before the watchdog fired.
        const results = await Promise.allSettled(
          targets.map(({ threadId, turnId }) => appClient.request("turn/interrupt", { threadId, turnId })),
        );
        let anySucceeded = false;
        results.forEach((r, i) => {
          if (r.status === "fulfilled") anySucceeded = true;
          else process.stderr.write(`[broker-server] Warning: orphan-turn interrupt failed for ${targets[i].threadId}/${targets[i].turnId}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`);
        });
        // Ownership may have moved during the interrupt RPCs: the orphan can
        // complete naturally (handler releases it) and a new client can claim
        // a fresh stream. In that case the failed interrupts only prove the
        // *old* turn was already gone — shutting down would kill the new
        // client's healthy in-flight turn, so only shut down if still owner.
        const stillOwned = activeStreamSocket !== null && activeStreamTargets === ownedTargets;
        releaseOwnershipIfStillOurs();
        // If every interrupt failed while we still owned the stream, the
        // app-server is likely unhealthy. Shutdown forces ensureConnection
        // to respawn next time.
        if (!anySucceeded && targets.length > 0 && stillOwned) {
          process.stderr.write("[broker-server] Orphan-turn interrupt failed entirely — shutting down so the next invocation respawns\n");
          if (!shutdownInitiated) {
            shutdownInitiated = true;
            shutdown(server).then(() => process.exit(1));
          }
        }
      })().catch((e) => {
        // Catch-of-last-resort: if the body throws unexpectedly, the broker
        // would otherwise stay marked busy until idle timeout. Releasing
        // ownership here recovers the slot; logging surfaces the bug.
        process.stderr.write(`[broker-server] Watchdog body crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}\n`);
        releaseOwnershipIfStillOurs();
      });
    }, ORPHAN_WATCHDOG_MS);
    orphanWatchdog.unref?.();
    // Keep the broker alive long enough for the watchdog to run. Registering
    // the idle timer after the watchdog means equal deadlines run watchdog
    // recovery first instead of shutting the broker down before it can clean up.
    resetIdleTimer();
  }

  // ─── Notification routing ───────────────────────────────────────────────

  // Forward every notification the app-server sends — including methods we
  // don't know about — to the owning socket. An allowlist would silently
  // drop new protocol notifications added by Codex.
  appClient.onAny((method, notifParams) => {
    resetIdleTimer();
    const target = activeRequestSocket ?? activeStreamSocket;

    // Forward the notification to the owning socket (if still connected)
    if (target) {
      const message: Record<string, unknown> = { method, params: notifParams };
      send(target, message);
    }

    // If turn/completed, release the stream ownership — even if the owning
    // socket has disconnected (orphaned turn completing naturally).
    if (method === "turn/completed") {
      const params = notifParams as Record<string, unknown> | undefined;
      const threadId = params?.threadId;
      const completedTurn = params?.turn as Record<string, unknown> | undefined;
      const completedTurnId = typeof completedTurn?.id === "string" ? completedTurn.id : null;
      // Track completed turn IDs so that a streaming request still awaiting
      // its response doesn't re-establish ownership after the turn has
      // already finished (fast-turn race where turn/completed arrives in
      // the same read chunk as the streaming response).
      if (completedTurnId) {
        completedStreamTurnIds.add(completedTurnId);
        // Bound the set: it's a fast-turn-race tracker, not a history.
        // Without a cap, a long-lived broker accumulates entries for turns
        // whose responses never settled (e.g. orphan-watchdog clears
        // ownership before the natural completion arrives).
        if (completedStreamTurnIds.size > 200) {
          const drop = [...completedStreamTurnIds].slice(0, 100);
          for (const id of drop) completedStreamTurnIds.delete(id);
        }
      }
      const matchesStream =
        !threadId ||
        typeof threadId !== "string" ||
        !activeStreamTargets ||
        activeStreamTargets.has(threadId);
      if (matchesStream && (activeStreamSocket === target || activeStreamSocket === null)) {
        // If we're releasing actual stream ownership (activeStreamSocket was set),
        // also clean up the tracked turn ID so the bounded set stays small.
        // In the fast-turn race (activeStreamSocket is null), keep the entry
        // — the pending response handler needs it.
        if (activeStreamSocket !== null && completedTurnId) {
          completedStreamTurnIds.delete(completedTurnId);
        }
        activeStreamSocket = null;
        activeStreamTargets = null;
        // Deliberately do NOT clear activeRequestSocket/activeRequestIsStreaming
        // here. When a request is pending, this completion is either (a) the
        // pending request's own fast turn — its response settles moments later
        // and the request path clears both flags on every settle branch — or
        // (b) a stale orphan turn completing naturally, in which case clearing
        // would free the slot while the unrelated request is still in flight,
        // letting a second client interleave a stream on the shared app-server.
        // Also cancel any orphan-turn watchdog; the turn ended naturally.
        if (orphanWatchdog) {
          clearTimeout(orphanWatchdog);
          orphanWatchdog = null;
        }
      }
    }
  });

  // Also forward server-sent requests (like approval requests)
  const SERVER_REQUEST_METHODS = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ];

  for (const method of SERVER_REQUEST_METHODS) {
    appClient.onRequest(method, async (reqParams) => {
      resetIdleTimer();
      const target = activeRequestSocket ?? activeStreamSocket;
      if (!target || target.destroyed) {
        throw new Error("No active client to forward approval request");
      }

      // Forward the request to the client socket and wait for the response
      // via the main data handler (which checks pendingForwardedRequests).
      return new Promise((resolve, reject) => {
        const reqId = `broker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // Match client-side approval timeout (1 hour) — interactive approvals
        // require human action and 60s is too short.
        const timer = setTimeout(() => {
          pendingForwardedRequests.delete(reqId);
          reject(new Error("Approval request forwarding timed out"));
        }, 3_600_000);

        pendingForwardedRequests.set(reqId, { resolve, reject, timer, target });

        // Send the request to the client socket
        send(target, { id: reqId, method, params: reqParams });
      });
    });
  }

  // ─── Shutdown ───────────────────────────────────────────────────────────

  async function shutdown(server: net.Server): Promise<void> {
    shutdownInitiated = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (orphanWatchdog) {
      clearTimeout(orphanWatchdog);
      orphanWatchdog = null;
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
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        resolve();
      }, 2000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (listenTarget.kind === "unix") {
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
          busy: activeStreamSocket !== null || activeRequestIsStreaming,
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

    // ─── Concurrency control ──────────────────────────────────

    const isInterrupt =
      typeof message.method === "string" &&
      message.method === "turn/interrupt";
    const isReadOnly =
      typeof message.method === "string" &&
      (message.method === "thread/read" || message.method === "thread/list");

    // Allow interrupt and read-only requests through even when another
    // client owns the stream — but only when there's no pending request.
    // Read-only methods are needed by `kill` (reads thread to get turn ID)
    // and `threads` (lists threads while a turn is running).
    const allowDuringActiveStream =
      (isInterrupt || isReadOnly) &&
      activeStreamSocket !== null &&
      activeStreamSocket !== socket &&
      activeRequestSocket === null;

    if (
      ((activeRequestSocket !== null && activeRequestSocket !== socket) ||
        (activeStreamSocket !== null && activeStreamSocket !== socket)) &&
      !allowDuringActiveStream
    ) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(
          BROKER_BUSY_RPC_CODE,
          "Shared Codex broker is busy.",
        ),
      });
      return;
    }

    // Forward interrupt/read-only during active stream (special path)
    if (allowDuringActiveStream) {
      try {
        const result = await appClient.request(
          message.method as string,
          (message.params ?? {}) as Record<string, unknown>,
        );
        send(socket, { id: message.id, result });
      } catch (error) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(
            error instanceof RpcError ? error.rpcCode : -32000,
            (error as Error).message,
          ),
        });
      }
      return;
    }

    // ─── Normal request forwarding ────────────────────────────

    const isStreaming = STREAMING_METHODS.has(message.method as string);
    activeRequestSocket = socket;
    activeRequestIsStreaming = isStreaming;

    try {
      const result = await appClient.request(
        message.method as string,
        (message.params ?? {}) as Record<string, unknown>,
      );

      // If the requesting client disconnected while we were waiting for the
      // response, the turn has started on the app-server but nobody is
      // listening. Reserve the stream slot up front so the next client
      // can't interleave on the same app-server while this turn is still
      // unwinding, send turn/interrupt, and let the normal turn/completed
      // handler (or the watchdog, on a stuck turn) clear the reservation.
      // A successful interrupt RPC only acknowledges that the request was
      // received — it does not guarantee the turn is fully torn down.
      if (socket.destroyed && isStreaming) {
        const resultObj = result as Record<string, unknown>;
        const turn = resultObj?.turn as Record<string, unknown> | undefined;
        const turnId = turn?.id as string | undefined;
        const parentThreadId = (message.params as Record<string, unknown>)?.threadId as string | undefined;
        // review/start returns a distinct review subthread that the turn
        // actually runs on; interrupting the parent is a no-op. For normal
        // turns there is no subthread, so we fall back to the parent.
        const reviewThreadId = typeof resultObj?.reviewThreadId === "string"
          ? (resultObj.reviewThreadId as string)
          : undefined;
        const interruptThreadId = reviewThreadId ?? parentThreadId;
        if (turnId && interruptThreadId && completedStreamTurnIds.has(turnId)) {
          // Fast turn: turn/completed already landed during the request (same
          // race the normal streaming path guards via `alreadyCompleted`). The
          // turn is done — there is nothing to unwind, so do NOT reserve the
          // slot. Reserving here would hold the stream until the watchdog fires
          // (up to ORPHAN_WATCHDOG_MS, default the idle timeout), forcing every
          // other client onto direct connections in the meantime.
          completedStreamTurnIds.delete(turnId);
        } else if (turnId && interruptThreadId) {
          // Reserve BEFORE the interrupt so the slot stays held even when
          // turn/interrupt succeeds; the natural turn/completed (or the
          // watchdog) is what releases the reservation. Keyed on every
          // thread that might emit completion — for reviews that's both
          // the parent and the review subthread.
          const orphanTargets = new Map<string, string>();
          if (parentThreadId) orphanTargets.set(parentThreadId, turnId);
          if (reviewThreadId) orphanTargets.set(reviewThreadId, turnId);
          activeStreamSocket = socket;
          activeStreamTargets = orphanTargets;
          armOrphanWatchdog(orphanTargets);
          try {
            await appClient.request("turn/interrupt", { threadId: interruptThreadId, turnId });
          } catch (e) {
            process.stderr.write(
              `[broker-server] Warning: failed to interrupt orphaned turn ${turnId}: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            // Reservation already in place — watchdog continues to guard.
          }
        }
        if (activeRequestSocket === socket) {
          activeRequestSocket = null;
          activeRequestIsStreaming = false;
        }
        return;
      }

      send(socket, { id: message.id, result });

      if (isStreaming) {
        const streamTargets = buildStreamTargets(
          message.method as string,
          message.params as Record<string, unknown> | undefined,
          result as Record<string, unknown>,
        );
        // Only claim stream ownership if this turn hasn't already completed
        // during the request. turn/completed can arrive in the same read
        // chunk as the response, firing the notification handler before
        // this code runs. Match by the new turn's id (unique per turn) so
        // a stale entry from an unrelated prior turn cannot block ownership.
        const newTurn = (result as Record<string, unknown>)?.turn as Record<string, unknown> | undefined;
        const newTurnId = typeof newTurn?.id === "string" ? newTurn.id : null;
        const alreadyCompleted = newTurnId !== null && completedStreamTurnIds.has(newTurnId);
        // An empty targets map (response without turn.id) must not claim
        // ownership: turn/completed matches by thread ID, so nothing could
        // ever release the slot and the broker would stay busy until the
        // owner disconnects.
        if (!alreadyCompleted && streamTargets.size > 0) {
          activeStreamSocket = socket;
          activeStreamTargets = streamTargets;
        }
        if (newTurnId) completedStreamTurnIds.delete(newTurnId);
      }

      if (activeRequestSocket === socket) {
        activeRequestSocket = null;
        activeRequestIsStreaming = false;
      }
    } catch (error) {
      send(socket, {
        id: message.id,
        error: buildJsonRpcError(
          error instanceof RpcError ? error.rpcCode : -32000,
          (error as Error).message,
        ),
      });
      if (activeRequestSocket === socket) {
        activeRequestSocket = null;
        activeRequestIsStreaming = false;
      }
      // Do NOT clear activeStreamSocket here. A failed non-streaming RPC
      // from the stream-owning socket (e.g. an unknown method, or a
      // protocol-level rejection) does not end the underlying turn on the
      // app-server. The turn keeps running and ownership must be preserved
      // until turn/completed arrives — otherwise a second client could
      // interleave a streaming request over the same app-server.
    }
  }

  // ─── Socket server ─────────────────────────────────────────────────────

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
      sockets.delete(socket);
      // Reject only pending forwarded requests targeting this socket
      for (const [reqId, entry] of pendingForwardedRequests) {
        if (entry.target !== socket) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error("Client disconnected while awaiting approval response"));
        pendingForwardedRequests.delete(reqId);
      }
      if (activeStreamSocket === socket) {
        if (activeStreamTargets) {
          // Turn is still running — keep activeStreamSocket as a sentinel so the
          // concurrency check blocks new streaming requests until turn/completed
          // clears the state. Nulling it would let a second client interleave.
          // Arm the watchdog so a stuck/lost completion does not block forever.
          process.stderr.write("[broker-server] Warning: stream-owning client disconnected while turn is active\n");
          armOrphanWatchdog(activeStreamTargets);
        } else {
          activeStreamSocket = null;
        }
      }
      // Keep any active request lock until the app-server request settles. If
      // this was a streaming start, the app-server may already be creating a
      // turn; clearing early would allow another client to interleave before
      // the orphan recovery path has a turnId to interrupt.
    });

    socket.on("error", (err) => {
      process.stderr.write(`[broker-server] Client socket error: ${err.message}\n`);
      sockets.delete(socket);
      // Reject only pending forwarded requests targeting this socket
      for (const [reqId, entry] of pendingForwardedRequests) {
        if (entry.target !== socket) continue;
        clearTimeout(entry.timer);
        entry.reject(new Error("Client socket error while awaiting approval response"));
        pendingForwardedRequests.delete(reqId);
      }
      if (activeStreamSocket === socket) {
        if (activeStreamTargets) {
          // Turn is still running — keep activeStreamSocket as sentinel so the
          // concurrency check blocks new streaming requests until turn/completed.
          process.stderr.write("[broker-server] Warning: stream-owning client errored while turn is active\n");
          armOrphanWatchdog(activeStreamTargets);
        } else {
          activeStreamSocket = null;
        }
      }
      // See the close handler: request ownership is released by the request's
      // await/catch path, not by socket liveness.
    });
  });

  // ─── Signal handlers ──────────────────────────────────────────────────

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
