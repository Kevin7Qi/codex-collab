// src/client.ts — direct stdio transport to the Codex app server
//
// The JSON-RPC plumbing (dispatch, pending tracking, line buffering) lives in
// rpc.ts and is shared with broker-client.ts; this file owns what is specific
// to the spawned child process: spawn, stdin/stdout wiring, stderr draining,
// exit monitoring, platform-specific shutdown, and the initialize handshake.

import { spawn as childSpawn, spawnSync } from "child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { acquireLockAsync } from "./lock";
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
  /** Called with the child's PID as soon as it is spawned, before the
   *  handshake. Lets a caller clean up an app-server it can otherwise only
   *  reach through the returned client — which never arrives if the
   *  handshake hangs. Fires once per attempt, so a retry reports the new
   *  PID and the old one is already dead. */
  onSpawn?: (pid: number) => void;
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
   *  On Unix: close stdin -> wait 5s -> SIGTERM -> wait 3s -> SIGKILL,
   *  signalling the app-server's process group so grandchildren die too.
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

  // Spawn the child process. Node's child_process (not Bun.spawn, which has
  // no `detached`) so the app-server gets its own process group on Unix —
  // close() can then signal the whole tree (-pid) instead of only the direct
  // child, which orphaned grandchildren (wrapper scripts, mid-turn shell
  // commands). The CLI's own pgroup is untouched. Not used on Windows, where
  // detached also detaches the console; tree termination there is taskkill /T.
  const detached = process.platform !== "win32";
  // On Windows, npm installs `codex` as a `codex.cmd` shim, which
  // child_process.spawn refuses to launch without a shell (EINVAL since the
  // CVE-2024-27980 hardening). Wrap with `cmd.exe /c` — the same thing
  // Bun.spawn did implicitly; windowsHide keeps the console window away.
  const argv = process.platform === "win32" ? ["cmd.exe", "/c", ...command] : command;
  const proc = childSpawn(argv[0], argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    detached,
    windowsHide: true,
  });

  let exited = false;

  if (proc.pid) {
    try {
      opts?.onSpawn?.(proc.pid);
    } catch (e) {
      // A misbehaving observer must not take down the connection it is
      // observing — the PID is a courtesy, not part of the handshake.
      console.error(`[codex] Warning: onSpawn observer threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Signal the app-server's process group (Unix, detached) with a fallback
   *  to the direct child; plain child kill elsewhere. */
  function killTree(signal?: NodeJS.Signals): void {
    if (detached && proc.pid) {
      try {
        process.kill(-proc.pid, signal ?? "SIGTERM");
        return;
      } catch {} // ESRCH (group gone) / EPERM — fall through to the child
    }
    try { proc.kill(signal); } catch (e) {
      if (!exited) {
        console.error(`[codex] Warning: proc.kill() failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** After the direct child is gone, its detached process group can still
   *  hold descendants (the group id stays reserved while any member lives).
   *  SIGTERM the group and, if members ignore it, escalate to SIGKILL —
   *  bounded at ~500ms and zero-cost when the group is already empty, so
   *  close() resolving really means the tree is gone. */
  async function sweepGroup(): Promise<void> {
    if (!detached || !proc.pid) return;
    const pgid = proc.pid;
    const groupAlive = () => {
      try { process.kill(-pgid, 0); return true; } catch { return false; }
    };
    if (!groupAlive()) return;
    try { process.kill(-pgid, "SIGTERM"); } catch { return; }
    for (let i = 0; i < 10 && groupAlive(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (groupAlive()) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
  }

  const endpoint = createRpcEndpoint({
    label: "codex",
    requestTimeout,
    send: (data) => {
      if (!proc.stdin.writable) throw new Error("stdin is not writable");
      proc.stdin.write(data);
    },
    downReason: () => (exited ? "App server process exited unexpectedly" : null),
    overflowReason: "App server response buffer exceeded maximum size",
    onOverflow: () => killTree(),
    writeFailedPrefix: "App server stdin write failed: ",
  });

  // Feed stdout into the endpoint line parser
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => endpoint.feed(chunk));

  // Async stdin errors (e.g. EPIPE racing process death) surface via the
  // exit handler below; an unhandled 'error' event would crash the CLI.
  proc.stdin.on("error", () => {});

  // Monitor process exit: reject all pending requests and notify close
  // handlers. A spawn failure (ENOENT — codex not installed) emits 'error'
  // and may never emit 'exit', so both settle the same state.
  const procGone = new Promise<void>((resolveGone) => {
    proc.once("exit", () => {
      exited = true;
      endpoint.fail("App server process exited unexpectedly");
      resolveGone();
    });
    proc.once("error", (err) => {
      exited = true;
      endpoint.fail(
        `Failed to start app server (${command.join(" ")}): ${err.message}\n` +
        `Ensure codex CLI is installed: npm install -g @openai/codex`,
      );
      resolveGone();
    });
  });

  // Drain stderr and log non-empty output. The tail is also retained: when
  // the process dies before the handshake completes, its stderr is the only
  // statement of WHY, and the exit alone ("process exited unexpectedly")
  // cannot tell a locked state directory from a crash.
  let stderrTail = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => {
    // Retain the RAW text. Stream chunk boundaries are arbitrary, so trimming
    // each chunk and joining with newlines rewrites the message: "database is"
    // + " locked" would become "database is\nlocked" and the classifier that
    // reads this tail would miss it. Trim only for display.
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    const text = chunk.trim();
    if (text) console.error(`[codex] app-server stderr: ${text}`);
  });

  /** Wait for the process to exit within the given timeout. The timer is
   *  cleared when the process wins the race — a leftover armed timer keeps
   *  the event loop alive, delaying CLI exit by up to the timeout for
   *  commands that don't call process.exit (kill, threads, peek, models). */
  function waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      procGone.then(() => {
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
      // Wait for the process to fully exit so a dangling exit listener
      // doesn't keep the event loop alive (which blocks background tasks
      // from reporting completion).
      await waitForExit(3000);
      return;
    }

    // Unix: wait for graceful exit, then escalate — group signals, so
    // grandchildren (wrapper scripts, mid-turn shell commands) die with
    // the app-server instead of being orphaned. Every exit path ends with
    // a group sweep: the leader dying says nothing about descendants (a
    // server exiting on stdin EOF can leave a spawned command running,
    // and a straggler can ignore the group SIGTERM).
    if (await waitForExit(config.appServerStdinExitWait)) { await sweepGroup(); return; }
    killTree("SIGTERM");
    if (await waitForExit(config.appServerTermExitWait)) { await sweepGroup(); return; }
    killTree("SIGKILL");
    await procGone;
    await sweepGroup();
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
    // Carry the stderr so callers can say what went wrong rather than only
    // that something did. Attached rather than wrapped: the message text is
    // what classifies retryability and what exitCodeForError reads.
    if (e instanceof Error && stderrTail) {
      (e as Error & { appServerStderr?: string }).appServerStderr = stderrTail;
    }
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

/**
 * Serialize app-server *initialization* against a CODEX_HOME.
 *
 * Codex takes an exclusive lock on its shared sqlite state while an
 * app-server starts, so two starting at once means one dies with
 * "failed to initialize state runtime". Measured on a fresh CODEX_HOME: six
 * concurrent starts lost 1-3 of them across three runs, and lost none once
 * serialized (~2s for all six). The window is initialization only —
 * app-servers coexist happily once up, which is why the lock is released as
 * soon as the handshake returns rather than held for the connection.
 *
 * Keyed on CODEX_HOME, because that is the resource that contends — a
 * per-workspace lock would not see a collision between two workspaces, which
 * is the common case (an editor session plus a run). The file itself lives in
 * our own state directory rather than codex's: we do not own ~/.codex, and a
 * tool that scatters files through another program's directory is a tool
 * people are right to distrust.
 *
 * FAILS OPEN. If the lock cannot be taken, start anyway and let the retry
 * absorb a collision: a coordination primitive that can wedge every startup
 * is worse than the race it removes. Third-party app-servers (the codex TUI,
 * an IDE) never take it either, so recovery is required regardless.
 */
/**
 * Where the startup lock for a given child environment lives.
 *
 * Derived, never configured. Uses the CHILD's home: connectDirect lets a
 * caller override CODEX_HOME (or HOME) for the spawned process, and keying on
 * the parent's would put two processes that share a child state directory on
 * different locks — serializing nothing.
 *
 * Exported for tests.
 */
export function startupLockPath(childEnv?: Record<string, string>): string {
  const env = { ...process.env, ...childEnv };
  const home = resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"));
  const key = createHash("sha256").update(home).digest("hex").slice(0, 16);
  return join(config.dataDir, "locks", `app-server-${key}.lock`);
}

export async function withStartupLock<T>(
  fn: () => Promise<T>,
  childEnv?: Record<string, string>,
): Promise<T> {
  let release: (() => void) | null = null;
  try {
    const lockPath = startupLockPath(childEnv);
    mkdirSync(join(config.dataDir, "locks"), { recursive: true, mode: 0o700 });
    // Bounds tuned to what this lock actually guards. A real initialization
    // measures 260-860ms (fresh home to a 333MB one), so a holder older than
    // ten seconds is dead or wedged, and breaking its lock is safe — a
    // resulting collision is what the retry below exists for. Failing open
    // after five seconds matters because release() runs in a finally, which
    // process.exit() skips: a run killed mid-startup leaves the file behind,
    // and at the defaults that cost every later invocation 30 seconds.
    release = await acquireLockAsync(lockPath, {
      staleThresholdMs: 10_000,
      maxAttempts: 100,
    });
  } catch (e) {
    console.error(`[codex] Warning: could not serialize app-server startup (${e instanceof Error ? e.message : String(e)}); starting anyway.`);
  }
  try {
    return await fn();
  } finally {
    release?.();
  }
}

/** How long to let a dying app-server release the sqlite state before the
 *  retry spawns its replacement. The lock is held only across initialization,
 *  so this is a settle delay, not a backoff schedule. */
const STARTUP_RETRY_DELAY_MS = 750;

/** Bound on the retained stderr tail. Enough for a stack trace or a few
 *  startup errors; small enough that a chatty app-server cannot grow it. */
const STDERR_TAIL_LIMIT = 4000;

/** SQLITE_CANTOPEN: the state directory is missing, unwritable, or not where
 *  codex was told to look. Distinct from contention and nearly its opposite —
 *  nothing is going to clear, so "wait and retry" would be actively wrong. */
const STATE_UNOPENABLE_SIGNATURES = [
  /unable to open database/i,
  /SQLITE_CANTOPEN/i,
];

/** SQLITE_BUSY / SQLITE_LOCKED: another process holds the exclusive lock.
 *  Only these justify telling someone to wait — codex's own wrapper message
 *  is NOT one of them, because it is emitted for every underlying cause
 *  including corruption and a full disk. */
const STATE_LOCK_SIGNATURES = [
  /database is locked/i,
  /database table is locked/i,
  /SQLITE_BUSY/i,
  /SQLITE_LOCKED/i,
];

/** Codex's wrapper around whatever actually went wrong. On its own it says
 *  only that the state database could not be brought up — the cause could be
 *  contention, permissions, corruption, or a full disk, so the advice has to
 *  stay open rather than assert one of them. */
const STATE_INIT_SIGNATURES = [
  /failed to initialize (the )?sqlite state runtime/i,
  /failed to initialize state runtime/i,
];

/** The stderr an app-server produced before it died, when the failure came
 *  from `connectDirect`'s handshake. Null for any other error. */
export function appServerStderrOf(e: unknown): string | null {
  const s = (e as { appServerStderr?: unknown } | null)?.appServerStderr;
  return typeof s === "string" && s.length > 0 ? s : null;
}

/** True when this failure survived a `connectDirectWithRetry` second attempt.
 *  A direct connection taken outside that wrapper spawned exactly once, and
 *  advice that says otherwise is telling the user something untrue about
 *  what was already tried. */
export function wasRetried(e: unknown): boolean {
  return (e as { appServerRetried?: unknown } | null)?.appServerRetried === true;
}

/** What an app-server's dying stderr says about codex's shared state, if
 *  anything. One classifier for every consumer — the retry decision, the
 *  retry notice, and the final explanation must not disagree about what
 *  went wrong. */
function classifyStateFailure(stderr: string | null): "locked" | "unopenable" | "uninitialized" | null {
  if (!stderr) return null;
  // Specific causes first: the wrapper wraps all of them, so testing it early
  // would swallow every cause into one verdict.
  if (STATE_UNOPENABLE_SIGNATURES.some((re) => re.test(stderr))) return "unopenable";
  if (STATE_LOCK_SIGNATURES.some((re) => re.test(stderr))) return "locked";
  if (STATE_INIT_SIGNATURES.some((re) => re.test(stderr))) return "uninitialized";
  return null;
}

function stateDirFromStderr(stderr: string): string {
  // codex names the directory in the message; prefer it over guessing at
  // CODEX_HOME, which the failing process may have resolved differently.
  // The path runs to the ": <cause>" separator or the end of the line — not
  // to the first space, which would cut "C:\\Users\\First Last\\.codex" in half.
  // A drive letter's colon is safe: the terminator requires colon-then-space.
  const m = stderr.match(/state runtime (?:under|at) (.+?)(?::\s|\s*$)/m);
  return m?.[1] ?? process.env.CODEX_HOME ?? "~/.codex";
}

/**
 * A plain-language explanation of why a connection failed, or null when we
 * have nothing better to say than the error itself.
 *
 * "App server process exited unexpectedly" is true and useless — it names a
 * symptom, and the cause sits in a stderr line the user has no reason to
 * connect to it. Same shape as `explainErrorInfo` for turn errors: return
 * advice only when it is actually specific.
 */
export function explainConnectionFailure(e: unknown): string | null {
  const stderr = appServerStderrOf(e);
  if (!stderr) return null;
  const kind = classifyStateFailure(stderr);
  if (kind === null) return null;
  const dir = stateDirFromStderr(stderr);
  // `ps aux` does not exist in cmd or PowerShell, and advice a user cannot
  // run is worse than none — it reads as "this tool was not built for you".
  const listProcesses = process.platform === "win32"
    ? "tasklist | findstr codex"
    : `ps aux | grep "codex app-server"`;

  if (kind === "unopenable") {
    return (
      `Codex could not open its state database in ${dir}. That directory is missing, ` +
      `not writable, or not where Codex expects it — retrying will not help.\n` +
      `Check it exists and is writable (CODEX_HOME overrides the location), then run ` +
      `'codex-collab health'.`
    );
  }

  if (kind === "locked") {
    // Only claim a retry when one actually happened: direct connections taken
    // outside connectDirectWithRetry (the post-handshake broker-busy fallback,
    // and any external caller) reach here having spawned exactly once.
    const retried = wasRetried(e) ? " This was already retried once." : "";
    return (
      `Another Codex process is using the shared state in ${dir}. Codex locks a database ` +
      `while an app server starts, so two starting at once cannot both win.${retried}\n` +
      `Wait a few seconds and run it again. If it keeps happening, look for a stuck app ` +
      `server with '${listProcesses}', or run 'codex-collab health'.`
    );
  }

  // The wrapper fired without naming a cause. Contention is the common one,
  // but corruption, a full disk and a permissions problem all land here too —
  // so point at the underlying error rather than asserting which it was.
  return (
    `Codex could not initialize its state database in ${dir}.\n` +
    `Most often another Codex process is starting at the same moment; it can also be a ` +
    `directory that is not writable, or a damaged database. The 'app-server stderr' line ` +
    `above carries the underlying cause. Check running app servers with '${listProcesses}', ` +
    `then run 'codex-collab health'.`
  );
}

/** True when the app-server died *while starting*, as opposed to never
 *  starting at all.
 *
 *  Codex initializes a shared sqlite state runtime under CODEX_HOME on
 *  startup and holds it exclusively while it does. A second app-server
 *  entering that window loses and exits — which is contention, not a broken
 *  install, and it clears in milliseconds. Distinguishing the two matters:
 *  retrying contention costs one spawn and usually succeeds, while retrying a
 *  missing binary just fails twice as slowly. */
function isTransientStartupFailure(e: unknown): boolean {
  // A directory that cannot be opened is as deterministic as a missing
  // binary: the second spawn fails identically, 750ms later.
  if (classifyStateFailure(appServerStderrOf(e)) === "unopenable") return false;
  const msg = e instanceof Error ? e.message : String(e);
  // Spawn failures (ENOENT — codex not installed) are deterministic and must
  // never be retried: it would double the wait for the same error and bury
  // the install hint. On Unix they surface one of two ways depending on which
  // loses the race — the spawn 'error' event, or the handshake write into a
  // stdin that was never opened — so neither wording is in the retry set.
  //
  // Windows is different and deliberately left alone: commands run through a
  // `cmd.exe /c` shim, so the shim always spawns and a missing binary reads
  // exactly like an app-server that started and died. It is retried, costing
  // one extra spawn before the same error surfaces. That ambiguity predates
  // this retry — the install hint never fired on Windows either — and the
  // only ways to break the tie are a localized cmd.exe message or a magic
  // exit code, both worse than paying a second of latency on a broken
  // install.
  return msg.includes("App server process exited unexpectedly");
}

/**
 * `connectDirect`, retried once when the app-server dies during startup.
 *
 * Use this anywhere a direct connection is a *fallback* — those paths spawn
 * an app-server moments after another one was killed or is still coming up,
 * which is exactly when the state-runtime collision happens. A single retry
 * converts that hard failure into a sub-second pause.
 */
export async function connectDirectWithRetry(opts?: ConnectOptions): Promise<AppServerClient> {
  try {
    return await withStartupLock(() => connectDirect(opts), opts?.env);
  } catch (e) {
    if (!isTransientStartupFailure(e)) throw e;
    const stderr = appServerStderrOf(e);
    console.error(
      classifyStateFailure(stderr) === "locked"
        ? `[codex] App server exited while starting — another Codex process is using the shared state in ${stateDirFromStderr(stderr!)}. Retrying once.`
        : "[codex] App server exited while starting. Retrying once.",
    );
    await new Promise((r) => setTimeout(r, STARTUP_RETRY_DELAY_MS));
    try {
      // Re-acquired per attempt, not held across the delay — blocking every
      // other startup while we wait would make one collision everyone's.
      return await withStartupLock(() => connectDirect(opts), opts?.env);
    } catch (again) {
      // Record that a second spawn happened, so the failure can say so and
      // nothing else has to claim it on faith.
      if (again instanceof Error) {
        (again as Error & { appServerRetried?: boolean }).appServerRetried = true;
      }
      throw again;
    }
  }
}
