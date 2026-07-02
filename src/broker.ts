/**
 * Per-workspace broker lifecycle: endpoint abstraction, state persistence,
 * session management, socket-based liveness probing, atomic spawn lock,
 * and connection logic with fallback to direct connection.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn as childSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BrokerState, SessionState, ParsedEndpoint } from "./types";
import { connectDirect, type AppServerClient } from "./client";
import { config, resolveStateDir } from "./config";
import { acquireLockAsync, LockTimeoutError } from "./lock";
import { terminateProcessTree, isProcessAlive } from "./process";

/** JSON-RPC error code returned when the broker is busy with another request. */
export const BROKER_BUSY_RPC_CODE = -32001;

/** True iff `e` is an RpcError carrying the BROKER_BUSY code. */
export function isBrokerBusyError(e: unknown): boolean {
  return !!e && typeof e === "object" &&
    (e as { rpcCode?: unknown }).rpcCode === BROKER_BUSY_RPC_CODE;
}

/**
 * If `e` is a BROKER_BUSY RpcError, replace its message with a user-friendly
 * one explaining the cause. Mutates in place to preserve the RpcError type
 * so upstream code can still pattern-match on `instanceof RpcError`.
 */
export function wrapBrokerBusy(e: unknown): unknown {
  if (isBrokerBusyError(e) && e instanceof Error) {
    e.message = "Codex broker is busy serving another invocation. Retry in a moment, or wait for the in-flight turn to finish.";
  }
  return e;
}

// ─── Endpoint abstraction ─────────────────────────────────────────────────

/**
 * Create a broker endpoint string for the given state directory.
 * - Unix/macOS: `unix:{stateDir}/broker.sock`
 * - Windows: `pipe:\\.\pipe\codex-collab-{random-hex}`
 */
export function createEndpoint(stateDir: string, platform?: string): string {
  const plat = platform ?? process.platform;
  if (plat === "win32") {
    const id = randomBytes(8).toString("hex");
    return `pipe:\\\\.\\pipe\\codex-collab-${id}`;
  }
  return `unix:${path.join(stateDir, "broker.sock")}`;
}

/**
 * Parse an endpoint string into its kind and path.
 * Throws on invalid format.
 */
export function parseEndpoint(endpoint: string): ParsedEndpoint {
  if (endpoint.startsWith("unix:")) {
    const p = endpoint.slice(5);
    if (!p) throw new Error(`Invalid endpoint: "${endpoint}" (empty path)`);
    return { kind: "unix", path: p };
  }
  if (endpoint.startsWith("pipe:")) {
    const p = endpoint.slice(5);
    if (!p) throw new Error(`Invalid endpoint: "${endpoint}" (empty path)`);
    return { kind: "pipe", path: p };
  }
  throw new Error(`Invalid endpoint: "${endpoint}" (expected unix: or pipe: prefix)`);
}

// ─── Broker state persistence ─────────────────────────────────────────────

const BROKER_STATE_FILE = "broker.json";

/** Load broker state from `{stateDir}/broker.json`. Returns null if missing or invalid. */
export function loadBrokerState(stateDir: string): BrokerState | null {
  const filePath = path.join(stateDir, BROKER_STATE_FILE);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic shape validation — endpoint may be null (deferred broker multiplexing)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (typeof parsed.endpoint === "string" || parsed.endpoint === null) &&
      (typeof parsed.pid === "number" || parsed.pid === null) &&
      typeof parsed.sessionDir === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BrokerState;
    }
    console.error("[broker] Warning: broker state file has invalid structure — ignoring");
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[broker] Warning: failed to load broker state: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

/** Save broker state to `{stateDir}/broker.json`. Creates the directory if needed. */
export function saveBrokerState(stateDir: string, state: BrokerState): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDir, BROKER_STATE_FILE);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Remove `{stateDir}/broker.json`. */
export function clearBrokerState(stateDir: string): void {
  const filePath = path.join(stateDir, BROKER_STATE_FILE);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

// ─── Session state persistence ────────────────────────────────────────────

const SESSION_STATE_FILE = "session.json";

/** Load session state from `{stateDir}/session.json`. Returns null if missing or invalid. */
export function loadSessionState(stateDir: string): SessionState | null {
  const filePath = path.join(stateDir, SESSION_STATE_FILE);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as SessionState;
    }
    console.error("[broker] Warning: session state file has invalid structure — ignoring");
    return null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[broker] Warning: failed to load session state: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  }
}

/** Save session state to `{stateDir}/session.json`. Creates the directory if needed. */
export function saveSessionState(stateDir: string, state: SessionState): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(stateDir, SESSION_STATE_FILE);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// ─── Broker liveness probe ────────────────────────────────────────────────

