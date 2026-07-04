// src/rpc.ts — shared JSON-RPC endpoint core
//
// One implementation of the wire-level plumbing that client.ts (stdio to the
// app-server child) and broker-client.ts (socket to the broker) both need:
// message parsing, pending-request tracking, response/error/server-request/
// notification dispatch, and the newline-buffered read path. The transports
// stay in their own files; everything protocol-shaped lives here.
//
// Several review-sweep bugs (#10) were drift between the two hand-maintained
// copies of this logic — that is the reason this module exists.

import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  RequestId,
} from "./types";
import { RpcError } from "./types";

export const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/** Format a JSON-RPC-style notification (no id, no response). Returns newline-terminated JSON.
 *  Note: Codex app server protocol omits the standard `jsonrpc: "2.0"` field. */
export function formatNotification(method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg) + "\n";
}

/** Format a JSON-RPC response to a server request. Returns newline-terminated JSON. */
export function formatResponse(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result }) + "\n";
}

/** Parse a JSON-RPC message from a line. Returns null if unparseable or not a valid protocol message. */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    const raw = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) return null;

    const hasMethod = "method" in raw && typeof raw.method === "string";
    const hasId = "id" in raw && (typeof raw.id === "string" || typeof raw.id === "number");
    const hasResult = "result" in raw;
    const hasError = "error" in raw;

    if (!hasMethod && !hasId) {
      console.error(`[codex] Warning: ignoring non-protocol message: ${line.slice(0, 200)}`);
      return null;
    }

    if (hasId && !hasMethod) {
      if (hasResult === hasError) {
        console.error(`[codex] Warning: ignoring malformed response: ${line.slice(0, 200)}`);
        return null;
      }
      if (hasError) {
        const error = (raw as { error?: unknown }).error;
        if (
          typeof error !== "object" ||
          error === null ||
          typeof (error as { code?: unknown }).code !== "number" ||
          typeof (error as { message?: unknown }).message !== "string"
        ) {
          console.error(`[codex] Warning: ignoring malformed error response: ${line.slice(0, 200)}`);
          return null;
        }
      }
      return raw as JsonRpcMessage;
    }

    if (hasMethod && hasId && (hasResult || hasError)) {
      console.error(`[codex] Warning: ignoring malformed request/response hybrid: ${line.slice(0, 200)}`);
      return null;
    }

    if (hasMethod && !hasId && (hasResult || hasError)) {
      console.error(`[codex] Warning: ignoring malformed notification/response hybrid: ${line.slice(0, 200)}`);
      return null;
    }

    return raw as JsonRpcMessage;
  } catch {
    console.error(`[codex] Warning: unparseable message from app server: ${line.slice(0, 200)}`);
    return null;
  }
}

/** Type guard: message is a response (has id + result). */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && "result" in msg && !("method" in msg);
}

/** Type guard: message is an error response (has id + error). */
export function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return "id" in msg && "error" in msg && !("method" in msg);
}

/** Type guard: message is a request (has id + method). */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg);
}

/** Type guard: message is a notification (has method, no id). */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

/** Pending request tracker. */
export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Handler for server-sent notifications. */
export type NotificationHandler = (params: unknown) => void;

/** Handler for any server-sent notification, including the method name. */
export type AnyNotificationHandler = (method: string, params: unknown) => void;

/** Handler for server-sent requests (e.g. approval requests). Returns the result to send back. */
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

export interface RpcEndpointOptions {
  /** Log prefix, e.g. "codex" or "broker-client". */
  label: string;
  /** Request timeout in ms. */
  requestTimeout: number;
  /** Raw transport write. May throw; a throw rejects all pending requests. */
  send: (data: string) => void;
  /** Reason the connection can no longer serve requests (process exited,
   *  socket destroyed), or null while healthy. Consulted before each request
   *  and when deciding whether a write failure is worth logging. */
  downReason: () => string | null;
  /** Rejection reason when the receive buffer exceeds MAX_BUFFER_SIZE. */
  overflowReason: string;
  /** Transport teardown after a buffer overflow (pending already rejected). */
  onOverflow: () => void;
  /** Prefix for the rejection reason when a transport write throws. */
  writeFailedPrefix: string;
}

