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
const LOCK_MAX_ATTEMPTS = 600; // ~30s at 50ms avg sleep
const LOCK_STALE_THRESHOLD_MS = 60_000;

/**
 * Acquire an atomic lock file (`broker.lock`) for broker spawning.
 * Uses O_CREAT|O_EXCL, spins with 30-70ms jitter on contention, max ~30s.
 * Force-breaks locks older than 60s.
 * Returns a release function, or null if the lock cannot be acquired.
 */
export function acquireSpawnLock(stateDir: string): (() => void) | null {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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
    } catch (e) {
      console.error(`[broker] Warning: lock re-acquire after stale break failed: ${(e as Error).message}`);
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

/**
 * Spawn the broker-server as a detached process.
 * Returns the PID of the spawned process.
 */
function spawnBrokerServer(
  endpoint: string,
  cwd: string,
  stateDir: string,
): number {
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

  const proc = Bun.spawn(["bun", ...args], {
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    cwd,
  });

  // Unref so the parent process can exit without waiting for the broker
  proc.unref();

  fs.closeSync(logFd);

  if (!proc.pid) {
    throw new Error("Failed to spawn broker server: no PID returned");
  }

  return proc.pid;
}

/**
 * Wait for the broker to become alive by polling the socket.
 * Returns true if alive within the timeout, false otherwise.
 */
async function waitForBrokerReady(
  endpoint: string,
  timeoutMs = 10_000,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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

  // 1. Check if an existing broker is alive
  const existingState = loadBrokerState(stateDir);
  if (existingState?.endpoint) {
    if (await isBrokerAlive(existingState.endpoint)) {
      try {
        const { connectToBroker } = await import("./broker-client");
        const client = await connectToBroker({ endpoint: existingState.endpoint });

        // If broker is busy and caller needs streaming, fall back to direct.
        // Non-streaming callers (kill, threads, etc.) keep the broker connection
        // so they can inspect/interrupt the active turn.
        if (client.brokerBusy && streaming) {
          await client.close();
          console.error("[broker] Broker is busy — using direct connection for this invocation.");
          try { saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt }); } catch { /* non-fatal */ }
          return connectDirect({ cwd });
        }

        // Update session state (non-fatal if save fails — connection is valid)
        try {
          saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
        } catch (e) {
          console.error(`[broker] Warning: failed to save session state: ${(e as Error).message}`);
        }

        return client;
      } catch (e) {
        // Connection to existing broker failed — tear it down and spawn fresh
        console.error(
          `[broker] Warning: failed to connect to existing broker: ${(e as Error).message}. Spawning new one.`,
        );
        teardownBroker(stateDir, existingState);
      }
    } else {
      // Broker is not alive — clean up stale state
      teardownBroker(stateDir, existingState);
    }
  }

  // 2. Acquire spawn lock
  const release = acquireSpawnLock(stateDir);
  if (!release) {
    // Could not acquire lock — another process may be spawning.
    // Fall back to direct connection.
    console.error("[broker] Warning: could not acquire spawn lock. Using direct connection.");
    return connectDirect({ cwd });
  }

  try {
    // Re-check after lock acquisition (another process may have spawned while we waited)
    const freshState = loadBrokerState(stateDir);
    if (freshState?.endpoint && await isBrokerAlive(freshState.endpoint)) {
      try {
        const { connectToBroker } = await import("./broker-client");
        const client = await connectToBroker({ endpoint: freshState.endpoint });
        if (client.brokerBusy && streaming) {
          await client.close();
          console.error("[broker] Broker is busy — using direct connection for this invocation.");
          try { saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt }); } catch { /* non-fatal */ }
          return connectDirect({ cwd });
        }
        try {
          saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
        } catch (e) {
          console.error(`[broker] Warning: failed to save session state: ${(e as Error).message}`);
        }
        return client;
      } catch (e) {
        console.error(`[broker] Warning: failed to connect to existing broker after lock: ${(e as Error).message}. Spawning new one.`);
        teardownBroker(stateDir, freshState);
      }
    }

    // 3. Spawn a new broker
    const endpoint = createEndpoint(stateDir);
    let pid: number;
    try {
      pid = spawnBrokerServer(endpoint, cwd, stateDir);
    } catch (e) {
      // Broker spawn failed — fall back to direct connection
      console.error(
        `[broker] Warning: failed to spawn broker: ${(e as Error).message}. Using direct connection.`,
      );
      const client = await connectDirect({ cwd });
      try {
        const now = new Date().toISOString();
        saveBrokerState(stateDir, { endpoint: null, pid: null, sessionDir: stateDir, startedAt: now });
        saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
      } catch (e) {
        console.error(`[broker] Warning: failed to persist broker state: ${(e as Error).message}`);
      }
      return client;
    }

    // 4. Wait for the broker to be ready
    const ready = await waitForBrokerReady(endpoint);
    if (!ready) {
      // Broker didn't start in time — kill the orphaned process and fall back to direct
      console.error("[broker] Warning: broker did not become ready in time. Using direct connection.");
      if (pid) {
        try { terminateProcessTree(pid); } catch { /* best effort */ }
      }
      const client = await connectDirect({ cwd });
      try {
        const now = new Date().toISOString();
        saveBrokerState(stateDir, { endpoint: null, pid: null, sessionDir: stateDir, startedAt: now });
        saveSessionState(stateDir, { sessionId, startedAt: sessionStartedAt });
      } catch (e) {
        console.error(`[broker] Warning: failed to persist broker state: ${(e as Error).message}`);
      }
      return client;
    }

    // 5. Connect to the new broker
    try {
      const now = new Date().toISOString();
      saveBrokerState(stateDir, { endpoint, pid, sessionDir: stateDir, startedAt: now });
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