/**
 * Probe whether a broker is alive by attempting a socket connection.
 * Returns true if the connection succeeds within the timeout, false otherwise.
 */
export async function isBrokerAlive(endpoint: string | null, timeoutMs = 150): Promise<boolean> {
  // Null endpoint means broker multiplexing is deferred — not alive
  if (!endpoint) return false;

  let target: ParsedEndpoint;
  try {
    target = parseEndpoint(endpoint);
  } catch (e) {
    console.error(`[broker] Warning: cannot parse endpoint for liveness probe: ${(e as Error).message}`);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const socket = new net.Socket();
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));

    const timer = setTimeout(() => done(false), timeoutMs);

    socket.connect({ path: target.path });
  });
}

// ─── Spawn lock ───────────────────────────────────────────────────────────

const LOCK_FILE = "broker.lock";

/**
 * Acquire the broker-spawn lock (`broker.lock`) — see src/lock.ts for the
 * acquisition and stale-break semantics. Async so that signal handlers and
 * timers keep running during contention (a sync spin would block the event
 * loop for up to ~30s). Returns a release function, or null if the lock
 * cannot be acquired.
 */
export async function acquireSpawnLock(stateDir: string): Promise<(() => void) | null> {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, LOCK_FILE);
  try {
    return await acquireLockAsync(lockPath);
  } catch (e) {
    if (e instanceof LockTimeoutError) return null; // held and not stale
    console.error(`[broker] Warning: spawn lock creation failed: ${(e as Error).message}`);
    return null;
  }
}

// ─── Teardown ─────────────────────────────────────────────────────────────

/**
 * Remove broker artifacts (socket file and state file) without touching the
 * process. Safe to call when the broker is known to be gone — e.g. when the
 * socket liveness probe returned false — because it does not interpret
 * `state.pid` (which may by now refer to a recycled, unrelated user
 * process). Errors are logged, not thrown — cleanup is best-effort.
 */
