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
const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

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

function buildStreamThreadIds(
  method: string,
  params: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  if (params?.threadId && typeof params.threadId === "string") {
    ids.add(params.threadId);
  }
  if (method === "review/start" && typeof result?.reviewThreadId === "string") {
    ids.add(result.reviewThreadId);
  }
  return ids;
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

  // ─── State ──────────────────────────────────────────────────────────────

  /** Socket that currently owns a pending request (waiting for response). */
  let activeRequestSocket: net.Socket | null = null;
  /** Socket that owns the current streaming turn (notifications routed here). */
  let activeStreamSocket: net.Socket | null = null;
  /** Thread IDs for the active stream (for turn/completed matching). */
  let activeStreamThreadIds: Set<string> | null = null;
  /** All connected sockets. */
  const sockets = new Set<net.Socket>();
  /** Thread IDs whose turns completed — prevents stale stream ownership
   *  when turn/completed arrives during the streaming request itself. */
  const completedStreamThreadIds = new Set<string>();
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

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      process.stderr.write("[broker-server] Idle timeout — shutting down\n");
      shutdown(server).then(() => process.exit(0));
    }, idleTimeout);
  }

  function clearSocketOwnership(socket: net.Socket): void {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  // ─── Notification routing ───────────────────────────────────────────────

  // Wire up a raw notification forwarder. The connectDirect client uses
  // `on(method, handler)` for each method. Instead of registering every
  // possible method, we'll use a single forwarding approach by re-exporting
  // notifications through a wrapper.

  // For each notification the app-server sends, forward to the active socket.
  // We register catch-all handlers for known notification types.
  const NOTIFICATION_METHODS = [
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/reasoning/textDelta",
    "turn/completed",
    "error",
  ];

  for (const method of NOTIFICATION_METHODS) {
    appClient.on(method, (notifParams) => {
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
        const threadId = (notifParams as Record<string, unknown>)?.threadId;
        // Track completed thread IDs so that a streaming request that is
        // still awaiting its response doesn't re-establish ownership after
        // the turn has already finished (fast-turn race).
        if (typeof threadId === "string") {
          completedStreamThreadIds.add(threadId);
        }
        const matchesStream =
          !threadId ||
          typeof threadId !== "string" ||
          !activeStreamThreadIds ||
          activeStreamThreadIds.has(threadId);
        if (matchesStream && (activeStreamSocket === target || activeStreamSocket === null)) {
          activeStreamSocket = null;
          activeStreamThreadIds = null;
          if (target && activeRequestSocket === target) {
            activeRequestSocket = null;
          }
        }
      }
    });
  }

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
    if (idleTimer) clearTimeout(idleTimer);
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  // ─── Socket server ─────────────────────────────────────────────────────

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    resetIdleTimer();

    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_SIZE) {
        process.stderr.write("[broker-server] Client buffer exceeded maximum size, disconnecting\n");
        socket.destroy();
        return;
      }
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        resetIdleTimer();

        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch (err) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(
              -32700,
              `Invalid JSON: ${(err as Error).message}`,
            ),
          });
          continue;
        }

        // Handle initialize locally — don't forward to app-server
        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: { userAgent: "codex-collab-broker" },
          });
          continue;
        }

        // Swallow initialized notification
        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        // Handle broker/shutdown
        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        // Ignore notifications (no id) from clients
        if (message.id === undefined) {
          continue;
        }

        // Route responses (id + result/error, no method) to pending forwarded
        // requests (e.g. approval request responses from the client).
        if (message.id !== undefined && !("method" in message)) {
          const reqId = String(message.id);
          const entry = pendingForwardedRequests.get(reqId);
          if (entry) {
            if (entry.target !== socket) {
              process.stderr.write(
                `[broker-server] Warning: forwarded response id=${reqId} from wrong socket — ignoring\n`,
              );
              continue;
            }
            pendingForwardedRequests.delete(reqId);
            clearTimeout(entry.timer);
            if ("result" in message) {
              entry.resolve(message.result);
            } else if ("error" in message) {
              const errObj = message.error as Record<string, unknown> | undefined;
              entry.reject(new Error((errObj?.message as string) ?? "Client error"));
            } else {
              entry.reject(new Error("Malformed forwarded response: missing both 'result' and 'error'"));
            }
          } else {
            process.stderr.write(
              `[broker-server] Warning: received response for unknown/expired forwarded request id=${reqId}\n`,
            );
          }
          continue;
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
          continue;
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
          continue;
        }

        // ─── Normal request forwarding ────────────────────────────

        const isStreaming = STREAMING_METHODS.has(message.method as string);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(
            message.method as string,
            (message.params ?? {}) as Record<string, unknown>,
          );
          send(socket, { id: message.id, result });

          if (isStreaming) {
            const streamIds = buildStreamThreadIds(
              message.method as string,
              message.params as Record<string, unknown> | undefined,
              result as Record<string, unknown>,
            );
            // Only claim stream ownership if the turn hasn't already completed
            // during the request. turn/completed can arrive in the same read
            // chunk as the response, firing the notification handler before
            // this code runs. Without this check the broker stays permanently busy.
            const alreadyCompleted = [...streamIds].some(id => completedStreamThreadIds.has(id));
            if (!alreadyCompleted) {
              activeStreamSocket = socket;
              activeStreamThreadIds = streamIds;
            }
            // Clean up tracked completions for these thread IDs
            for (const id of streamIds) completedStreamThreadIds.delete(id);
          }

          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
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
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
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
        if (activeStreamThreadIds) {
          // Turn is still running — keep activeStreamSocket as a sentinel so the
          // concurrency check blocks new streaming requests until turn/completed
          // clears the state. Nulling it would let a second client interleave.
          process.stderr.write("[broker-server] Warning: stream-owning client disconnected while turn is active\n");
        } else {
          activeStreamSocket = null;
        }
      }
      if (activeRequestSocket === socket) {
        activeRequestSocket = null;
      }
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
        process.stderr.write("[broker-server] Warning: stream-owning client errored while turn is active\n");
        activeStreamSocket = null;
        // Keep activeStreamThreadIds so turn/completed can still clear the state
      }
      if (activeRequestSocket === socket) {
        activeRequestSocket = null;
      }
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

  server.listen(listenTarget.path, () => {
    process.stderr.write(
      `[broker-server] Listening on ${endpoint} (idle timeout: ${idleTimeout}ms)\n`,
    );
    if (listenTarget.kind === "unix") {
      chmodSync(listenTarget.path, 0o700);
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