export interface RpcEndpoint {
  /** Feed raw incoming bytes; complete lines are parsed and dispatched. */
  feed(chunk: string): void;
  /** Send a request and wait for a response. Rejects on timeout, error, or connection loss. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): void;
  /** Register a handler for server-sent notifications. Returns an unsubscribe function. */
  on(method: string, handler: NotificationHandler): () => void;
  /** Register a wildcard handler that fires for every server-sent notification. */
  onAny(handler: AnyNotificationHandler): () => void;
  /** Register a handler for server-sent requests. One handler per method;
   *  new registrations replace previous ones (with a warning). */
  onRequest(method: string, handler: ServerRequestHandler): () => void;
  /** Send a response to a server-sent request. */
  respond(id: RequestId, result: unknown): void;
  /** Register a callback invoked on unexpected connection loss (fail()).
   *  Not called after markClosed(). Returns an unsubscribe function. */
  onClose(handler: () => void): () => void;
  /** Mark the endpoint intentionally closed: reject pending requests with
   *  "Client is closed"-style reasons and stop accepting writes. Idempotent. */
  markClosed(): void;
  /** Report an unexpected connection loss: reject pending requests with the
   *  given reason and fire onClose handlers once. No-op after markClosed(). */
  fail(reason: string): void;
  /** Reject all pending requests without firing onClose handlers (e.g. a
   *  read-loop error where the connection may be torn down separately). */
  rejectAllPending(reason: string): void;
  /** True after markClosed(). */
  isClosed(): boolean;
}

/**
 * Create a JSON-RPC endpoint over an arbitrary line-oriented transport.
 * The transport supplies raw writes and liveness; the endpoint owns request
 * ids, pending tracking, dispatch, and handler registries.
 */
export function createRpcEndpoint(opts: RpcEndpointOptions): RpcEndpoint {
  const { label, requestTimeout } = opts;

  const pending = new Map<RequestId, PendingRequest>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();
  const anyNotificationHandlers = new Set<AnyNotificationHandler>();
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const closeHandlers = new Set<() => void>();
  let closed = false;
  let failReason: string | null = null;
  let nextId = 1;
  let buffer = "";

  function write(data: string): void {
    if (closed) return;
    try {
      opts.send(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.downReason() === null) {
        console.error(`[${label}] Failed to write: ${msg}`);
      }
      rejectAllPending(opts.writeFailedPrefix + msg);
    }
  }

  function rejectAllPending(reason: string): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function fail(reason: string): void {
    if (closed || failReason !== null) return;
    failReason = reason;
    rejectAllPending(reason);
    for (const handler of closeHandlers) {
      try { handler(); } catch (e) {
        console.error(`[${label}] Warning: close handler error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

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
        entry.reject(new RpcError(
          `JSON-RPC error ${e.code}: ${e.message}${e.data ? ` (${JSON.stringify(e.data)})` : ""}`,
          e.code,
        ));
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
              // Error (e.g. a forwarded client rejection); fall back to the
              // generic internal-error code otherwise.
              const errAny = err as { code?: unknown; data?: unknown };
              const code = typeof errAny?.code === "number" ? errAny.code : -32603;
              const message = code === -32603 ? `Handler error: ${errMsg}` : errMsg;
              console.error(`[${label}] Error in request handler for "${msg.method}": ${errMsg}`);
              const errBody: Record<string, unknown> = { code, message };
              if (errAny?.data !== undefined) errBody.data = errAny.data;
              write(JSON.stringify({ id: msg.id, error: errBody }) + "\n");
            },
          );
      } else {
        write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }) + "\n");
      }
      return;
    }

    if (isNotification(msg)) {
      // Wildcard handlers fire first, regardless of method, so the broker
      // forwards every notification — including new ones the protocol adds.
      for (const h of anyNotificationHandlers) {
        try {
          h(msg.method, msg.params);
        } catch (e) {
          console.error(`[${label}] Error in wildcard notification handler for "${msg.method}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const handlers = notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch (e) {
            console.error(`[${label}] Error in notification handler for "${msg.method}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  let overflowed = false;

  function feed(chunk: string): void {
    if (overflowed) return;
    buffer += chunk;
    if (buffer.length > MAX_BUFFER_SIZE) {
      overflowed = true;
      buffer = "";
      console.error(`[${label}] ${opts.overflowReason}`);
      fail(opts.overflowReason);
      opts.onOverflow();
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
  }

  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) { reject(new Error("Client is closed")); return; }
      const down = failReason ?? opts.downReason();
      if (down !== null) { reject(new Error(down)); return; }

      const id = nextId++;
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      const line = JSON.stringify(msg) + "\n";

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${requestTimeout}ms`));
      }, requestTimeout);

      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
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
      console.error(`[${label}] Warning: replacing existing request handler for "${method}"`);
    }
    requestHandlers.set(method, handler);
    return () => {
      // Only delete if this is still our handler
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

  function markClosed(): void {
    if (closed) return;
    closed = true;
    rejectAllPending("Client closed");
  }

  return {
    feed,
    request,
    notify,
    on,
    onAny,
    onRequest,
    respond,
    onClose,
    markClosed,
    fail,
    rejectAllPending,
    isClosed: () => closed,
  };
}
