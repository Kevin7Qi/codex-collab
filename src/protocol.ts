// src/protocol.ts — JSON-RPC client for Codex app server

import { spawn } from "bun";
import { spawnSync } from "child_process";
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

    if (!hasMethod && !hasId) {
      console.error(`[codex] Warning: ignoring non-protocol message: ${line.slice(0, 200)}`);
      return null;
    }

    return raw as JsonRpcMessage;
  } catch {
    console.error(`[codex] Warning: unparseable message from app server: ${line.slice(0, 200)}`);
    return null;
  }
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
  /** Register a handler for server-sent requests (e.g. approval). One handler per method;
   *  new registrations replace previous ones. Returns an unsubscribe function. */
  onRequest(method: string, handler: ServerRequestHandler): () => void;
  /** Send a response to a server-sent request. */
  respond(id: RequestId, result: unknown): void;
  /** Close the connection and terminate the server process.
   *  On Unix: close stdin -> wait 5s -> SIGTERM -> wait 3s -> SIGKILL.
   *  On Windows: close stdin, then immediately terminate the process tree
   *  (no timed grace period, unlike Unix). */
  close(): Promise<void>;
  /** The user-agent string from the initialize handshake. */
  userAgent: string;
}

/** Type guard: message is a response (has id + result). */
function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && "result" in msg && !("method" in msg);
}

/** Type guard: message is an error response (has id + error). */
function isError(msg: JsonRpcMessage): msg is JsonRpcError {
  return "id" in msg && "error" in msg && !("method" in msg);
}

/** Type guard: message is a request (has id + method). */
function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg);
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
  const proc = (() => {
    try {
      return spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to start app server (${command.join(" ")}): ${msg}\n` +
        `Ensure codex CLI is installed: npm install -g @openai/codex`,
      );
    }
  })();

  // Internal state
  const pending = new Map<RequestId, PendingRequest>();
  const notificationHandlers = new Map<string, Set<NotificationHandler>>();
  const requestHandlers = new Map<string, ServerRequestHandler>();
  let closed = false;
  let exited = false;
  let connectionNextId = 1;

  // Write a string to the child's stdin
  function write(data: string): void {
    if (closed) return;
    try {
      proc.stdin.write(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!exited) {
        console.error(`[codex] Failed to write to app server: ${msg}`);
      }
      rejectAll("App server stdin write failed: " + msg);
    }
  }

  // Reject all pending requests (used on process exit or close)
  function rejectAll(reason: string): void {
    for (const entry of pending.values()) {
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
        Promise.resolve()
          .then(() => handler(msg.params))
          .then(
            (res) => write(formatResponse(msg.id, res)),
            (err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(`[codex] Error in request handler for "${msg.method}": ${errMsg}`);
              write(JSON.stringify({
                id: msg.id,
                error: { code: -32603, message: `Handler error: ${errMsg}` },
              }) + "\n");
            },
          );
      } else {
        write(JSON.stringify({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }) + "\n");
      }
      return;
    }

    if (isNotification(msg)) {
      const handlers = notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch (e) {
            console.error(`[codex] Error in notification handler for "${msg.method}": ${e instanceof Error ? e.message : String(e)}`);
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
    } catch (e) {
      if (!closed && !exited) {
        console.error(`[codex] Read loop error: ${e instanceof Error ? e.message : String(e)}`);
        rejectAll("Read loop failed unexpectedly");
      }
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

  // Drain stderr and log non-empty output
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true }).trim();
        if (text) {
          console.error(`[codex] app-server stderr: ${text}`);
        }
      }
    } catch (e) {
      if (!closed && !exited) {
        console.error(`[codex] Warning: stderr reader failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // --- Build the client object ---

  function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed) { reject(new Error("Client is closed")); return; }
      if (exited) { reject(new Error("App server process exited unexpectedly")); return; }

      const id = connectionNextId++;
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

  /** Register a handler for server-sent requests. Only one handler per method;
   *  a new registration replaces the previous one (with a warning). */
  function onRequest(method: string, handler: ServerRequestHandler): () => void {
    if (requestHandlers.has(method)) {
      console.error(`[codex] Warning: replacing existing request handler for "${method}"`);
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

  /** Wait for the process to exit within the given timeout. */
  function waitForExit(timeoutMs: number): Promise<boolean> {
    return Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    rejectAll("Client closed");

    // Close stdin to signal the server to exit
    try {
      proc.stdin.end();
    } catch (e) {
      if (!exited) {
        console.error(`[codex] Warning: stdin.end() failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (process.platform === "win32") {
      // Windows: no SIGTERM equivalent — process termination is immediate.
      // Kill the process tree first via taskkill /T /F, then fall back to
      // proc.kill(). This order matters: if codex is a .cmd wrapper, killing
      // the direct child first removes the PID that taskkill needs to traverse
      // the tree, potentially leaving the real app-server alive.
      // Note: we intentionally do NOT await readLoop/proc.exited here because
      // Bun's test runner on Windows doesn't fully await async finally blocks,
      // and the extra latency causes inter-test process races. The process is
      // already dead after taskkill+kill, so the dangling promise is benign.
      if (proc.pid) {
        try {
          const r = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "pipe", timeout: 5000 });
          // status 128: process already exited; null: spawnSync timed out
          if (r.status !== 0 && r.status !== null && r.status !== 128) {
            const msg = r.stderr?.toString().trim();
            console.error(`[codex] Warning: taskkill exited ${r.status}${msg ? ": " + msg : ""}`);
          }
        } catch (e) {
          console.error(`[codex] Warning: process tree cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try { proc.kill(); } catch (e) {
        if (!exited) {
          console.error(`[codex] Warning: proc.kill() failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }

    // Unix: wait for graceful exit, then escalate
    if (await waitForExit(5000)) { await readLoop; return; }
    proc.kill("SIGTERM");
    if (await waitForExit(3000)) { await readLoop; return; }
    proc.kill("SIGKILL");
    await proc.exited;
    await readLoop;
  }

  // --- Perform initialize handshake ---

  const initParams: InitializeParams = {
    clientInfo: { name: config.clientName, title: null, version: config.clientVersion },
    capabilities: null,
  };

  let initResult: InitializeResponse;
  try {
    initResult = await request<InitializeResponse>("initialize", initParams);
    notify("initialized");
  } catch (e) {
    await close();
    throw e;
  }

  return {
    request,
    notify,
    on,
    onRequest,
    respond,
    close,
    userAgent: initResult.userAgent,
  };
}
