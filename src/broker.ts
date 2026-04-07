/**
 * Per-workspace broker lifecycle: endpoint abstraction, state persistence,
 * session management, socket-based liveness probing, atomic spawn lock,
 * and connection logic with fallback to direct connection.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { BrokerState, SessionState, ParsedEndpoint } from "./types";
import { connectDirect, type AppServerClient } from "./client";
import { config, resolveStateDir } from "./config";
import { terminateProcessTree, isProcessAlive } from "./process";

/** JSON-RPC error code returned when the broker is busy with another request. */
export const BROKER_BUSY_RPC_CODE = -32001;

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
      typeof parsed.sessionDir === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BrokerState;
    }
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
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, BROKER_STATE_FILE);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
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
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, SESSION_STATE_FILE);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
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
const LOCK_MAX_ATTEMPTS = 600; // ~30s at 50ms avg sleep
const LOCK_STALE_THRESHOLD_MS = 60_000;

/**
 * Acquire an atomic lock file (`broker.lock`) for broker spawning.
 * Uses O_CREAT|O_EXCL, spins with 30-70ms jitter on contention, max ~30s.
 * Force-breaks locks older than 60s.
 * Returns a release function, or null if the lock cannot be acquired.
 */
export function acquireSpawnLock(stateDir: string): (() => void) | null {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, LOCK_FILE);
  let fd: number | undefined;

  for (let i = 0; i < LOCK_MAX_ATTEMPTS; i++) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected filesystem error
        console.error(`[broker] Warning: spawn lock creation failed: ${(e as Error).message}`);
        return null;
      }
      Bun.sleepSync(30 + Math.random() * 40);
    }
  }

  if (fd === undefined) {
    // Check if lock is stale
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < LOCK_STALE_THRESHOLD_MS) {
        return null; // Lock is held and not stale
      }
      // Lock is stale — force acquire after unlink
      fs.unlinkSync(lockPath);
    } catch (e) {
      // statSync/unlinkSync failed (ENOENT race) — try once more
      console.error(`[broker] Warning: stale lock recovery failed: ${(e as Error).message}`);
    }
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch {
      return null;
    }
  }

  const capturedFd = fd;
  return () => {
    try {
      fs.closeSync(capturedFd);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[broker] Warning: lock fd close failed: ${(e as Error).message}`);
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[broker] Warning: lock cleanup failed: ${(e as Error).message}`);
      }
    }
  };
}

// ─── Teardown ─────────────────────────────────────────────────────────────

/**
 * Tear down a broker: kill the process (if alive), remove the socket file
 * (if Unix), and clear the broker state file.
 */
export function teardownBroker(stateDir: string, state: BrokerState): void {
  // Kill process if PID is alive
  if (state.pid !== null && isProcessAlive(state.pid)) {
    terminateProcessTree(state.pid);
  }

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

  // Clear broker state
  clearBrokerState(stateDir);
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

// ─── Main connection entry point ──────────────────────────────────────────

/**
 * Ensure a live connection to the Codex app server for the given working directory.
 *
 * Current implementation: each invocation spawns a fresh `connectDirect` connection.
 * Session state is persisted so that runs within a recent session share a session ID.
 *
 * TODO: Full broker multiplexing (single long-lived process serving multiple callers
 * over a Unix/pipe socket) is deferred to a future task. When implemented:
 * - `broker.json` will contain a real endpoint and PID
 * - `isBrokerAlive` will probe the socket
 * - Callers will connect to the shared broker instead of spawning their own process
 *
 * Flow:
 * 1. Resolve state dir from cwd
 * 2. Check if session.json exists and is recent (< broker idle timeout)
 *    - If yes, reuse the session ID
 *    - If no, generate a new session ID
 * 3. Acquire spawn lock
 * 4. Spawn new connection via connectDirect({ cwd })
 * 5. Save broker state (endpoint: null, pid: null) + session state
 * 6. Release lock
 */
export async function ensureConnection(cwd: string): Promise<AppServerClient> {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });

  // Check for an existing recent session to reuse the session ID
  const existingSession = loadSessionState(stateDir);
  let sessionId: string;
  if (existingSession) {
    const ageMs = Date.now() - new Date(existingSession.startedAt).getTime();
    if (ageMs < config.defaultBrokerIdleTimeout) {
      sessionId = existingSession.sessionId;
    } else {
      sessionId = randomBytes(16).toString("hex");
    }
  } else {
    sessionId = randomBytes(16).toString("hex");
  }

  // Try to acquire spawn lock
  const release = acquireSpawnLock(stateDir);
  if (!release) {
    // Could not acquire lock — another process may be spawning.
    // Fall back to direct connection without broker tracking.
    return connectDirect({ cwd });
  }

  try {
    // Spawn new connection
    const client = await connectDirect({ cwd });

    const now = new Date().toISOString();

    // Save broker state with null endpoint and pid — actual broker
    // multiplexing is deferred (see TODO above)
    saveBrokerState(stateDir, {
      endpoint: null,
      pid: null,
      sessionDir: stateDir,
      startedAt: now,
    });

    // Save/update session state
    saveSessionState(stateDir, {
      sessionId,
      startedAt: existingSession?.startedAt ?? now,
    });

    return client;
  } finally {
    release();
  }
}
