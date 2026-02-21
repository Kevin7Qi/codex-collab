// src/protocol.ts — JSON-RPC client for Codex app server

import { spawn } from "bun";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  RequestId,
  InitializeParams,
  InitializeResponse,
} from "./types";
import { config } from "./config";

let nextId = 1;

/** Format a JSON-RPC request (has id, expects response). Returns newline-terminated JSON and the assigned id. */
export function formatRequest(method: string, params?: unknown): { line: string; id: number } {
  const id = nextId++;
  const msg: Record<string, unknown> = { id, method };
  if (params !== undefined) msg.params = params;
  return { line: JSON.stringify(msg) + "\n", id };
}

/** Format a JSON-RPC notification (no id, no response). Returns newline-terminated JSON. */
export function formatNotification(method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg) + "\n";
}

/** Format a JSON-RPC response to a server request. Returns newline-terminated JSON. */
export function formatResponse(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result }) + "\n";
}

/** Parse a JSON-RPC message from a line. Returns null if unparseable. */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Reset the request ID counter (for testing). */
export function resetIdCounter(): void {
  nextId = 1;
}

// ---------------------------------------------------------------------------
// AppServerClient — spawn, handshake, request/response routing, shutdown
// ---------------------------------------------------------------------------

/** Pending request tracker. */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Handler for server-sent notifications. */
type NotificationHandler = (params: unknown) => void;

/** Handler for server-sent requests (e.g. approval requests). Returns the result to send back. */
type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

/** Options for connect(). */
export interface ConnectOptions {
  /** Command to spawn. Defaults to ["codex", "app-server"]. */
  command?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Request timeout in ms. Defaults to config.requestTimeout (30s). */
  requestTimeout?: number;
}

/** The client interface returned by connect(). */
export interface AppServerClient {
  /** Send a request and wait for a response. Rejects on timeout, error, or process exit. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): void;
  /** Register a handler for server-sent notifications. Returns an unsubscribe function. */
  on(method: string, handler: NotificationHandler): () => void;
  /** Register a handler for server-sent requests (e.g. approval). Returns an unsubscribe function. */
  onRequest(method: string, handler: ServerRequestHandler): () => void;
  /** Send a response to a server-sent request. */
  respond(id: RequestId, result: unknown): void;
  /** Gracefully close: close stdin -> wait 5s -> SIGTERM -> wait 3s -> SIGKILL. */
  close(): Promise<void>;
  /** The server info from the initialize handshake. */
  serverInfo: InitializeResponse["serverInfo"];
}

/** Type guard: message is a response (has id + result). */
function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && "result" in msg;
}

/** Type guard: message is an error response (has id + error). */
function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return "id" in msg && "error" in msg;
}

/** Type guard: message is a request (has id + method). */
function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}

/** Type guard: message is a notification (has method, no id). */
function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

/**
 * Spawn the Codex app-server process, perform the initialize handshake,
 * and return an AppServerClient for request/response communication.
 */
export async function connect(opts?: ConnectOptions): Promise<AppServerClient> {
  const command = opts?.command ?? ["codex", "app-server"];
  const requestTimeout = opts?.requestTimeout ?? config.requestTimeout;

  // Spawn the child process
  const proc = spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });

  // Internal state
  const pending = new Map<RequestId, PendingRequest>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();
  const requestHandlers = new Map<string, ServerRequestHandler>();
  let closed = false;
  let exited = false;

  // Write a string to the child's stdin
  function write(data: string): void {
    if (closed) return;
    try {
      proc.stdin.write(data);
    } catch {
      // stdin may already be closed
    }
  }

  // Reject all pending requests (used on process exit or close)
  function rejectAll(reason: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  // Dispatch a parsed message
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
        entry.reject(new Error(`JSON-RPC error ${e.code}: ${e.message}${e.data ? ` (${JSON.stringify(e.data)})` : ""}`));
      }
      return;
    }

    if (isRequest(msg)) {
      const handler = requestHandlers.get(msg.method);
      if (handler) {
        const result = handler(msg.params);
        if (result instanceof Promise) {
          result.then(
            (res) => write(formatResponse(msg.id, res)),
            () => write(formatResponse(msg.id, null)),
          );
        } else {
          write(formatResponse(msg.id, result));
        }
      }
      return;
    }

    if (isNotification(msg)) {
      const handlers = notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch {
            // notification handler errors are swallowed
          }
        }
      }
    }
  }

  // Start the read loop — reads stdout line-by-line
  const readLoop = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          const msg = parseMessage(line);
          if (msg) {
            dispatch(msg);
          }
        }
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock();
    }
  })();

  // Monitor process exit: reject all pending requests
  proc.exited.then(() => {
    exited = true;
    if (!closed) {
      rejectAll("App server process exited unexpectedly");
    }
  });

  // --- Build the client object ---

  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new Error("Client is closed"));
        return;
      }
      if (exited) {
        reject(new Error("App server process exited unexpectedly"));
        return;
      }

      const { line, id } = formatRequest(method, params);

      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${requestTimeout}ms`));
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

  function onRequest(method: string, handler: ServerRequestHandler): () => void {
    requestHandlers.set(method, handler);
    return () => {
      requestHandlers.delete(method);
    };
  }

  function respond(id: RequestId, result: unknown): void {
    write(formatResponse(id, result));
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    rejectAll("Client closed");

    // Step 1: Close stdin to signal the server to exit
    try {
      proc.stdin.end();
    } catch {
      // already closed
    }

    // Step 2: Wait up to 5s for graceful exit
    const graceful = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (graceful) {
      await readLoop;
      return;
    }

    // Step 3: SIGTERM, wait 3s
    proc.kill("SIGTERM");
    const termed = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (termed) {
      await readLoop;
      return;
    }

    // Step 4: SIGKILL
    proc.kill("SIGKILL");
    await proc.exited;
    await readLoop;
  }

  // --- Perform initialize handshake ---

  const initParams: InitializeParams = {
    clientInfo: { name: config.clientName, version: config.clientVersion },
  };

  const initResult = await request<InitializeResponse>("initialize", initParams);

  // Send initialized notification to confirm handshake
  notify("initialized");

  return {
    request,
    notify,
    on,
    onRequest,
    respond,
    close,
    serverInfo: initResult.serverInfo,
  };
}