export function clearBrokerArtifacts(stateDir: string, state: BrokerState): void {
  // Remove socket file for unix endpoints (skip if endpoint is null — deferred multiplexing)
  if (state.endpoint !== null) {
    try {
      const target = parseEndpoint(state.endpoint);
      if (target.kind === "unix") {
        try {
          fs.unlinkSync(target.path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[broker] Warning: socket cleanup failed: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      // parseEndpoint failed — skip socket cleanup
      console.error(`[broker] Warning: could not parse endpoint for socket cleanup: ${(e as Error).message}`);
    }
  }

  // Clear broker state. Don't propagate transient errors (e.g. Windows EBUSY
  // if the file handle hasn't been released yet) — teardown is a best-effort
  // recovery path; the next invocation can safely overwrite stale state.
  try {
    clearBrokerState(stateDir);
  } catch (e) {
    console.error(`[broker] Warning: could not clear broker state during teardown: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Tear down a broker we still believe is ours: kill the process (if alive),
 * then remove the socket and state files. Only call this when the broker's
 * socket has just responded to a liveness probe (so we know `state.pid`
 * still names our broker) — otherwise the saved PID may have been recycled
 * by the OS for an unrelated user process and we would SIGTERM/SIGKILL it.
 * For stale-state cleanup after a dead-socket probe, use
 * `clearBrokerArtifacts` instead.
 */
export function teardownBroker(stateDir: string, state: BrokerState): void {
  // Kill process if PID is alive
  if (state.pid !== null && isProcessAlive(state.pid)) {
    terminateProcessTree(state.pid);
  }
  clearBrokerArtifacts(stateDir, state);
}

// ─── Session ID helper ────────────────────────────────────────────────────

/**
 * Get the current session ID.
 * Checks `CODEX_COLLAB_SESSION_ID` env var first, then reads from `session.json`.
 */
export function getCurrentSessionId(stateDir: string): string | null {
  const envId = process.env.CODEX_COLLAB_SESSION_ID;
  if (envId) return envId;

  const session = loadSessionState(stateDir);
  return session?.sessionId ?? null;
}

// ─── Broker spawn ────────────────────────────────────────────────────────

/** Resolve the broker-server entry point path. */
function resolveBrokerServerPath(): string {
  // Check multiple locations:
  // 1. Built bundle (same directory as the running script, no extension)
  const builtNoExt = path.join(import.meta.dir, "broker-server");
  if (fs.existsSync(builtNoExt)) return builtNoExt;
  // 2. Source file (relative to this file's directory)
  const srcPath = path.join(import.meta.dir, "broker-server.ts");
  if (fs.existsSync(srcPath)) return srcPath;
  // 3. Source file from project root (when import.meta.dir is src/)
  const projectSrcPath = path.join(path.dirname(import.meta.dir), "src", "broker-server.ts");
  if (fs.existsSync(projectSrcPath)) return projectSrcPath;
  // Fall back — will likely fail at spawn time with a clear error
  return srcPath;
}

/** Handle returned by {@link spawnBrokerServer}. */
interface SpawnedBroker {
  pid: number;
  /** Resolves when the spawned process exits. Used to detect early crashes
   *  while we're polling the socket for readiness. */
  exited: Promise<number>;
}

/**
 * Spawn the broker-server as a detached process.
 *
 * `detached: true` puts the child in a new process group so SIGINT delivered
 * to the foreground CLI's pgrp does not propagate to the broker. Without
 * this, a single Ctrl-C in the CLI would tear down the shared broker.
 */
function spawnBrokerServer(
  endpoint: string,
  cwd: string,
  stateDir: string,
): SpawnedBroker {
  const brokerPath = resolveBrokerServerPath();
  const args = [
    "run",
    brokerPath,
    "serve",
    "--endpoint",
    endpoint,
    "--cwd",
    cwd,
    "--idle-timeout",
    String(config.defaultBrokerIdleTimeout),
  ];

  const logPath = path.join(stateDir, "broker.log");
  const logFd = fs.openSync(logPath, "a");

  // Use node's child_process.spawn — Bun.spawn does not expose `detached`,
  // and we need a new process group for SIGINT isolation.
  const proc = childSpawn("bun", args, {
    stdio: ["ignore", logFd, logFd],
    cwd,
    detached: true,
    windowsHide: true,
  });

  fs.closeSync(logFd);
  proc.unref();

  if (!proc.pid) {
    throw new Error("Failed to spawn broker server: no PID returned");
  }

  const exited = new Promise<number>((resolve) => {
    proc.once("exit", (code) => resolve(code ?? 1));
  });

  return { pid: proc.pid, exited };
}

/**
 * Wait for the broker to become alive by polling the socket.
 * Returns true if alive within the timeout, false otherwise.
 *
 * Aborts early if the spawned broker process exits before becoming ready —
 * polling the full timeout against a dead pid is wasted time.
 */
async function waitForBrokerReady(
  endpoint: string,
  spawned: SpawnedBroker | null = null,
  timeoutMs = 10_000,
  pollMs = 100,
): Promise<boolean> {
  let exitedEarly = false;
  spawned?.exited.then(() => { exitedEarly = true; }).catch(() => {});

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitedEarly) return false;
    if (await isBrokerAlive(endpoint, 200)) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// ─── Main connection entry point ──────────────────────────────────────────

/**
 * Ensure a live connection to the Codex app server for the given working directory.
 *
 * Flow:
 * 1. Resolve state dir, ensure it exists, resolve/reuse session ID
 * 2. Check if an existing broker is alive (probe the socket)
 *    - If yes, connect to it via BrokerClient
 *    - If connection fails, tear down and proceed to spawn
 * 3. Acquire spawn lock (falls back to direct connection if lock unavailable)
 *    - Re-check for a broker after lock acquisition (race avoidance)
 * 4. Spawn a new broker, wait for it to become ready
 *    - Falls back to direct connection if spawn or readiness check fails
 * 5. Save broker state and session state before the connection attempt
 * 6. Connect to the new broker (falls back to direct connection on failure)
 */
export async function ensureConnection(cwd: string, streaming = false): Promise<AppServerClient> {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // Check for an existing recent session to reuse the session ID
  const existingSession = loadSessionState(stateDir);
  let sessionId: string;
  let sessionStartedAt: string;
  if (existingSession) {
    const ageMs = Date.now() - new Date(existingSession.startedAt).getTime();
    if (ageMs < config.defaultBrokerIdleTimeout) {
      sessionId = existingSession.sessionId;
      sessionStartedAt = existingSession.startedAt;
    } else {
      sessionId = randomBytes(16).toString("hex");
      sessionStartedAt = new Date().toISOString();
    }
  } else {
    sessionId = randomBytes(16).toString("hex");
    sessionStartedAt = new Date().toISOString();
  }

  const saveSession = (): void => {
    // Non-fatal if save fails — the connection being returned is valid
    try {
      saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
    } catch (e) {
      console.error(`[broker] Warning: failed to save session state: ${(e as Error).message}`);
    }
  };

  /**
   * Probe and connect to the broker recorded in `state`. Returns a client on
   * success, or null when the caller should proceed to spawn: no state, dead
   * socket, or a failed connection attempt (the broker is torn down first).
   *
   * If the broker is busy and the caller needs streaming, falls back to a
   * standalone direct connection. The broker enforces single-stream
   * ownership over its shared app-server, but parallel invocations in the
   * same workspace are still expected to work — they get their own
   * app-server. Non-streaming callers (kill, threads, etc.) keep the broker
   * connection so they can inspect/interrupt the active turn.
   */
  const connectToExisting = async (state: BrokerState | null): Promise<AppServerClient | null> => {
    if (!state?.endpoint) return null;
    if (!(await isBrokerAlive(state.endpoint))) return null;
    try {
      const { connectToBroker } = await import("./broker-client");
      const client = await connectToBroker({ endpoint: state.endpoint });
      if (client.brokerBusy && streaming) {
        await client.close();
        console.error("[broker] Broker is busy — using direct connection for this invocation.");
        saveSession();
        return connectDirect({ cwd });
      }
      saveSession();
      return client;
    } catch (e) {
      // Connection to existing broker failed — tear it down and spawn fresh
      console.error(
        `[broker] Warning: failed to connect to existing broker: ${(e as Error).message}. Spawning new one.`,
      );
      teardownBroker(stateDir, state);
      return null;
    }
  };

  // 1. Check if an existing broker is alive. Dead-socket artifact cleanup is
  // deliberately deferred until we hold the spawn lock: unlinking the fixed
  // socket path here could race another process that just spawned a broker
  // bound to it (probe-then-unlink TOCTOU).
  const existingState = loadBrokerState(stateDir);
  const existingClient = await connectToExisting(existingState);
  if (existingClient) return existingClient;

  // 2. Acquire spawn lock
  const release = await acquireSpawnLock(stateDir);
  if (!release) {
    // Could not acquire lock — another process may be spawning.
    // Fall back to direct connection.
    console.error("[broker] Warning: could not acquire spawn lock. Using direct connection.");
    return connectDirect({ cwd });
  }

  try {
    // Re-check after lock acquisition (another process may have spawned while we waited)
    const freshState = loadBrokerState(stateDir);
    const freshClient = await connectToExisting(freshState);
    if (freshClient) return freshClient;

    // Under the lock no other process can be spawning, so state naming a
    // dead broker is safely removable now — clean up before binding a new
    // socket at the same path. Does not touch the process: the saved PID
    // may already refer to a recycled, unrelated one.
    if (freshState) clearBrokerArtifacts(stateDir, freshState);

    // Reusable fallback: log, save session state best-effort, return a
    // direct connection. Deliberately does NOT persist broker state — a
    // saved `endpoint: null` would make every subsequent invocation skip
    // broker entirely (silent permanent disable). Letting the next call
    // see no broker state means it tries to spawn again, which we want.
    const fallbackToDirect = async (reason: string): Promise<AppServerClient> => {
      console.error(`[broker] Warning: ${reason}. Using direct connection.`);
      try {
        saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
      } catch (e) {
        console.error(`[broker] Warning: failed to save session state: ${(e as Error).message}`);
      }
      return connectDirect({ cwd });
    };

    // 3. Spawn a new broker
    const endpoint = createEndpoint(stateDir);
    let spawned: SpawnedBroker;
    try {
      spawned = spawnBrokerServer(endpoint, cwd, stateDir);
    } catch (e) {
      return fallbackToDirect(`failed to spawn broker: ${(e as Error).message}`);
    }

    // 4. Wait for the broker to be ready (aborts early if it crashes)
    const ready = await waitForBrokerReady(endpoint, spawned);
    if (!ready) {
      try {
        terminateProcessTree(spawned.pid);
      } catch (e) {
        console.error(`[broker] Warning: could not terminate orphaned broker pid ${spawned.pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return fallbackToDirect("broker did not become ready in time — see broker.log for the spawn failure reason");
    }

    // 5. Connect to the new broker
    try {
      const now = new Date().toISOString();
      saveBrokerState(stateDir, { endpoint, pid: spawned.pid, sessionDir: stateDir, startedAt: now });
      saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
    } catch (e) {
      console.error(`[broker] Warning: failed to persist broker state: ${(e as Error).message}. Next invocation may not find this broker.`);
    }

    try {
      const { connectToBroker } = await import("./broker-client");
      return await connectToBroker({ endpoint });
    } catch (e) {
      // Broker connection failed after spawn — fall back to direct
      console.error(
        `[broker] Warning: failed to connect to new broker: ${(e as Error).message}. Using direct connection.`,
      );
      return connectDirect({ cwd });
    }
  } finally {
    release();
  }
}
