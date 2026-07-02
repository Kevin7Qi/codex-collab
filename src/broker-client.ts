/**
 * BrokerClient — connects to a broker server via Unix socket / named pipe
 * and implements the AppServerClient interface.
 *
 * This allows callers to use the same interface whether connected directly
 * to `codex app-server` or through the broker multiplexer.
 */

import net from "node:net";
import { parseMessage, formatNotification, formatResponse, isResponse, isError, isRequest, isNotification } from "./client";
import type { AppServerClient, RequestId, PendingRequest, NotificationHandler, AnyNotificationHandler, ServerRequestHandler } from "./client";
import { RpcError, type JsonRpcMessage } from "./types";
import { config } from "./config";
import { parseEndpoint } from "./broker";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export interface BrokerClientOptions {
  /** The broker endpoint (unix:/path or pipe:\path). */
  endpoint: string;
  /** Request timeout in ms. Defaults to config.requestTimeout (30s). */
  requestTimeout?: number;
}

/**
 * Connect to a broker server via Unix socket / named pipe.
 * Performs the initialize handshake and returns an AppServerClient.
 */
export async function connectToBroker(opts: BrokerClientOptions): Promise<AppServerClient> {
  const requestTimeout = opts.requestTimeout ?? config.requestTimeout;
  const target = parseEndpoint(opts.endpoint);

  const pending = new Map<RequestId, PendingRequest>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();
  const anyNotificationHandlers = new Set<AnyNotificationHandler>();
  const requestHandlers = new Map<string, ServerRequestHandler>();
  let closed = false;
  let nextId = 1;

  // Connect to the socket
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const sock = new net.Socket();
    sock.setEncoding("utf8");

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Connection to broker timed out (${opts.endpoint})`));
    }, 5000);

    sock.on("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });

    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to connect to broker: ${err.message}`));
    });

    sock.connect({ path: target.path });
  });

  // Write to the socket
  function write(data: string): void {
    if (closed || socket.destroyed) return;
    try {
      socket.write(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[broker-client] Failed to write: ${msg}`);
      rejectAll("Socket write failed: " + msg);
    }
  }

  function rejectAll(reason: string): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  // Dispatch incoming messages
  function dispatch(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg.result);
      }
      return;
    }

    if (isError(msg)) {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        const e = msg.error;
        const err = new RpcError(
          `JSON-RPC error ${e.code}: ${e.message}${e.data ? ` (${JSON.stringify(e.data)})` : ""}`,
          e.code,
        );
        entry.reject(err);
      }
      return;
    }

    if (isRequest(msg)) {
      const handler = requestHandlers.get(msg.method);
      if (handler) {
        Promise.resolve()
          .then(() => handler(msg.params))
          .then(
            (res) => write(formatResponse(msg.id, res)),
            (err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              // Preserve a structured code/data the handler attached to the
              // Error, matching connectDirect — otherwise approval rejections
              // through the broker path flatten to a generic -32603 while the
              // direct path keeps the original error class.
              const errAny = err as { code?: unknown; data?: unknown };
              const code = typeof errAny?.code === "number" ? errAny.code : -32603;
              const message = code === -32603 ? `Handler error: ${errMsg}` : errMsg;
              console.error(`[broker-client] Error in request handler for "${msg.method}": ${errMsg}`);
              const errBody: Record<string, unknown> = { code, message };
              if (errAny?.data !== undefined) errBody.data = errAny.data;
              write(JSON.stringify({ id: msg.id, error: errBody }) + "\n");
            },
          );
      } else {
        write(
          JSON.stringify({
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          }) + "\n",
        );
      }
      return;
    }

    if (isNotification(msg)) {
      for (const h of anyNotificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (e) {
          console.error(
            `[broker-client] Error in wildcard notification handler for "${msg.method}": ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      const handlers = notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch (e) {
            console.error(
              `[broker-client] Error in notification handler for "${msg.method}": ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    }
  }

  const closeHandlers = new Set<() => void>();
  let unexpectedCloseNotified = false;

  function notifyUnexpectedClose(reason: string): void {
    if (closed || unexpectedCloseNotified) return;
    unexpectedCloseNotified = true;
    rejectAll(reason);
    for (const handler of closeHandlers) {
      try { handler(); } catch (e) {
        console.error(`[codex] Warning: close handler error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Read loop — parse newline-delimited JSON from socket
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_SIZE) {
      notifyUnexpectedClose("Broker response buffer exceeded maximum size");
      socket.destroy(new Error("Broker response buffer exceeded maximum size"));
      return;
    }
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      const msg = parseMessage(line);
      if (msg) dispatch(msg);
    }
  });

  socket.on("close", () => {
    notifyUnexpectedClose("Broker connection closed");
  });

  socket.on("error", (err) => {
    if (!closed) {
      console.error(`[broker-client] Socket error: ${err.message}`);
      notifyUnexpectedClose("Broker socket error: " + err.message);
    }
  });

  // Build the client interface
  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error("Client is closed"));
        return;
      }
      // Mirror connectDirect's `exited` guard: after an unexpected socket
      // close, write() silently no-ops on the dead socket — without this
      // check the request would sit in `pending` for the full 30s timeout
      // (e.g. blocking Ctrl-C shutdown's turn/interrupt on a dead broker).
      if (unexpectedCloseNotified || socket.destroyed) {
        reject(new Error("Broker connection closed"));
        return;
      }

      const id = nextId++;
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      const line = JSON.stringify(msg) + "\n";

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Request ${method} (id=${id}) timed out after ${requestTimeout}ms`,
          ),
        );
      }, requestTimeout);

      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      write(line);
    });
  }

  function notify(method: string, params?: unknown): void {
    write(formatNotification(method, params));
  }

  function on(method: string, handler: NotificationHandler): () => void {
    if (!notificationHandlers.has(method)) {
      notificationHandlers.set(method, new Set());
    }
    notificationHandlers.get(method)!.add(handler);
    return () => {
      notificationHandlers.get(method)?.delete(handler);
    };
  }

  function onAny(handler: AnyNotificationHandler): () => void {
    anyNotificationHandlers.add(handler);
    return () => { anyNotificationHandlers.delete(handler); };
  }

  function onRequest(method: string, handler: ServerRequestHandler): () => void {
    if (requestHandlers.has(method)) {
      console.error(
        `[broker-client] Warning: replacing existing request handler for "${method}"`,
      );
    }
    requestHandlers.set(method, handler);
    return () => {
      if (requestHandlers.get(method) === handler) {
        requestHandlers.delete(method);
      }
    };
  }

  function respond(id: RequestId, result: unknown): void {
    write(formatResponse(id, result));
  }

  function onClose(handler: () => void): () => void {
    closeHandlers.add(handler);
    return () => { closeHandlers.delete(handler); };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    rejectAll("Client closed");
    socket.end();
    // Wait for the socket to fully close. Clear the safety timer once the
    // close lands so a leftover armed timer can't keep the event loop alive.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      // If already destroyed, the close event may have fired before we could
      // subscribe — resolve immediately.
      if (socket.destroyed) {
        done();
        return;
      }
      socket.once("close", done);
    });
  }

  // Perform initialize handshake with the broker
  let userAgent: string;
  let brokerBusy = false;
  try {
    const result = await request<{ userAgent: string; busy?: boolean }>("initialize", {
      clientInfo: {
        name: config.clientName,
        title: null,
        version: config.clientVersion,
      },
      capabilities: {
        // The broker handles this initialize locally (the app-server sees the
        // broker's own handshake from client.ts), but keep the declared
        // capabilities in lockstep with the direct path.
        experimentalApi: true,
        optOutNotificationMethods: ["item/reasoning/textDelta"],
      },
    });
    brokerBusy = result.busy === true;
    userAgent = result.userAgent;
    notify("initialized");
  } catch (e) {
    await close();
    throw e;
  }

  return {
    request,
    notify,
    on,
    onAny,
    onRequest,
    respond,
    onClose,
    close,
    userAgent,
    brokerBusy,
  };
}
