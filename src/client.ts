// src/client.ts — direct stdio transport to the Codex app server
//
// The JSON-RPC plumbing (dispatch, pending tracking, line buffering) lives in
// rpc.ts and is shared with broker-client.ts; this file owns what is specific
// to the spawned child process: spawn, stdin/stdout wiring, stderr draining,
// exit monitoring, platform-specific shutdown, and the initialize handshake.

import { spawn } from "bun";
import { spawnSync } from "child_process";
import type { InitializeParams, InitializeResponse, RequestId } from "./types";
import { config } from "./config";
import {
  createRpcEndpoint,
  type NotificationHandler,
  type AnyNotificationHandler,
  type ServerRequestHandler,
} from "./rpc";

export type { RequestId } from "./types";
// Protocol helpers historically lived here; broker-server.ts and tests import
// them from this module.
export {
  formatNotification,
  formatResponse,
  parseMessage,
  isResponse,
  isError,
  isRequest,
  isNotification,
  type PendingRequest,
  type NotificationHandler,
  type AnyNotificationHandler,
  type ServerRequestHandler,
} from "./rpc";

/** Options for connectDirect(). */
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

/** The client interface returned by connectDirect(). */
export interface AppServerClient {
  /** Send a request and wait for a response. Rejects on timeout, error, or process exit. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a notification (fire-and-forget). */
  notify(method: string, params?: unknown): void;
  /** Register a handler for server-sent notifications. Returns an unsubscribe function. */
  on(method: string, handler: NotificationHandler): () => void;
  /** Register a wildcard handler that fires for every server-sent notification.
   *  Used by the broker to forward all notifications to clients without an
   *  allowlist of method names — new methods added by Codex's protocol must
   *  pass through automatically. Returns an unsubscribe function. */
  onAny(handler: AnyNotificationHandler): () => void;
  /** Register a handler for server-sent requests (e.g. approval). One handler per method;
   *  new registrations replace previous ones. Returns an unsubscribe function. */
  onRequest(method: string, handler: ServerRequestHandler): () => void;
  /** Send a response to a server-sent request. */
  respond(id: RequestId, result: unknown): void;
  /** Register a callback invoked when the connection closes unexpectedly
   *  (e.g. the app-server process exits). Not called on intentional close(). */
  onClose(handler: () => void): () => void;
  /** Close the connection and terminate the server process.
   *  On Unix: close stdin -> wait 5s -> SIGTERM -> wait 3s -> SIGKILL.
   *  On Windows: close stdin, then immediately terminate the process tree
   *  (no timed grace period, unlike Unix). */
  close(): Promise<void>;
  /** The user-agent string from the initialize handshake. */
  userAgent: string;
  /** True when the broker reported it is busy serving another client's turn.
   *  Always false for direct connections. */
  brokerBusy: boolean;
}

/**
 * Spawn the Codex app-server process, perform the initialize handshake,
 * and return an AppServerClient for request/response communication.
 */
export async function connectDirect(opts?: ConnectOptions): Promise<AppServerClient> {
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
        // On Windows, `codex` resolves to `codex.cmd` and Bun.spawn wraps it
        // with `cmd.exe /c`, which would otherwise show a console window for
        // the lifetime of the broker's app-server.
        windowsHide: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to start app server (${command.join(" ")}): ${msg}\n` +
        `Ensure codex CLI is installed: npm install -g @openai/codex`,
      );
    }
  })();

  let exited = false;

  const endpoint = createRpcEndpoint({
    label: "codex",
    requestTimeout,
    send: (data) => proc.stdin.write(data),
    downReason: () => (exited ? "App server process exited unexpectedly" : null),
    overflowReason: "App server response buffer exceeded maximum size",
    onOverflow: () => { try { proc.kill(); } catch {} },
    writeFailedPrefix: "App server stdin write failed: ",
  });

  // Start the read loop — reads stdout line-by-line
  const readLoop = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        endpoint.feed(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      if (!endpoint.isClosed() && !exited) {
        console.error(`[codex] Read loop error: ${e instanceof Error ? e.message : String(e)}`);
        endpoint.rejectAllPending("Read loop failed unexpectedly");
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Monitor process exit: reject all pending requests and notify close handlers
  proc.exited.then(() => {
    exited = true;
    endpoint.fail("App server process exited unexpectedly");
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
      if (!endpoint.isClosed() && !exited) {
        console.error(`[codex] Warning: stderr reader failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      reader.releaseLock();
    }
  })();

  /** Wait for the process to exit within the given timeout. The timer is
   *  cleared when the process wins the race — a leftover armed timer keeps
   *  the event loop alive, delaying CLI exit by up to the timeout for
   *  commands that don't call process.exit (kill, threads, peek, models). */
  function waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      proc.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async function close(): Promise<void> {
    if (endpoint.isClosed()) return;
    endpoint.markClosed();

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
      if (proc.pid) {
        try {
          const r = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "pipe", timeout: 5000, windowsHide: true });
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
      // Wait for the process to fully exit so dangling readLoop / proc.exited
      // promises don't keep the event loop alive (which blocks background tasks
      // from reporting completion).
      if (await waitForExit(3000)) { await readLoop; }
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
    capabilities: {
      // Required for thread/memoryMode/set (memory isolation of created
      // threads). Guardian (approvalsReviewer) does NOT need it.
      experimentalApi: true,
      optOutNotificationMethods: ["item/reasoning/textDelta"],
    },
  };

  let initResult: InitializeResponse;
  try {
    initResult = await endpoint.request<InitializeResponse>("initialize", initParams);
    endpoint.notify("initialized");
  } catch (e) {
    await close();
    throw e;
  }

  return {
    request: endpoint.request,
    notify: endpoint.notify,
    on: endpoint.on,
    onAny: endpoint.onAny,
    onRequest: endpoint.onRequest,
    respond: endpoint.respond,
    onClose: endpoint.onClose,
    close,
    userAgent: initResult.userAgent,
    brokerBusy: false,
  };
}
