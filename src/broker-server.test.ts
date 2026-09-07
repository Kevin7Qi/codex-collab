/**
 * Tests for broker-server.ts — the detached broker process that multiplexes
 * JSON-RPC messages between socket clients and a single app-server child.
 *
 * Strategy: Spawn broker-server.ts as a real subprocess with a mock app-server
 * script on PATH. The mock app-server speaks just enough JSON-RPC to satisfy
 * the initialize handshake and respond to requests. Test clients connect via
 * Unix socket and exercise concurrency control, approval forwarding, idle
 * timeout, and shutdown.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import type { FileSink, Subprocess } from "bun";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "broker-server-test-"));
});

/**
 * rm -rf, tolerating Windows' asynchronous handle release.
 *
 * Windows refuses to remove a directory while any process still holds a
 * handle inside it, and releases those handles some time after exit. Unix
 * does not care, which is why this only surfaced once the suite ran on
 * Windows: every test in the file failed in teardown, whatever the test
 * itself did.
 */
async function removeDirWithRetry(dir: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Give up quietly. A leftover temp directory the OS will reap is not worth
  // failing an otherwise-passing suite over.
}

afterEach(async () => {
  // Kill any broker processes we spawned
  for (const proc of spawnedProcesses) {
    try { proc.kill(); } catch {}
  }
  // Wait for them to actually be gone before touching the directory they
  // live in — see removeDirWithRetry. Killing only sends the signal.
  await Promise.all(spawnedProcesses.map((p) => p.exited.catch(() => undefined)));
  spawnedProcesses.length = 0;
  await removeDirWithRetry(tempDir);
});

const spawnedProcesses: Subprocess[] = [];

/**
 * Create a mock codex CLI script that speaks JSON-RPC when invoked as
 * `codex app-server`. The mock handles initialize, thread/start, turn/start,
 * turn/interrupt, thread/read, thread/list, and review/start.
 *
 * It also supports sending notifications (item/started, turn/completed) after
 * turn/start, and server-sent approval requests when MOCK_SEND_APPROVAL=1.
 */
/**
 * A connectable address for a broker under test.
 *
 * Unix gets a socket file inside the per-test temp dir. Windows gets a named
 * pipe — the transport the broker already uses there (`createEndpoint`) — but
 * the pipe namespace is GLOBAL and outlives any directory, so the name is
 * derived from the per-test dir (mkdtempSync guarantees uniqueness) plus the
 * pid, or a stale pipe from another test would be connected to instead.
 */
function testSocketPath(dir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\codex-collab-test-${process.pid}-${basename(dir)}`;
  }
  return join(dir, "broker.sock");
}

/** The `--endpoint` argument for a path from {@link testSocketPath}. */
function endpointFor(socketPath: string): string {
  return process.platform === "win32" ? `pipe:${socketPath}` : `unix:${socketPath}`;
}

/**
 * Materialize a mock `codex` that the broker will find on PATH.
 *
 * Unix takes a shebang script named `codex`. Windows can run neither form — a
 * shebang is not executable, and an extensionless file is not resolvable on
 * PATH at all — so the body ships as a `.ts` beside a `codex.cmd` shim. That
 * is the same shape npm installs, and the one `connectDirect` already expects
 * (it wraps commands in `cmd.exe /c` on Windows for exactly this reason).
 *
 * `@echo off` is load-bearing: the mock's stdout IS the JSON-RPC channel, and
 * an echoed command line would corrupt the stream before the handshake.
 */
function writeMockCodexScript(dir: string, script: string): void {
  if (process.platform === "win32") {
    writeFileSync(join(dir, "codex-mock.ts"), script);
    writeFileSync(join(dir, "codex.cmd"), `@echo off\r\nbun run "%~dp0codex-mock.ts" %*\r\n`);
    return;
  }
  writeFileSync(join(dir, "codex"), script, { mode: 0o755 });
}

/**
 * `process.env` with `dir` prepended to PATH, using the platform separator.
 *
 * Windows env names are case-insensitive, but a spread of `process.env` is a
 * plain object: an inherited `Path` would sit beside our `PATH` and either
 * could win. Drop every casing before setting ours.
 */
function envWithPathPrefix(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  let inherited = "";
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === "path") { inherited = v; continue; }
    env[k] = v;
  }
  env.PATH = `${dir}${delimiter}${inherited}`;
  // Hermetic: a developer running Codex's app-server daemon must not have
  // the broker under test attach to it instead of the mock on PATH.
  env.CODEX_COLLAB_SERVER = "private";
  return env;
}

function createMockCodex(dir: string, opts?: {
  /** Delay in ms before responding to turn/start */
  turnDelay?: number;
  /** If true, send a turn/completed notification after turn/start response */
  sendTurnCompleted?: boolean;
  /** If true, send an approval request after turn/start */
  sendApproval?: boolean;
  /** Emit an approval request for the turn BEFORE the turn/start response,
   *  which then follows 200 ms later — an approval racing its own start. */
  approvalBeforeResponse?: boolean;
  /** The method of that early request (default: a command approval). */
  earlyRequestMethod?: string;
  /** `thread/read` reports another client's turn in progress and turn/start
   *  announces nothing: the start was absorbed into that turn. */
  absorbedStart?: boolean;
  /** A predecessor turn's completion lands right after the submission, and
   *  our turn starts and finishes 100 ms later — all before the response. */
  predecessorCompletion?: boolean;
  /** A predecessor's completion lands while the broker's post-start
   *  `thread/read` is out, and that read reports OUR turn in progress; our
   *  turn is announced (and finished) only 500 ms after the start. */
  predecessorDuringRead?: boolean;
  /** `thread/read` fails; our turn is announced 300 ms after the start,
   *  asks an approval 50 ms later, and finishes at 700 ms. */
  undecidedThenOwn?: boolean;
  /** Delay in ms before sending turn/completed (after response) */
  turnCompletedDelay?: number;
  /** If true, write the turn/completed notification BEFORE the turn/start
   *  response. Simulates the fast-turn race where the app-server emits
   *  completion before the broker has parsed the start response. */
  completeBeforeResponse?: boolean;
  /** Delay in ms before responding to review/start. Lets tests disconnect
   *  the client mid-request to exercise the orphan-turn cleanup path. */
  reviewDelay?: number;
  /** If true, simulate a goal-mode thread: turn/start's completion is
   *  followed by a server-driven continuation turn (turn/started → delta →
   *  turn/completed) while the goal is active, then the goal completes. */
  goalContinuation?: boolean;
  /** If true, simulate a goal paused in the between-turns gap: the goal is
   *  active when turn 1 completes, but no continuation ever starts — a
   *  goal/updated(paused) lands instead (the kill/timeout brake). */
  goalPausedInGap?: boolean;
  /** If true, simulate a PRE-EXISTING active goal (resumed goal-mode
   *  thread): thread/goal/get answers with an active goal, but NO
   *  goal/updated notification ever fires — the broker can only learn the
   *  goal from the get traffic. A continuation turn starts after turn 1. */
  goalPreexisting?: boolean;
  /** If true, simulate the fast-turn race on a goal thread: goal/updated
   *  (active) AND turn/completed are written BEFORE the turn/start
   *  response, then a continuation turn starts. The broker must claim
   *  ownership despite the already-completed first turn. */
  goalFastFirstTurn?: boolean;
  /** If true, each turn gets its own id, and the SECOND turn is followed by
   *  a replay of the FIRST turn's completion — the late-arriving completion
   *  of a turn that was already settled (a watchdog-interrupted orphan, or
   *  a duplicate). The second turn itself never completes. */
  staleCompletionReplay?: boolean;
  /** If true, the FIRST turn/start announces its turn and then fails the
   *  request: turn/started is a notification and can land before the RPC
   *  settles, so the server is left running a turn this request will never
   *  report. Its completion arrives later, after a second turn has claimed
   *  the thread. */
  startedThenError?: boolean;
  /** If true, the review announces an INNER turn with its own id before the
   *  review turn completes — what real Codex does (observed on 0.147.0:
   *  review/start responds with turn A, then turn/started names turn B, then
   *  turn A completes). The inner turn/started must not make the broker treat
   *  the review's own completion as belonging to some other turn. */
  reviewInnerTurn?: boolean;
  /** If set, turn/interrupt rejects any turnId other than this one, with the
   *  mismatch message real Codex uses when a turn has rotated mid-run. */
  activeTurnId?: string;
}): string {
  const turnDelay = opts?.turnDelay ?? 0;
  const sendTurnCompleted = opts?.sendTurnCompleted ?? true;
  const sendApproval = opts?.sendApproval ?? false;
  const approvalBeforeResponse = opts?.approvalBeforeResponse ?? false;
  const earlyRequestMethod = opts?.earlyRequestMethod ?? "item/commandExecution/requestApproval";
  const absorbedStart = opts?.absorbedStart ?? false;
  const predecessorCompletion = opts?.predecessorCompletion ?? false;
  const predecessorDuringRead = opts?.predecessorDuringRead ?? false;
  const undecidedThenOwn = opts?.undecidedThenOwn ?? false;
  const turnCompletedDelay = opts?.turnCompletedDelay ?? 10;
  const completeBeforeResponse = opts?.completeBeforeResponse ?? false;
  const reviewDelay = opts?.reviewDelay ?? 0;
  const reviewInnerTurn = opts?.reviewInnerTurn ?? false;
  const startedThenError = opts?.startedThenError ?? false;
  const goalContinuation = opts?.goalContinuation ?? false;
  const goalPausedInGap = opts?.goalPausedInGap ?? false;
  const goalPreexisting = opts?.goalPreexisting ?? false;
  const goalFastFirstTurn = opts?.goalFastFirstTurn ?? false;
  const staleCompletionReplay = opts?.staleCompletionReplay ?? false;
  const activeTurnId = opts?.activeTurnId ?? null;

  const interruptLog = join(dir, "interrupts.log");
  const script = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
// Mock codex app-server for broker-server tests
const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  process.stderr.write("Mock codex: expected 'app-server' subcommand\\n");
  process.exit(1);
}

function respond(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

let buffer = "";
let approvalIdCounter = 1;
let turnCounter = 0;
// Bookkeeping the hygiene tests read back through mock/state.
const unsubscribed = [];
const calls = [];
const approvalAnswers = [];
const pendingServerRequests = new Map();
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    // Notification — no id
    if (msg.id === undefined) continue;

    // A response to one of this mock's own server requests (an approval
    // it emitted): hand it to whoever is waiting, never treat it as a call.
    if (msg.method === undefined) {
      const waiter = pendingServerRequests.get(String(msg.id));
      if (waiter) { pendingServerRequests.delete(String(msg.id)); waiter(msg); }
      continue;
    }

    calls.push(msg.method);
    switch (msg.method) {
      case "thread/resume":
        respond({ id: msg.id, result: {
          thread: { id: msg.params?.threadId || "thread-001", preview: "", modelProvider: "openai",
            createdAt: Date.now(), updatedAt: Date.now(), status: { type: "idle" }, path: null, cwd: "/tmp",
            cliVersion: "0.1.0", source: "mock", name: null, agentNickname: null, agentRole: null, gitInfo: null, turns: [] },
          model: "gpt-5.3-codex", modelProvider: "openai", cwd: "/tmp", approvalPolicy: "never", sandbox: null,
        }});
        break;

      case "thread/unsubscribe":
        unsubscribed.push(msg.params?.threadId);
        respond({ id: msg.id, result: { status: "unsubscribed" } });
        break;

      case "thread/loaded/list":
        respond({ id: msg.id, result: { data: [], nextCursor: null } });
        break;

      case "mock/state":
        respond({ id: msg.id, result: { unsubscribed: [...unsubscribed], calls: [...calls], approvalAnswers: [...approvalAnswers] } });
        break;

      case "mock/foreignApproval": {
        // A server request for a thread the caller names (default: one no
        // broker client ever claimed) — what a shared app-server sends every
        // subscribed client when the Codex app or a TUI is the one running
        // the turn. The method param picks the request kind. Reports whether the
        // broker answered within the wait (generous: CI runners are slow).
        const reqId = "foreign-" + (approvalIdCounter++);
        let answer = null;
        pendingServerRequests.set(reqId, (m) => { answer = m; });
        respond({
          id: reqId,
          method: msg.params?.method ?? "item/commandExecution/requestApproval",
          params: { threadId: msg.params?.threadId ?? "foreign-001", turnId: "turn-f", itemId: "item-f", command: "rm -rf /", cwd: "/tmp" },
        });
        setTimeout(() => {
          pendingServerRequests.delete(reqId);
          respond({ id: msg.id, result: { answered: answer !== null, answer } });
        }, 1500);
        break;
      }

      case "turn/steer":
        // Joining a running turn: the answer names the turn that is running.
        respond({ id: msg.id, result: { turnId: "turn-active" } });
        break;

      case "initialize":
        respond({ id: msg.id, result: { userAgent: "mock-codex/0.1.0" } });
        break;

      case "thread/start":
        respond({ id: msg.id, result: {
          thread: {
            id: "thread-001", preview: "", modelProvider: "openai",
            createdAt: Date.now(), updatedAt: Date.now(),
            status: { type: "idle" }, path: null, cwd: "/tmp",
            cliVersion: "0.1.0", source: "mock", name: null,
            agentNickname: null, agentRole: null, gitInfo: null, turns: [],
          },
          model: "gpt-5.3-codex", modelProvider: "openai",
          cwd: "/tmp", approvalPolicy: "never", sandbox: null,
        }});
        break;

      case "thread/goal/get": {
        ${goalPreexisting ? `
        respond({ id: msg.id, result: { goal: {
          threadId: msg.params?.threadId || "thread-001", objective: "pre-existing objective",
          status: "active", tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 1,
          createdAt: 1, updatedAt: 2,
        }}});
        ` : `
        respond({ id: msg.id, result: { goal: null } });
        `}
        break;
      }

      case "turn/start": {
        const threadId = msg.params?.threadId || "thread-001";
        ${startedThenError ? `
        turnCounter++;
        if (turnCounter === 1) {
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "inProgress", error: null } } });
          respond({ id: msg.id, error: { code: -32000, message: "simulated request failure after turn/started" } });
          setTimeout(() => {
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, 400);
        } else {
          respond({ id: msg.id, result: { turn: { id: "turn-002", items: [], status: "inProgress", error: null } } });
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-002", items: [], status: "inProgress", error: null } } });
        }
        break;
        ` : ""}
        ${staleCompletionReplay ? `
        turnCounter++;
        const thisTurnId = "turn-" + String(turnCounter).padStart(3, "0");
        respond({ id: msg.id, result: { turn: { id: thisTurnId, items: [], status: "inProgress", error: null } } });
        respond({ method: "turn/started", params: { threadId: threadId, turn: { id: thisTurnId, items: [], status: "inProgress", error: null } } });
        if (turnCounter === 1) {
          setTimeout(() => {
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, 30);
        } else {
          // Turn 2 is running. Replay turn 1's completion: already settled,
          // and the thread has changed hands since.
          setTimeout(() => {
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, 60);
        }
        break;
        ` : ""}
        ${goalFastFirstTurn ? `
        // Fast-turn race on a goal thread: goal becomes active and the turn
        // completes BEFORE the turn/start response reaches the broker.
        respond({ method: "thread/goal/updated", params: { threadId: threadId, turnId: "turn-001", goal: {
          threadId: threadId, objective: "fast goal", status: "active", tokenBudget: 1000,
          tokensUsed: 50, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2,
        }}});
        respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
        setTimeout(() => {
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-002", items: [], status: "inProgress", error: null } } });
          respond({ method: "item/agentMessage/delta", params: { threadId: threadId, turnId: "turn-002", itemId: "m2", delta: "continuation output" } });
        }, 60);
        ` : ""}
        ${completeBeforeResponse ? `
        // Fast-turn race: write turn/completed BEFORE the turn/start
        // response so they arrive at the broker in a single read chunk
        // with completion first.
        respond({
          method: "turn/completed",
          params: {
            threadId: threadId,
            turn: { id: "turn-001", items: [], status: "completed", error: null },
          },
        });
        ` : ""}
        ${undecidedThenOwn ? `
        setTimeout(() => {
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "inProgress", error: null } } });
          setTimeout(() => {
            const lateId = "approval-" + (approvalIdCounter++);
            pendingServerRequests.set(lateId, (m) => { approvalAnswers.push(m.result ?? m.error ?? null); });
            respond({ id: lateId, method: "item/commandExecution/requestApproval", params: { threadId: threadId, turnId: "turn-001", itemId: "item-late", command: "echo late", cwd: "/tmp" } });
          }, 50);
          setTimeout(() => {
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, 400);
        }, 300);
        ` : ""}
        ${predecessorDuringRead ? `
        setTimeout(() => {
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "inProgress", error: null } } });
          respond({ method: "item/agentMessage/delta", params: { threadId: threadId, turnId: "turn-001", itemId: "m1", delta: "own output" } });
          respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
        }, 500);
        ` : ""}
        ${predecessorCompletion ? `
        respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-000", items: [], status: "completed", error: null } } });
        setTimeout(() => {
          respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "inProgress", error: null } } });
          respond({ method: "item/agentMessage/delta", params: { threadId: threadId, turnId: "turn-001", itemId: "m1", delta: "own output" } });
          respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
        }, 100);
        ` : ""}
        ${approvalBeforeResponse ? `
        {
          const earlyId = "approval-" + (approvalIdCounter++);
          pendingServerRequests.set(earlyId, (m) => { approvalAnswers.push(m.result ?? m.error ?? null); });
          respond({
            id: earlyId,
            method: ${JSON.stringify(earlyRequestMethod)},
            params: { threadId: threadId, turnId: "turn-001", itemId: "item-early", command: "echo early", cwd: "/tmp" },
          });
        }
        ` : ""}
        setTimeout(() => {
          respond({ id: msg.id, result: {
            turn: { id: "turn-001", items: [], status: "inProgress", error: null },
          }});

          ${sendApproval ? `
          // Send approval request after turn/start response
          setTimeout(() => {
            const approvalId = "approval-" + (approvalIdCounter++);
            respond({
              id: approvalId,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: threadId,
                turnId: "turn-001",
                itemId: "item-001",
                command: "echo hello",
                cwd: "/tmp",
              },
            });
          }, 5);
          ` : ""}

          ${goalContinuation ? `
          // Goal-mode cascade: goal active → turn 1 completes → the server
          // starts a continuation on its own → continuation completes →
          // goal complete. Timings compressed but ordered like the real one.
          const goal = (status, tokensUsed) => ({
            threadId: threadId, objective: "mock objective", status: status,
            tokenBudget: 1000, tokensUsed: tokensUsed, timeUsedSeconds: 1,
            createdAt: 1, updatedAt: 2,
          });
          setTimeout(() => {
            respond({ method: "thread/goal/updated", params: { threadId: threadId, turnId: "turn-001", goal: goal("active", 100) } });
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, ${turnCompletedDelay});
          setTimeout(() => {
            respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-002", items: [], status: "inProgress", error: null } } });
            respond({ method: "item/agentMessage/delta", params: { threadId: threadId, turnId: "turn-002", itemId: "m2", delta: "continuation output" } });
          }, ${turnCompletedDelay} + 30);
          setTimeout(() => {
            respond({ method: "thread/goal/updated", params: { threadId: threadId, turnId: "turn-002", goal: goal("complete", 200) } });
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-002", items: [], status: "completed", error: null } } });
          }, ${turnCompletedDelay} + 60);
          ` : goalPausedInGap ? `
          // Goal active at turn 1's completion, then paused in the gap —
          // no continuation turn ever starts.
          const goal = (status) => ({
            threadId: threadId, objective: "mock objective", status: status,
            tokenBudget: 1000, tokensUsed: 100, timeUsedSeconds: 1,
            createdAt: 1, updatedAt: 2,
          });
          setTimeout(() => {
            respond({ method: "thread/goal/updated", params: { threadId: threadId, turnId: "turn-001", goal: goal("active") } });
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, ${turnCompletedDelay});
          setTimeout(() => {
            respond({ method: "thread/goal/updated", params: { threadId: threadId, turnId: null, goal: goal("paused") } });
          }, ${turnCompletedDelay} + 40);
          ` : goalPreexisting ? `
          // Pre-existing goal: NO goal/updated notifications at all — the
          // broker only knows the goal from thread/goal/get traffic. Turn 1
          // completes, then the server starts the continuation.
          setTimeout(() => {
            respond({ method: "turn/completed", params: { threadId: threadId, turn: { id: "turn-001", items: [], status: "completed", error: null } } });
          }, ${turnCompletedDelay});
          setTimeout(() => {
            respond({ method: "turn/started", params: { threadId: threadId, turn: { id: "turn-002", items: [], status: "inProgress", error: null } } });
            respond({ method: "item/agentMessage/delta", params: { threadId: threadId, turnId: "turn-002", itemId: "m2", delta: "continuation output" } });
          }, ${turnCompletedDelay} + 30);
          ` : sendTurnCompleted ? `
          setTimeout(() => {
            respond({
              method: "turn/completed",
              params: {
                threadId: threadId,
                turn: { id: "turn-001", items: [], status: "completed", error: null },
              },
            });
          }, ${turnCompletedDelay});
          ` : ""}
        }, ${approvalBeforeResponse ? 200 : turnDelay});
        break;
      }

      case "review/start": {
        const threadId = msg.params?.threadId || "thread-001";
        const reviewThreadId = "review-thread-001";
        setTimeout(() => {
          respond({ id: msg.id, result: {
            turn: { id: "review-turn-001", items: [], status: "inProgress", error: null },
            reviewThreadId: reviewThreadId,
          }});
          ${reviewInnerTurn ? `
          // Real Codex announces an inner turn under its own id partway
          // through the review, BEFORE the review turn itself completes.
          setTimeout(() => {
            respond({
              method: "turn/started",
              params: {
                threadId: reviewThreadId,
                turn: { id: "review-inner-001", items: [], status: "inProgress", error: null },
              },
            });
          }, 20);
          ` : ""}
          ${sendTurnCompleted ? `
          setTimeout(() => {
            respond({
              method: "turn/completed",
              params: {
                threadId: reviewThreadId,
                turn: { id: "review-turn-001", items: [], status: "completed", error: null },
              },
            });
          }, ${turnCompletedDelay});
          ` : ""}
        }, ${reviewDelay});
        break;
      }

      case "turn/interrupt":
        appendFileSync(${JSON.stringify(interruptLog)}, JSON.stringify({
          threadId: msg.params?.threadId ?? null,
          turnId: msg.params?.turnId ?? null,
        }) + "\\n");
        ${activeTurnId ? `
        if (msg.params?.turnId !== ${JSON.stringify(activeTurnId)}) {
          respond({ id: msg.id, error: { code: -32000, message: "expected active turn id " + msg.params?.turnId + " but found ${activeTurnId}" } });
          break;
        }` : ""}
        respond({ id: msg.id, result: {} });
        break;

      case "thread/read":
        ${undecidedThenOwn ? `
        respond({ id: msg.id, error: { code: -32000, message: "simulated read failure" } });
        break;
        ` : ""}
        ${predecessorDuringRead ? `
        respond({ method: "turn/completed", params: { threadId: msg.params?.threadId || "thread-001", turn: { id: "turn-000", items: [], status: "completed", error: null } } });
        setTimeout(() => respond({ id: msg.id, result: { thread: {
          id: msg.params?.threadId || "thread-001", preview: "", modelProvider: "openai", createdAt: Date.now(), updatedAt: Date.now(),
          status: { type: "active" }, path: null, cwd: "/tmp", cliVersion: "0.1.0", source: "mock", name: null,
          agentNickname: null, agentRole: null, gitInfo: null,
          turns: [{ id: "turn-001", status: "inProgress", items: [], error: null }],
        }}}), 100);
        break;
        ` : ""}
        respond({ id: msg.id, result: {
          thread: {
            id: msg.params?.threadId || "thread-001", preview: "",
            modelProvider: "openai", createdAt: Date.now(), updatedAt: Date.now(),
            status: { type: "idle" }, path: null, cwd: "/tmp",
            cliVersion: "0.1.0", source: "mock", name: null,
            agentNickname: null, agentRole: null, gitInfo: null,
            turns: ${absorbedStart ? '[{ id: "theirs-1", status: "inProgress", items: [], error: null }]' : '[]'},
          },
        }});
        break;

      case "thread/list":
        respond({ id: msg.id, result: { data: [], nextCursor: null } });
        break;

      case "model/list":
        respond({ id: msg.id, result: {
          data: [{ id: "mock-model", description: "mock", supportedReasoningEfforts: [] }],
          nextCursor: null,
        }});
        break;

      default:
        respond({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(1));
`;

  writeMockCodexScript(dir, script);
  return dir; // The dir to prepend to PATH
}

/**
 * Serve the mock app-server over a unix-socket WebSocket, the way Codex's
 * shared app-server listens on its control socket: each connection gets its
 * own mock child, JSON lines bridged both ways. Lets a broker attach to the
 * mock as a SHARED server (`CODEX_COLLAB_SERVER=shared` plus the socket
 * override), so the shared-only routing paths run against real framing.
 */
function serveMockOverSocket(mockCodexDir: string, socketPath: string): { stop: () => void } {
  const childOf = new Map<object, Subprocess>();
  const server = Bun.serve({
    unix: socketPath,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        const child = Bun.spawn([join(mockCodexDir, "codex"), "app-server"], {
          stdin: "pipe", stdout: "pipe", stderr: "inherit", env: envWithPathPrefix(mockCodexDir),
        });
        childOf.set(ws, child);
        spawnedProcesses.push(child);
        void (async () => {
          const reader = child.stdout.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
            let i: number;
            while ((i = buf.indexOf("\n")) !== -1) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (line) { try { ws.send(line); } catch { /* client gone */ } }
            }
          }
        })();
      },
      message(ws, raw) {
        const child = childOf.get(ws);
        if (!child) return;
        const stdin = child.stdin as FileSink;
        stdin.write(String(raw) + "\n");
        stdin.flush();
      },
      close(ws) {
        const child = childOf.get(ws);
        childOf.delete(ws);
        if (child) { try { (child.stdin as FileSink).end(); } catch { /* already closed */ } child.kill(); }
      },
    },
  });
  return {
    stop: () => {
      server.stop(true);
      for (const child of childOf.values()) child.kill();
      childOf.clear();
    },
  };
}

/** Spawn broker-server as a subprocess with the mock codex on PATH. */
function spawnBroker(
  endpoint: string,
  mockCodexDir: string,
  opts?: {
    idleTimeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
): Subprocess {
  const brokerPath = join(import.meta.dir, "broker-server.ts");
  const args = [
    "run", brokerPath, "serve",
    "--endpoint", endpoint,
    "--idle-timeout", String(opts?.idleTimeout ?? 30000),
  ];
  if (opts?.cwd) {
    args.push("--cwd", opts.cwd);
  }

  const proc = Bun.spawn(["bun", ...args], {
    // Peer off: these tests exercise routing, and an active peer would
    // write into the developer's REAL Claude session registry and keep the
    // broker resident past its idle timeout while any real session lives.
    env: { ...envWithPathPrefix(mockCodexDir), CODEX_COLLAB_PEER: "off", ...(opts?.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd ?? tempDir,
  });

  spawnedProcesses.push(proc);
  return proc;
}

/** Wait for the broker socket to become connectable. */
async function waitForSocket(
  sockPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const sock = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        sock.on("connect", () => { sock.destroy(); resolve(); });
        sock.on("error", reject);
        sock.connect({ path: sockPath });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`Socket ${sockPath} did not become available within ${timeoutMs}ms`);
}

/**
 * A minimal JSON-RPC client for testing. Connects to a Unix socket, performs
 * the initialize handshake, and provides request/notify/onMessage helpers.
 */
class TestClient {
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string | number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private notificationHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  private requestHandlers: Array<(msg: Record<string, unknown>) => void> = [];
  private allMessages: Array<Record<string, unknown>> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          this.allMessages.push(msg);
          this.dispatch(msg);
        } catch {}
      }
    });
  }

  static async connect(sockPath: string): Promise<TestClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = new net.Socket();
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("Connection timed out"));
      }, 5000);
      sock.on("connect", () => { clearTimeout(timer); resolve(sock); });
      sock.on("error", (err) => { clearTimeout(timer); reject(err); });
      sock.connect({ path: sockPath });
    });
    return new TestClient(socket);
  }

  /** Connect and perform the initialize handshake. */
  static async connectAndInit(sockPath: string): Promise<TestClient> {
    const client = await TestClient.connect(sockPath);
    const result = await client.request("initialize", {
      clientInfo: { name: "test", title: null, version: "0.0.1" },
      capabilities: { experimentalApi: false },
    }) as { userAgent: string };
    client.send({ method: "initialized" });
    return client;
  }

  private dispatch(msg: Record<string, unknown>): void {
    // Response (has id + result or error, no method)
    if (msg.id !== undefined && !("method" in msg)) {
      const entry = this.pending.get(msg.id as string | number);
      if (entry) {
        this.pending.delete(msg.id as string | number);
        if ("error" in msg) {
          const err = msg.error as { code: number; message: string };
          const error = new Error(err.message) as Error & { code: number };
          error.code = err.code;
          entry.reject(error);
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // Request from server (has id + method)
    if (msg.id !== undefined && "method" in msg) {
      for (const h of this.requestHandlers) h(msg);
      return;
    }

    // Notification (method, no id)
    if ("method" in msg && msg.id === undefined) {
      for (const h of this.notificationHandlers) h(msg);
    }
  }

  send(msg: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      this.pending.set(id, { resolve, reject });
      this.send(msg);
      // 10s timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 10_000);
    });
  }

  onNotification(handler: (msg: Record<string, unknown>) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (msg: Record<string, unknown>) => void): void {
    this.requestHandlers.push(handler);
  }

  get messages(): Array<Record<string, unknown>> {
    return this.allMessages;
  }

  async close(): Promise<void> {
    this.socket.end();
    await new Promise<void>((resolve) => {
      this.socket.on("close", resolve);
      if (this.socket.destroyed) resolve();
      setTimeout(resolve, 1000);
    });
  }

  get destroyed(): boolean {
    return this.socket.destroyed;
  }
}

/** Collect notifications from a client into an array. Returns the array ref. */
function collectNotifications(
  client: TestClient,
): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  client.onNotification((msg) => collected.push(msg));
  return collected;
}

/** Wait for a condition to become true within a timeout. */
async function waitFor(
  condFn: () => boolean,
  timeoutMs = 5000,
  pollMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condFn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("waitFor timed out");
}

async function exitsWithin(proc: Subprocess, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

// ─── Socket support detection ────────────────────────────────────────────────

// These integration tests spawn a real broker-server subprocess with a mock
// codex on PATH and connect over the broker's own transport — a Unix socket,
// or a named pipe on Windows, which broker-server already supports (every
// Unix-only branch there is guarded by `listenTarget.kind === "unix"`). The
// only requirement left is being able to bind one, which a sandbox can deny.
const IS_UNIX = process.platform !== "win32";
const SOCKETS_AVAILABLE = await (async () => {
  const checkDir = mkdtempSync(join(tmpdir(), "broker-sock-check-"));
  const testSock = testSocketPath(checkDir);
  try {
    const srv = net.createServer();
    await new Promise<void>((resolve, reject) => {
      srv.on("error", reject);
      srv.listen(testSock, () => { srv.close(); resolve(); });
    });
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(checkDir, { recursive: true, force: true }); } catch {}
  }
})();

// Say so out loud. This gate degrades on the ENVIRONMENT, not on a choice, so
// a run under a sandbox that blocks socket bind reports "0 fail" and exit 0
// while covering none of broker-server.ts. A skip count is not a signal
// anyone reads; a warning is.
if (!SOCKETS_AVAILABLE) {
  console.warn(
    `\n⚠️  broker-server suite SKIPPED — cannot bind ${IS_UNIX ? "a Unix socket" : "a named pipe"} here (sandbox or filesystem restriction).` +
    `\n   This run does NOT cover src/broker-server.ts. Re-run outside the sandbox before trusting it.\n`,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!SOCKETS_AVAILABLE)("broker-server", () => {

  // ── Initialize handshake ──────────────────────────────────────────────────

  describe("initialize handshake", () => {
    test("responds with userAgent locally, does not forward to app-server", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connect(sockPath);
        const result = await client.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string };

        expect(result.userAgent).toBe("codex-collab-broker");
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("initialize returns busy=false when no stream is active", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connect(sockPath);
        const result = await client.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("initialize reports busy=false even while a turn is active — the broker as a whole is never busy", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        // Client 1 establishes a stream
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 connects — with thread-scoped routing, the broker is not
        // globally busy; only thread-001 itself is contended.
        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(false);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a second turn on a DIFFERENT thread runs while a streaming request is pending", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        turnDelay: 1000,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const pendingTurn = client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // The first streaming request is still pending — a second client on
        // another thread must not be blocked by it.
        await new Promise((r) => setTimeout(r, 100));

        const client2 = await TestClient.connectAndInit(sockPath);
        const result = await client2.request("turn/start", {
          threadId: "thread-002",
          input: [{ type: "text", text: "hello too" }],
        }) as { turn: { id: string } };

        expect(result.turn.id).toBe("turn-001"); // mock's fixed turn id

        await pendingTurn;
        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("non-streaming error from stream owner preserves stream ownership", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Long-running turn that won't auto-complete during the test.
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Same socket sends a non-streaming RPC the mock rejects with -32601.
        // A failed unrelated request must not release the thread claim —
        // the turn on thread-001 is still running.
        let errored = false;
        try {
          await client1.request("nonexistent/method", {});
        } catch {
          errored = true;
        }
        expect(errored).toBe(true);

        // Thread ownership must still be held — a second client's turn/start
        // on the same thread bounces with -32001.
        const client2 = await TestClient.connectAndInit(sockPath);
        let busyCode: number | null = null;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "interloper" }],
          });
        } catch (e) {
          busyCode = (e as { code?: number }).code ?? null;
        }
        expect(busyCode).toBe(-32001);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("reports busy=false after a fast turn that completes before turn/start response", async () => {
      // Regression: when turn/completed arrives before the broker has finished
      // processing the turn/start response, the fast-completion branch cleared
      // activeRequestSocket but left activeRequestIsStreaming = true. Since
      // initialize computes busy as (activeStreamSocket !== null ||
      // activeRequestIsStreaming), the broker would report busy=true forever
      // and every subsequent streaming invocation would fall back to a direct
      // app-server until the broker restarted.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Force the race: the mock writes turn/completed *before* turn/start's
      // response, and `turnDelay > 0` makes the broker still be awaiting
      // appClient.request's resolution when it sees turn/completed.
      const mockDir = createMockCodex(tempDir, { completeBeforeResponse: true, turnDelay: 20 });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        // Give the broker time to drain any straggler notifications.
        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        // A fresh client should see busy=false. Pre-fix, this was true.
        const client2 = await TestClient.connect(sockPath);
        const result = await client2.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        }) as { userAgent: string; busy: boolean };

        expect(result.busy).toBe(false);
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("swallows initialized notification without error", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        // Send another initialized notification — should be silently ignored
        client.send({ method: "initialized" });
        // If the broker crashes or sends an error, the next request would fail
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Basic request forwarding ──────────────────────────────────────────────

  describe("request forwarding", () => {
    test("forwards thread/start to app-server and returns result", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const result = await client.request("thread/start", {
          cwd: "/tmp",
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }) as { thread: { id: string } };

        expect(result.thread.id).toBe("thread-001");
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("forwards thread/read and thread/list as read-only methods", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        const listResult = await client.request("thread/list") as { data: unknown[] };
        expect(listResult.data).toBeArrayOfSize(0);

        const readResult = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(readResult.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("returns JSON parse error for invalid JSON input", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        // Send raw invalid JSON
        client.send({ bogus: true } as any); // This is valid JSON but missing id/method
        // The broker ignores notifications without id, so this is just dropped.
        // Now send actually invalid JSON:
        (client as any).socket.write("not valid json\n");

        // Wait for error response
        await new Promise((r) => setTimeout(r, 200));

        const errorMsg = client.messages.find(
          (m) => m.id === null && (m as any).error?.code === -32700,
        );
        expect(errorMsg).toBeDefined();
        expect((errorMsg as any).error.message).toContain("Invalid JSON");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("ignores client notifications (no id)", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a notification (no id) — broker should silently ignore it
        client.send({ method: "some/notification", params: {} });

        // Verify the broker is still functional after receiving the notification.
        // NOTE: This only verifies the broker didn't crash. It does not verify that
        // the notification was NOT forwarded to the app-server, because the mock
        // app-server silently ignores notifications (no id) and there is no
        // observable side-effect to check from the client side.
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Concurrency control ───────────────────────────────────────────────────

  describe("concurrency control", () => {
    test("second client gets -32001 busy error for a turn on the SAME thread", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Use a long turn delay so the stream stays active
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn (streaming method)
        const turnResult = await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        expect(turnResult).toBeDefined();

        // Wait briefly for stream ownership to be established
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 tries to start a turn — should get busy error
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "world" }],
          });
          throw new Error("Expected busy error");
        } catch (err: any) {
          expect(err.message).toContain("A turn is already running on this thread");
          expect(err.code).toBe(-32001);
        }

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("second client can proceed after first client's turn completes", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed
        await new Promise((r) => setTimeout(r, 300));

        // Client 2 should now be able to make requests
        const result = await client2.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("turn/interrupt allowed from different socket during active stream", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for stream ownership
        await new Promise((r) => setTimeout(r, 100));

        // Client 2 sends turn/interrupt — should succeed (not blocked)
        const interruptResult = await client2.request("turn/interrupt", {
          threadId: "thread-001",
          turnId: "turn-001",
        });
        expect(interruptResult).toEqual({});

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("thread/read allowed from different socket during active stream", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Client 2 reads a thread — should succeed
        const readResult = await client2.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(readResult.thread.id).toBe("thread-001");

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("model/list allowed from different socket during active stream", async () => {
      // `models` makes exactly one server call, and withClient's busy→direct
      // fallback is streaming-only, so if model/list is not on the read-only
      // allowlist it is the one read that hard-fails on a busy broker.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        const result = await client2.request("model/list", {
          includeHidden: true,
        }) as { data: unknown[] };
        expect(result.data.length).toBe(1);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    // Unix-only by nature, not by convenience. The orphan needs a detached
    // app-server (connectDirect detaches on Unix only) AND a signal that runs
    // a handler — Windows has neither: the app-server is a plain child, and
    // `taskkill /T` takes the tree down together. The Windows guarantee is
    // covered directly by process.test.ts's "terminating a parent takes its
    // child with it".
    test.skipIf(!IS_UNIX)("a SIGTERM during startup reaps the app-server instead of orphaning it", async () => {
      // The window between spawning the app-server and installing the main
      // signal handlers. A parent that gives up on a slow broker SIGTERMs it
      // here; the app-server is spawned detached, in its own process group, so
      // the parent's group signal never reaches it. Without a guard the broker
      // dies on default disposition and leaves it running — holding codex's
      // sqlite state lock, which is exactly what the parent then retries into.
      const pidFile = join(tempDir, "app-server.pid");
      const mockDir = join(tempDir, "hang-mock");
      mkdirSync(mockDir, { recursive: true });
      // Never answers `initialize` — a wedged app-server is the usual reason
      // the parent gave up, and it means the broker never gets a client.
      writeMockCodexScript(mockDir, `#!/usr/bin/env bun
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`);

      const endpoint = endpointFor(testSocketPath(tempDir));
      const proc = spawnBroker(endpoint, mockDir);

      // Wait for the app-server to exist so there is something to orphan.
      let appPid = 0;
      for (let i = 0; i < 100 && !appPid; i++) {
        if (existsSync(pidFile)) appPid = Number(readFileSync(pidFile, "utf-8").trim());
        if (!appPid) await new Promise((r) => setTimeout(r, 50));
      }
      expect(appPid).toBeGreaterThan(0);

      const alive = (pid: number) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      expect(alive(appPid)).toBe(true);

      try {
        proc.kill("SIGTERM");
        let stillAlive = true;
        for (let i = 0; i < 60 && stillAlive; i++) {
          stillAlive = alive(appPid);
          if (stillAlive) await new Promise((r) => setTimeout(r, 100));
        }
        expect(stillAlive).toBe(false);
      } finally {
        try { process.kill(appPid, "SIGKILL"); } catch {}
        try { proc.kill("SIGKILL"); } catch {}
      }
    }, 20000);

    test("thread/list allowed from different socket during active stream", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Client 2 lists threads — should succeed
        const listResult = await client2.request("thread/list") as { data: unknown[] };
        expect(listResult.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("non-streaming request from same socket is allowed", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Start a turn (streaming)
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));

        // Same socket can still make requests (it owns the stream)
        const result = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(result.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Notification routing ──────────────────────────────────────────────────

  describe("notification routing", () => {
    test("turn/completed notification is forwarded to the stream-owning socket", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed notification
        await waitFor(() => notifications.some(
          (n) => n.method === "turn/completed",
        ), 3000);

        const turnCompleted = notifications.find((n) => n.method === "turn/completed");
        expect(turnCompleted).toBeDefined();
        expect((turnCompleted!.params as any).threadId).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a late completion from an already-settled turn does not free the thread", async () => {
      // A turn/interrupt is only an acknowledgement, so an orphan reaped by
      // the watchdog can still emit turn/completed afterwards — by which
      // time another turn may own the thread. Acting on it would release
      // that turn's claim and leave it running with nobody listening.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { staleCompletionReplay: true });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        // Turn 1 runs and completes — the thread is free.
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "one" }] });
        await waitFor(() => notifications.some((n) => n.method === "turn/completed"), 3000);

        // Turn 2 claims the thread; turn 1's completion is replayed while it runs.
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "two" }] });
        await new Promise((r) => setTimeout(r, 300));

        // The thread must still be owned: a competing start is refused.
        const other = await TestClient.connectAndInit(sockPath);
        let refused = false;
        try {
          await other.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "three" }] });
        } catch (e) {
          refused = (e as Error).message.includes("already running");
        }
        expect(refused).toBe(true);

        // And the stale completion was not forwarded a second time.
        expect(notifications.filter((n) => n.method === "turn/completed").length).toBe(1);

        await other.close();
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("notifications are not sent to non-owning sockets", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 50,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);
        const notifications1 = collectNotifications(client1);
        const notifications2 = collectNotifications(client2);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for turn/completed
        await waitFor(() => notifications1.some(
          (n) => n.method === "turn/completed",
        ), 3000);

        // Client 2 should NOT have received the notification
        expect(notifications2.length).toBe(0);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("two threads stream concurrently, each client receiving only its own thread's notifications", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Long enough completion delay that the two turns genuinely overlap.
      const mockDir = createMockCodex(tempDir, { turnCompletedDelay: 200 });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);
        const notifs1 = collectNotifications(client1);
        const notifs2 = collectNotifications(client2);

        // Both turns in flight at once — neither blocks the other.
        await Promise.all([
          client1.request("turn/start", {
            threadId: "thread-A",
            input: [{ type: "text", text: "one" }],
          }),
          client2.request("turn/start", {
            threadId: "thread-B",
            input: [{ type: "text", text: "two" }],
          }),
        ]);

        const completedFor = (notifs: Array<Record<string, unknown>>, threadId: string) =>
          notifs.some((n) =>
            n.method === "turn/completed" &&
            (n.params as { threadId?: string } | undefined)?.threadId === threadId);

        await waitFor(() => completedFor(notifs1, "thread-A") && completedFor(notifs2, "thread-B"));

        // Strict partition: neither client saw the other thread's traffic.
        expect(completedFor(notifs1, "thread-B")).toBe(false);
        expect(completedFor(notifs2, "thread-A")).toBe(false);

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  describe("goal-mode stream retention", () => {
    test("continuation-turn notifications keep flowing to the owner while the goal is active, and ownership releases when it completes", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { goalContinuation: true });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "work the goal" }],
        });

        // Pre-fix, ownership released at turn-001's completion and every
        // continuation notification was dropped: the goal-following client
        // never saw turn-002 start, stream, or complete.
        await waitFor(() => notifications.some(
          (n) => n.method === "turn/completed" && (n.params as any)?.turn?.id === "turn-002",
        ), 5000);

        const methods = notifications.map((n) => n.method);
        expect(methods).toContain("turn/started");
        expect(methods).toContain("item/agentMessage/delta");
        expect(notifications.some(
          (n) => n.method === "thread/goal/updated" && (n.params as any)?.goal?.status === "complete",
        )).toBe(true);

        // Goal complete + final turn/completed → ownership released: a
        // second client's streaming request must not be rejected busy.
        const client2 = await TestClient.connectAndInit(sockPath);
        const res = await client2.request("turn/start", {
          threadId: "thread-002",
          input: [{ type: "text", text: "next" }],
        });
        expect((res as any)?.turn?.id).toBeDefined();

        await client.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a PRE-EXISTING goal (no notifications) is learned from goal/get traffic and retains ownership", async () => {
      // Resumed goal-mode thread: the goal predates every client, so no
      // thread/goal/updated ever fires. The goal-following CLI's pre-turn
      // thread/goal/get is the broker's only signal — pre-fix, ownership
      // released at turn 1's completion and the continuation was invisible.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { goalPreexisting: true });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        // The CLI's pre-turn goal read — this is what teaches the broker.
        const goalRes = await client.request("thread/goal/get", { threadId: "thread-001" });
        expect((goalRes as any)?.goal?.status).toBe("active");

        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "resume the goal" }],
        });

        await waitFor(() => notifications.some((n) => n.method === "turn/started"), 5000);
        // The delta rides a separate chunk — await it rather than assert it.
        await waitFor(() => notifications.some((n) => n.method === "item/agentMessage/delta"), 5000);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a first goal turn completing before the turn/start response still claims ownership", async () => {
      // Fast-turn race: turn/completed arrives in the same chunk as the
      // turn/start response, so the normal claim is skipped — but the goal
      // is active and continuations are coming. Pre-fix, they had no owner
      // and the goal-following client waited blind until its timeout.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false, goalFastFirstTurn: true });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "work the goal" }],
        });

        await waitFor(() => notifications.some((n) => n.method === "turn/started"), 5000);
        await waitFor(() => notifications.some((n) => n.method === "item/agentMessage/delta"), 5000);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("goal ops are allowed through from another socket while a stream is owned", async () => {
      // kill/kill --clear must be able to read and brake a goal whose
      // following run owns the broker stream for the goal's whole lifetime.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const owner = await TestClient.connectAndInit(sockPath);
        await owner.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "long turn" }],
        });

        const killer = await TestClient.connectAndInit(sockPath);
        const res = await killer.request("thread/goal/get", { threadId: "thread-001" });
        expect((res as any)).toHaveProperty("goal"); // forwarded, not busy-rejected

        await owner.close();
        await killer.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a goal paused in the between-turns gap releases retained ownership", async () => {
      // Retention holds ownership after turn/completed while the goal is
      // active. If the goal is paused BEFORE the continuation starts (the
      // kill/timeout brake), no turn/completed will ever arrive — pre-fix
      // the broker stayed busy until the 30-minute orphan watchdog.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { goalPausedInGap: true });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "work the goal" }],
        });
        await waitFor(() => notifications.some(
          (n) => n.method === "thread/goal/updated" && (n.params as any)?.goal?.status === "paused",
        ), 5000);

        // Ownership must be free again: a second client can stream.
        const client2 = await TestClient.connectAndInit(sockPath);
        const res = await client2.request("turn/start", {
          threadId: "thread-002",
          input: [{ type: "text", text: "next" }],
        });
        expect((res as any)?.turn?.id).toBeDefined();

        await client.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Approval forwarding ───────────────────────────────────────────────────

  describe("shared app-server hygiene", () => {
    test.skipIf(process.platform === "win32")("an approval that outruns its own turn/start answer is held for the claim, then forwarded", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { approvalBeforeResponse: true, sendTurnCompleted: false });
      // Attached as a SHARED server: a claim settles only when its start
      // answers, and an approval arriving before that must wait, not vanish.
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connect(sockPath);
        const init = (await client.request("initialize", {
          clientInfo: { name: "test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: false },
        })) as { server?: { kind?: string } };
        client.send({ method: "initialized" });
        expect(init.server?.kind).toBe("shared");
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") client.send({ id: msg.id, result: { decision: "accept" } });
        });
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await waitFor(() => client.messages.some((m) => m.method === "item/commandExecution/requestApproval"), 3000);
        let answers: unknown[] = [];
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          answers = ((await client.request("mock/state")) as { approvalAnswers: unknown[] }).approvalAnswers;
          if (answers.length > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(answers).toEqual([{ decision: "accept" }]);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("a start absorbed into another client's running turn leaves that turn's question to its owner", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      // The question arrives before the start answers; the start was
      // absorbed into a turn another client is running (thread/read says
      // so, and no turn of ours is ever announced).
      const mockDir = createMockCodex(tempDir, {
        approvalBeforeResponse: true, earlyRequestMethod: "item/tool/requestUserInput", absorbedStart: true, sendTurnCompleted: false,
      });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        client.onRequest((msg) => {
          if (msg.method === "item/tool/requestUserInput") client.send({ id: msg.id, result: { answers: {} } });
        });
        await client.request("thread/start", { cwd: tempDir });
        const answer = (await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] })) as { absorbedBy?: unknown };
        expect(answer.absorbedBy).toBe("theirs-1"); // the broker's verdict rides on the answer
        await new Promise((r) => setTimeout(r, 800));
        const state = (await client.request("mock/state")) as { approvalAnswers: unknown[]; calls: string[] };
        // Neither declined by the broker nor forwarded to a client that
        // never owned the turn.
        expect(state.approvalAnswers).toEqual([]);
        expect(client.messages.some((m) => m.method === "item/tool/requestUserInput")).toBe(false);
        expect(state.calls).toContain("thread/read");
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("a start that fails after a turn was announced owns nothing on a shared server: no interrupt, thread released", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      // The mock announces turn-001, then fails the request. On a shared
      // server that announcement could be another client's turn.
      const mockDir = createMockCodex(tempDir, { startedThenError: true });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("thread/start", { cwd: tempDir });
        const failed = await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] }).catch((e: unknown) => e) as Error;
        expect(failed.message).toContain("simulated request failure");
        await new Promise((r) => setTimeout(r, 300));
        expect(existsSync(join(mockDir, "interrupts.log"))).toBe(false);
        // The claim is gone: a new start on the thread goes through.
        const again = (await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "again" }] })) as { turn: { id: string } };
        expect(again.turn.id).toBe("turn-002");
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test("an interrupt from a client whose claim only joined a turn is refused, never retargeted onto it", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false, activeTurnId: "turn-active" });
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await client.request("broker/joined", { threadId: "thread-001", turnId: "turn-active" });
        // A stale id the server would answer with "expected active turn id …
        // but found turn-active" — which must not be retargeted.
        const err = await client.request("turn/interrupt", { threadId: "thread-001", turnId: "turn-001" }).catch((e: unknown) => e) as Error;
        expect(err.message).toContain("belongs to another client");
        await new Promise((r) => setTimeout(r, 100));
        expect(existsSync(join(mockDir, "interrupts.log"))).toBe(false);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("shutdown waits for a start in flight to settle, then stops the turn it accepted", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { turnDelay: 300, sendTurnCompleted: false });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("thread/start", { cwd: tempDir });
        const start = client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 50)); // the start is out, unanswered
        const other = await TestClient.connectAndInit(sockPath);
        await other.request("broker/shutdown", {}).catch(() => undefined);
        await proc.exited;
        await start;
        // The shared server outlives the broker: the turn our start became
        // was stopped, not left running for nobody.
        const log = existsSync(join(mockDir, "interrupts.log")) ? readFileSync(join(mockDir, "interrupts.log"), "utf8") : "";
        expect(log).toContain("turn-001");
      } finally {
        proc.kill();
        fake.stop();
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("a predecessor's completion held before our turn appears does not end the claim: our turn's own story still arrives", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { predecessorCompletion: true, turnDelay: 250, sendTurnCompleted: false });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await waitFor(() => notifications.some((n) => n.method === "turn/completed" && (n.params as { turn?: { id?: string } }).turn?.id === "turn-001"), 3000);
        expect(notifications.some((n) => n.method === "item/agentMessage/delta")).toBe(true);
        // The claim ended with OUR turn, not the predecessor's: the thread is free again.
        const again = (await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "again" }] })) as { turn: { id: string } };
        expect(again.turn.id).toBe("turn-001");
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("a predecessor's completion landing during the ownership read does not outrank the thread reporting our turn", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { predecessorDuringRead: true, sendTurnCompleted: false });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await waitFor(() => notifications.some((n) => n.method === "turn/completed" && (n.params as { turn?: { id?: string } }).turn?.id === "turn-001"), 4000);
        expect(notifications.some((n) => n.method === "item/agentMessage/delta")).toBe(true);
        const again = (await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "again" }] })) as { turn: { id: string } };
        expect(again.turn.id).toBe("turn-001");
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test.skipIf(process.platform === "win32")("a start the server would not be read after keeps settling until the turn announces itself, then answers for it", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { undecidedThenOwn: true, sendTurnCompleted: false });
      const codexSock = join(tempDir, "cx.sock");
      const fake = serveMockOverSocket(mockDir, codexSock);
      const proc = spawnBroker(endpoint, mockDir, { env: { CODEX_COLLAB_SERVER: "shared", CODEX_COLLAB_SERVER_SOCKET: codexSock } });
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") client.send({ id: msg.id, result: { decision: "accept" } });
        });
        await client.request("thread/start", { cwd: tempDir });
        const answer = (await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] })) as { absorbedBy?: unknown };
        expect("absorbedBy" in answer).toBe(false); // undecided: no verdict to ride on
        await waitFor(() => notifications.some((n) => n.method === "turn/completed" && (n.params as { turn?: { id?: string } }).turn?.id === "turn-001"), 4000);
        // Our turn's announcement settled the claim: its approval was ours to answer.
        const state = (await client.request("mock/state")) as { approvalAnswers: unknown[] };
        expect(state.approvalAnswers).toEqual([{ decision: "accept" }]);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
        fake.stop();
      }
    }, 15_000);

    test("an interrupt from any connection naming a turn a claim only joined is refused", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false, activeTurnId: "turn-active" });
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const owner = await TestClient.connectAndInit(sockPath);
        await owner.request("thread/start", { cwd: tempDir });
        await owner.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await owner.request("broker/joined", { threadId: "thread-001", turnId: "turn-active" });
        // `kill` arrives on its own connection, naming the joined turn.
        const killer = await TestClient.connectAndInit(sockPath);
        const err = await killer.request("turn/interrupt", { threadId: "thread-001", turnId: "turn-active" }).catch((e: unknown) => e) as Error;
        expect(err.message).toContain("belongs to another client");
        await new Promise((r) => setTimeout(r, 100));
        expect(existsSync(join(mockDir, "interrupts.log"))).toBe(false);
        await killer.close();
        await owner.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 15_000);

    test("a thread is unsubscribed once its turn ends and nothing here needs it", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: true });
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        await waitFor(() => notifications.some((n) => n.method === "turn/completed"), 5000);
        // The release is deferred behind the peer hook; poll the mock's ledger.
        let released: string[] = [];
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          released = ((await client.request("mock/state")) as { unsubscribed: string[] }).unsubscribed;
          if (released.includes("thread-001")) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(released).toContain("thread-001");
        // The subscription is a per-connection fact, not a claim: the
        // thread is free for a new turn, which resubscribes on resume.
        await client.request("thread/resume", { threadId: "thread-001" }).catch(() => undefined);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    test("a request of any kind for a thread nobody here owns gets no answer, while our own thread's still gets method-not-found", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      // The turn must still be ours when the probe lands: a completion 10 ms
      // after the start would release the claim first on a slow runner.
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: false });
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const foreign = (await client.request("mock/foreignApproval", { method: "item/tool/requestUserInput" })) as { answered: boolean };
        expect(foreign.answered).toBe(false);
        // A thread this client claimed: the old answer stands, so the server
        // treats an unhandled question as declined and the turn moves on.
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "hi" }] });
        const ours = (await client.request("mock/foreignApproval", { method: "item/tool/requestUserInput", threadId: "thread-001" })) as { answered: boolean; answer: { error?: { code?: number } } };
        expect(ours.answered).toBe(true);
        expect(ours.answer.error?.code).toBe(-32601);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    test("a turn joined with turn/steer routes its events here but leaves its approvals to the client that owns it", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const joined = (await client.request("turn/steer", { threadId: "thread-001", expectedTurnId: "turn-active", input: [{ type: "text", text: "and this" }] })) as { turnId: string };
        expect(joined.turnId).toBe("turn-active");
        const outcome = (await client.request("mock/foreignApproval", { threadId: "thread-001" })) as { answered: boolean };
        expect(outcome.answered).toBe(false);
        expect(client.messages.some((m) => m.method === "item/commandExecution/requestApproval")).toBe(false);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    test("a client that joined a turn and then disconnected leaves that turn running and its claim released", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const joiner = await TestClient.connectAndInit(sockPath);
        await joiner.request("turn/steer", { threadId: "thread-001", expectedTurnId: "turn-active", input: [{ type: "text", text: "x" }] });
        await joiner.close(); // gone mid-turn — for an owned turn this arms the orphan watchdog and interrupts
        const other = await TestClient.connectAndInit(sockPath);
        // The claim is gone at once: a new turn on the thread is not refused as busy …
        let started = false;
        for (let i = 0; i < 50 && !started; i++) {
          try { await other.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "next" }] }); started = true; } catch { await new Promise((r) => setTimeout(r, 100)); }
        }
        expect(started).toBe(true);
        // … and nothing was interrupted.
        expect(existsSync(join(mockDir, "interrupts.log"))).toBe(false);
        await other.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    test("a turn on a thread the broker released is re-subscribed before it starts", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { sendTurnCompleted: true });
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);
        await client.request("thread/start", { cwd: tempDir });
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "one" }] });
        await waitFor(() => notifications.some((n) => n.method === "turn/completed"), 5000);
        // Idle release lands a tick later; wait for the unsubscribe to reach the mock.
        for (let i = 0; i < 60; i++) {
          if (((await client.request("mock/state")) as { unsubscribed: string[] }).unsubscribed.includes("thread-001")) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const before = ((await client.request("mock/state")) as { calls: string[] }).calls;
        expect(before).not.toContain("thread/resume");
        // A second turn without an explicit resume (the failed-steer fallback
        // shape). By the time turn/start answers, the broker has already
        // re-subscribed — the resume precedes the start in the mock's ledger.
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "two" }] });
        const calls = ((await client.request("mock/state")) as { calls: string[] }).calls;
        const lastResume = calls.lastIndexOf("thread/resume");
        const lastStart = calls.lastIndexOf("turn/start");
        expect(lastResume).toBeGreaterThan(-1);
        expect(lastResume).toBeLessThan(lastStart);
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });

    test("an approval for a thread nobody here owns is left for its owner to answer", async () => {
      const sockPath = join(tempDir, "broker.sock");
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);
      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        const outcome = (await client.request("mock/foreignApproval")) as { answered: boolean; answer: unknown };
        // Neither answered upstream nor forwarded to a client that never
        // claimed the thread.
        expect(outcome.answered).toBe(false);
        expect(client.messages.some((m) => m.method === "item/commandExecution/requestApproval")).toBe(false);
        // The broker is still healthy afterwards.
        expect(await client.request("thread/start", { cwd: tempDir })).toBeDefined();
        await client.close();
      } finally {
        proc.kill();
        await proc.exited;
      }
    });
  });

  describe("approval forwarding", () => {
    test("client receives forwarded approval request and responds — round-trip", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Set up approval response handler — when we receive a request
        // with method "item/commandExecution/requestApproval", respond with accept
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            // Respond with approval decision
            client.send({
              id: msg.id,
              result: { decision: "accept" },
            });
          }
        });

        // Start a turn (which triggers the mock to send an approval request)
        const turnResult = await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });
        expect(turnResult).toBeDefined();

        // Wait for the approval request to arrive and be responded to
        await waitFor(
          () => client.messages.some(
            (m) =>
              m.method === "item/commandExecution/requestApproval" &&
              m.id !== undefined,
          ),
          3000,
        );

        // Verify we received the forwarded approval request
        const approvalReq = client.messages.find(
          (m) => m.method === "item/commandExecution/requestApproval",
        );
        expect(approvalReq).toBeDefined();
        expect((approvalReq!.params as any).command).toBe("echo hello");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("malformed response (missing result and error) is rejected", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Respond to approval with neither result nor error
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            // Send malformed response — just id, no result or error
            client.send({ id: msg.id });
          }
        });

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for the approval request to arrive
        await waitFor(
          () => client.messages.some(
            (m) => m.method === "item/commandExecution/requestApproval",
          ),
          3000,
        );

        // The broker should reject the malformed response internally and log a
        // warning to stderr. We cannot easily verify the stderr warning from the
        // subprocess, nor can we observe the rejection sent to the app-server from
        // the client side. We verify the broker remains functional, which confirms
        // it handled the malformed response without crashing.
        await new Promise((r) => setTimeout(r, 200));

        // Broker should still be alive and respond to requests
        // (the stream owner is still this client, so same-socket request works)
        const result = await client.request("thread/read", {
          threadId: "thread-001",
          includeTurns: false,
        }) as { thread: { id: string } };
        expect(result.thread.id).toBe("thread-001");

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("socket disconnect during pending approval rejects only that socket's approvals", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        sendApproval: true,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Don't respond to approval — just disconnect
        let approvalReceived = false;
        client.onRequest((msg) => {
          if (msg.method === "item/commandExecution/requestApproval") {
            approvalReceived = true;
            // Don't respond — just disconnect
            setTimeout(() => client.close(), 50);
          }
        });

        // Start a turn
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Wait for approval to arrive and client to disconnect
        await waitFor(() => approvalReceived, 3000);
        await new Promise((r) => setTimeout(r, 200));

        // Broker should still be alive — connect a new client.
        // NOTE: We cannot directly verify that the pending approval was rejected
        // (sent back to the app-server as a reject response) because the mock
        // app-server does not expose that information. We verify indirectly: the
        // broker survives the disconnect and accepts new connections, which confirms
        // it cleaned up the pending approval state without deadlocking.
        const client2 = await TestClient.connectAndInit(sockPath);
        expect(client2.destroyed).toBe(false);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Socket permissions ────────────────────────────────────────────────────

  describe("socket permissions", () => {
    // A named pipe is not a filesystem object and carries no mode.
    test.skipIf(!IS_UNIX)("socket file has restrictive permissions (0o700)", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const stats = statSync(sockPath);
        // Socket permission bits — the file mode should have 0o700
        // On Linux, socket files may have 0o755 or similar, but the
        // chmodSync(path, 0o700) should set the permission bits.
        const permBits = stats.mode & 0o777;
        expect(permBits).toBe(0o700);
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── broker/shutdown RPC ───────────────────────────────────────────────────

  describe("broker/shutdown", () => {
    test("broker exits cleanly after broker/shutdown request", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      const client = await TestClient.connectAndInit(sockPath);

      // Send broker/shutdown
      const result = await client.request("broker/shutdown");
      expect(result).toEqual({});

      // Wait for process to exit
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-1), 5000)),
      ]);
      expect(exitCode).toBe(0);

      await client.close();
    }, 15_000);
  });

  describe("broker/shutdown ifIdle", () => {
    test("is refused while a turn is claimed, so a replacement never kills live work", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, { turnDelay: 3000 });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);
      const client = await TestClient.connectAndInit(sockPath);
      try {
        const started = await client.request("thread/start", { cwd: tempDir }) as { thread: { id: string } };
        // Claims the thread; the mock answers in 3s.
        const turn = client.request("turn/start", { threadId: started.thread.id, input: [] });
        await new Promise((r) => setTimeout(r, 200));

        let code: number | undefined;
        try {
          await client.request("broker/shutdown", { ifIdle: true });
        } catch (e) {
          code = (e as { code?: number }).code;
        }
        expect(code).toBe(-32001);
        // Still up, and the turn it protected finishes normally.
        expect(await exitsWithin(proc, 500)).toBe(false);
        await turn;

        // Unconditional shutdown is unchanged.
        expect(await client.request("broker/shutdown")).toEqual({});
        expect(await exitsWithin(proc, 5000)).toBe(true);
      } finally {
        await client.close();
      }
    }, 20_000);
  });

  // ── Idle timeout ──────────────────────────────────────────────────────────

  describe("idle timeout", () => {
    test("broker shuts down after idle timeout with no activity", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      // Use a very short idle timeout (1 second)
      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 1000 });
      await waitForSocket(sockPath);

      // Don't send any requests — just wait for the broker to exit
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-999), 5000)),
      ]);

      // Should exit with code 0 (idle timeout)
      expect(exitCode).toBe(0);
    }, 10_000);

    test("activity resets the idle timer", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      // Use a 2s idle timeout
      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 2000 });
      await waitForSocket(sockPath);

      const client = await TestClient.connectAndInit(sockPath);

      // Send periodic requests to keep the broker alive
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 800));
        await client.request("thread/list");
      }

      // At this point ~2.4s have passed, but the timer was reset each time
      // so the broker should still be alive
      const result = await client.request("thread/list") as { data: unknown[] };
      expect(result.data).toBeArrayOfSize(0);

      await client.close();

      // Now wait for idle timeout after closing
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-999), 5000)),
      ]);
      expect(exitCode).toBe(0);
    }, 15_000);

    test("active stream prevents idle shutdown", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 300 });
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "long running" }],
        });

        expect(await exitsWithin(proc, 900)).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("pending approval prevents idle shutdown", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendApproval: true,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 300 });
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "needs approval" }],
        });

        await waitFor(() => client.messages.some(m => m.method === "item/commandExecution/requestApproval"), 2000, 50);
        expect(await exitsWithin(proc, 900)).toBe(false);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 10_000);
  });

  // ── Buffer overflow protection ────────────────────────────────────────────

  describe("buffer overflow protection", () => {
    test("broker destroys socket when client sends >10MB without newlines", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 30000 });
      await waitForSocket(sockPath);

      try {
        // Use a raw socket (not TestClient) so we can flood data without
        // the JSON-RPC framing getting in the way.
        const rawSocket = new net.Socket();
        await new Promise<void>((resolve, reject) => {
          rawSocket.on("connect", resolve);
          rawSocket.on("error", reject);
          rawSocket.connect({ path: sockPath });
        });

        // Complete the initialize handshake first so the broker accepts us
        rawSocket.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", title: null, version: "1.0" }, capabilities: { experimentalApi: false } } }) + "\n");
        await new Promise((r) => setTimeout(r, 100));

        // Now flood >10MB without newlines. Use a single large write to
        // maximize the chance the broker receives it all in one chunk.
        let destroyed = false;
        rawSocket.on("close", () => { destroyed = true; });
        rawSocket.on("error", () => { destroyed = true; });

        // Write in a loop with drain handling to ensure data actually flows
        const chunkSize = 256 * 1024; // 256KB — typical kernel buffer unit
        const target = 11 * 1024 * 1024; // 11MB > MAX_BUFFER_SIZE (10MB)
        let written = 0;

        while (written < target && !destroyed) {
          const chunk = "x".repeat(chunkSize);
          const canWrite = rawSocket.write(chunk);
          written += chunkSize;
          if (!canWrite && !destroyed) {
            // Wait for drain before writing more (close/timeout as safety).
            // Remove whichever listeners didn't fire — a leftover close
            // listener per drain cycle piles up into MaxListenersExceeded.
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                rawSocket.off("drain", done);
                rawSocket.off("close", done);
                resolve();
              };
              const timer = setTimeout(done, 1000);
              rawSocket.once("drain", done);
              rawSocket.once("close", done);
            });
          }
        }

        // Wait for the broker to detect overflow and destroy our socket
        await waitFor(() => destroyed, 30000, 50);
        expect(destroyed).toBe(true);

        rawSocket.destroy();
      } finally {
        proc.kill();
      }
    }, 30_000);
  });

  // ── Multiple clients ──────────────────────────────────────────────────────

  describe("multiple clients", () => {
    test("multiple clients can connect and make sequential requests", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);
        const client3 = await TestClient.connectAndInit(sockPath);

        // Each client makes a non-streaming request sequentially
        const r1 = await client1.request("thread/list") as { data: unknown[] };
        expect(r1.data).toBeArrayOfSize(0);

        const r2 = await client2.request("thread/list") as { data: unknown[] };
        expect(r2.data).toBeArrayOfSize(0);

        const r3 = await client3.request("thread/list") as { data: unknown[] };
        expect(r3.data).toBeArrayOfSize(0);

        await client1.close();
        await client2.close();
        await client3.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("client disconnect during stream preserves concurrency lock until turn completes", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a turn
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        // Use a longer delay to ensure stream ownership is firmly established
        await new Promise((r) => setTimeout(r, 300));

        // Client 1 disconnects while stream is active
        await client1.close();
        // Wait long enough for broker to process the disconnect and set sentinel
        await new Promise((r) => setTimeout(r, 300));

        // Client 2 tries to start a new streaming request — should be blocked
        // because the orphaned stream is still a sentinel (turn never completed)
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "next" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("client disconnect before turn/start response preserves request lock", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        turnDelay: 1000,
        sendTurnCompleted: false,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        void client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "slow start" }],
        }).catch(() => undefined);

        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-001",
            input: [{ type: "text", text: "must not interleave" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan stream stays reserved after a successful interrupt RPC", async () => {
      // Regression: the orphan path used to drop the stream reservation
      // when turn/interrupt succeeded, on the assumption that success meant
      // the turn was fully cancelled. But turn/interrupt only acknowledges
      // the request; the app-server may still be unwinding. A second
      // streaming client could then start a turn on the same app-server
      // while the previous one was mid-cancel. Reserve before the
      // interrupt and let the natural turn/completed (or the watchdog)
      // release.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Delay the turn/start response so the broker is awaiting
      // appClient.request when client1 disconnects — that is the only
      // condition that triggers the orphan branch on the post-response
      // path. Don't send turn/completed so the reservation must come from
      // the orphan code, not from the normal completion flow.
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        turnDelay: 300,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        void client1.request("turn/start", {
          threadId: "thread-orphan",
          input: [{ type: "text", text: "go" }],
        }).catch(() => undefined);

        // Disconnect during the broker's await on appClient.request, so
        // the orphan branch fires when the response finally arrives.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();
        // Wait long enough for the response (turnDelay=300ms) to land,
        // the orphan path to set up the reservation, and turn/interrupt
        // to come back as success.
        await new Promise((r) => setTimeout(r, 500));

        // A second client must NOT be able to start a streaming RPC on
        // the SAME thread while the orphan is still unwinding — the
        // reservation survives the successful interrupt RPC.
        const client2 = await TestClient.connectAndInit(sockPath);
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "thread-orphan",
            input: [{ type: "text", text: "no" }],
          });
        } catch (err) {
          gotBusy = true;
          // -32001 = BROKER_BUSY
          expect((err as { code?: number }).code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        // A DIFFERENT thread is unaffected by the unwinding orphan.
        const other = await client2.request("turn/start", {
          threadId: "thread-orphan-2",
          input: [{ type: "text", text: "fine" }],
        }) as { turn: { id: string } };
        expect(other.turn.id).toBe("turn-001");
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan fast turn (completed before response) does NOT hold the stream slot", async () => {
      // Regression: when a streaming client disconnects mid-request AND its
      // turn/completed lands before the turn/start response is processed (the
      // fast-turn race), the orphan path must NOT reserve the stream slot — the
      // turn is already done, so there is nothing to unwind. Reserving would
      // pin the broker busy until the watchdog fires (ORPHAN_WATCHDOG_MS = idle
      // timeout), forcing every other client onto direct connections meanwhile.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // completeBeforeResponse: the single turn/completed (turn-001) is written
      // before the turn/start response; turnDelay holds the response so the
      // client can disconnect after the completion but before the response
      // lands. sendTurnCompleted:false ensures NO second completion is sent
      // after the response — that's what production does (one completion per
      // turn), and a second completion would mask the bug by naturally
      // releasing the (incorrect) orphan reservation.
      const mockDir = createMockCodex(tempDir, {
        completeBeforeResponse: true,
        sendTurnCompleted: false,
        turnDelay: 300,
      });

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        void client1.request("turn/start", {
          threadId: "thread-fast-orphan",
          input: [{ type: "text", text: "go" }],
        }).catch(() => undefined);

        // Disconnect after turn/completed is processed (sent first) but before
        // the delayed turn/start response arrives.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();
        // Let the response land (turnDelay=300ms) and the orphan branch run.
        await new Promise((r) => setTimeout(r, 500));

        // The slot must be free: a second streaming client must NOT get busy.
        const client2 = await TestClient.connectAndInit(sockPath);
        let result: unknown;
        let busyErr: { code?: number } | null = null;
        try {
          result = await client2.request("turn/start", {
            threadId: "thread-fast-orphan-2",
            input: [{ type: "text", text: "ok" }],
          });
        } catch (err) {
          busyErr = err as { code?: number };
        }
        expect(busyErr).toBeNull();
        expect(result).toBeDefined();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("review client disconnect before review/start response interrupts the review subthread", async () => {
      // Regression: the orphan path read params.threadId (parent) and sent
      // turn/interrupt there, while the actual review turn runs on the
      // response's reviewThreadId. The interrupt missed, so the review kept
      // running and held the broker's stream slot until natural completion.
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
        reviewDelay: 200, // window for the client to disconnect mid-flight
      });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 5000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);

        // Fire-and-forget so we can close before the response lands.
        void client1.request("review/start", {
          threadId: "thread-parent",
          target: { type: "uncommittedChanges" },
        }).catch(() => undefined);

        // Disconnect before reviewDelay elapses — the broker is still
        // awaiting appClient.request, and the orphan-detection branch will
        // fire once that promise resolves with the review subthread.
        await new Promise((r) => setTimeout(r, 50));
        await client1.close();

        await waitFor(() => { try { return readFileSync(interruptLog, "utf-8").includes("\n"); } catch { return false; } }, 5000, 50); // a complete line, not merely the file
        const interrupts = readFileSync(interruptLog, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Must target the review subthread, NOT the parent.
        expect(interrupts).toContainEqual({
          threadId: "review-thread-001",
          turnId: "review-turn-001",
        });
        expect(interrupts).not.toContainEqual({
          threadId: "thread-parent",
          turnId: "review-turn-001",
        });
      } finally {
        proc.kill();
      }
    }, 10_000);

    test("orphan watchdog interrupts with threadId and turnId", async () => {
      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: false,
      });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpoint, mockDir, { idleTimeout: 1000 });
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        await client1.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "hello" }],
        });

        await new Promise((r) => setTimeout(r, 100));
        await client1.close();

        await waitFor(() => { try { return readFileSync(interruptLog, "utf-8").includes("\n"); } catch { return false; } }, 5000, 50); // a complete line, not merely the file
        const interrupts = readFileSync(interruptLog, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(interrupts).toContainEqual({
          threadId: "thread-001",
          turnId: "turn-001",
        });
      } finally {
        proc.kill();
      }
    }, 10_000);
  });

  // ── Streaming methods ─────────────────────────────────────────────────────

  describe("streaming methods", () => {
    test("review/start claims the review SUBTHREAD and frees the parent", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      // Use a long turn-completed delay so stream stays active during the test
      const mockDir = createMockCodex(tempDir, {
        sendTurnCompleted: true,
        turnCompletedDelay: 5000,
      });

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client1 = await TestClient.connectAndInit(sockPath);
        const client2 = await TestClient.connectAndInit(sockPath);

        // Client 1 starts a review (streaming method)
        const reviewResult = await client1.request("review/start", {
          threadId: "thread-001",
          target: { type: "uncommittedChanges" },
        }) as { turn: { id: string }; reviewThreadId: string };
        expect(reviewResult.reviewThreadId).toBe("review-thread-001");

        // The review turn runs on the subthread — that is what's claimed.
        let gotBusy = false;
        try {
          await client2.request("turn/start", {
            threadId: "review-thread-001",
            input: [{ type: "text", text: "hello" }],
          });
        } catch (err: any) {
          gotBusy = true;
          expect(err.code).toBe(-32001);
        }
        expect(gotBusy).toBe(true);

        // The PARENT thread carries no turn and stays free for other work:
        // a claim lasts a turn, not a connection.
        const parentTurn = await client2.request("turn/start", {
          threadId: "thread-001",
          input: [{ type: "text", text: "parent is free" }],
        }) as { turn: { id: string } };
        expect(parentTurn.turn.id).toBe("turn-001");

        await client1.close();
        await client2.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a turn announced before its request failed keeps the thread until it ends", async () => {
      // turn/started is a notification and can land BEFORE the RPC settles,
      // so a failed streaming request can leave the server running a turn it
      // will never report. Its initiator has just been handed an error, so
      // nobody is listening — but it is still running, and still editing the
      // workspace. Releasing the thread would let a retry start a second turn
      // beside it.
      const sockPath = testSocketPath(tempDir);
      const mockDir = createMockCodex(tempDir, { startedThenError: true });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpointFor(sockPath), mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Turn 1: announced, then its request fails.
        let failed = false;
        try {
          await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "one" }] });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);

        // The abandoned turn is interrupted rather than left to run on.
        await waitFor(() => { try { return readFileSync(interruptLog, "utf-8").includes("\n"); } catch { return false; } }, 5000, 50); // a complete line, not merely the file
        const interrupts = readFileSync(interruptLog, "utf-8")
          .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        expect(interrupts.some((i) => i.turnId === "turn-001")).toBe(true);

        // And the thread stays reserved while it may still be running: a
        // retry must not start a second turn beside the first.
        const other = await TestClient.connectAndInit(sockPath);
        let refused = false;
        try {
          await other.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "two" }] });
        } catch (e) {
          refused = (e as Error).message.includes("already running");
        }
        expect(refused).toBe(true);

        // Turn 1's completion (mock replays it at +400ms) frees the thread —
        // the reservation is held until the turn really ends, not forever.
        let second: { turn: { id: string } } | null = null;
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && !second) {
          try {
            second = await other.request("turn/start", {
              threadId: "thread-001", input: [{ type: "text", text: "two" }],
            }) as { turn: { id: string } };
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        expect(second).not.toBeNull();
        expect(second!.turn.id).toBe("turn-002");

        await other.close();
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a stale interrupt is retargeted for the thread's owner", async () => {
      // A long turn rotates ids (context compaction starts a new one), so the
      // id the CLI recorded goes stale and turn/interrupt is rejected naming
      // the turn that is active now. Without the retarget the original turn
      // runs on with nobody listening — observed as a review outliving its
      // own CLI timeout by twenty minutes.
      const sockPath = testSocketPath(tempDir);
      const mockDir = createMockCodex(tempDir, { activeTurnId: "turn-rotated", sendTurnCompleted: false });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpointFor(sockPath), mockDir);
      await waitForSocket(sockPath);
      try {
        const client = await TestClient.connectAndInit(sockPath);
        await client.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "x" }] });

        // The owner interrupts with the id it recorded, which is now stale.
        await client.request("turn/interrupt", { threadId: "thread-001", turnId: "turn-001" });

        await waitFor(() => existsSync(interruptLog)
          && readFileSync(interruptLog, "utf-8").includes("turn-rotated"), 5000, 50);
        const ids = readFileSync(interruptLog, "utf-8").trim().split("\n")
          .filter(Boolean).map((l) => JSON.parse(l).turnId);
        // Tried the stale id, then the one the server named.
        expect(ids).toContain("turn-001");
        expect(ids).toContain("turn-rotated");
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a stale interrupt is NOT retargeted for a client that does not own the thread", async () => {
      // The rejection names whatever turn is active — which, once this
      // caller's own turn has ended and another invocation has claimed the
      // thread, is that invocation's turn. Retargeting there would cancel
      // work nobody asked to stop, so the original error is returned instead.
      const sockPath = testSocketPath(tempDir);
      const mockDir = createMockCodex(tempDir, { activeTurnId: "turn-rotated", sendTurnCompleted: false });
      const interruptLog = join(mockDir, "interrupts.log");

      const proc = spawnBroker(endpointFor(sockPath), mockDir);
      await waitForSocket(sockPath);
      try {
        const owner = await TestClient.connectAndInit(sockPath);
        await owner.request("turn/start", { threadId: "thread-001", input: [{ type: "text", text: "x" }] });

        // A DIFFERENT connection interrupts a thread it does not own.
        const stranger = await TestClient.connectAndInit(sockPath);
        let failed = false;
        try {
          await stranger.request("turn/interrupt", { threadId: "thread-001", turnId: "turn-001" });
        } catch (e) {
          failed = (e as Error).message.includes("expected active turn id");
        }
        expect(failed).toBe(true);

        // It reached the stale id only — the active turn was never touched.
        await waitFor(() => { try { return readFileSync(interruptLog, "utf-8").includes("\n"); } catch { return false; } }, 5000, 50); // a complete line, not merely the file
        const ids = readFileSync(interruptLog, "utf-8").trim().split("\n")
          .filter(Boolean).map((l) => JSON.parse(l).turnId);
        expect(ids).toContain("turn-001");
        expect(ids).not.toContain("turn-rotated");

        await stranger.close();
        await owner.close();
      } finally {
        proc.kill();
      }
    }, 15_000);

    test("a review's completion reaches the client even after an inner turn is announced", async () => {
      // Real Codex (0.147.0) runs a review as: review/start responds naming
      // turn A, an inner turn B announces itself, then turn A completes.
      // turn/started refreshes the thread's recorded turn id to B, so a
      // completion guard that compares the completion's id against it drops
      // turn A's completion — and the client, which waits on exactly that id,
      // never learns the review finished and burns its whole timeout.
      const sockPath = testSocketPath(tempDir);
      const mockDir = createMockCodex(tempDir, {
        reviewInnerTurn: true,
        sendTurnCompleted: true,
        turnCompletedDelay: 300,
      });

      const proc = spawnBroker(endpointFor(sockPath), mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);
        const notifications = collectNotifications(client);

        await client.request("review/start", {
          threadId: "thread-001",
          target: { type: "uncommittedChanges" },
        });

        const reviewCompleted = () => notifications.some((n) =>
          n.method === "turn/completed" &&
          ((n.params as { turn?: { id?: string } })?.turn?.id) === "review-turn-001"
        );
        // Wait for the event, not for a duration: on a loaded machine the
        // review simply takes longer, which must not read as a failure.
        await waitFor(reviewCompleted).catch(() => { /* assert below reports it */ });
        expect(reviewCompleted()).toBe(true);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Error forwarding ──────────────────────────────────────────────────────

  describe("error forwarding", () => {
    test("app-server error responses are forwarded to the client", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a method that the mock doesn't know — it returns Method not found
        try {
          await client.request("unknown/method");
          throw new Error("Expected error");
        } catch (err: any) {
          expect(err.message).toContain("Method not found: unknown/method");
          expect(err.code).toBe(-32601);
        }

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Forwarded response from wrong socket ──────────────────────────────────

  describe("forwarded response validation", () => {
    // NOTE: This test only verifies the broker doesn't crash when receiving a
    // response with an unknown id. It does not verify that the response is
    // actually dropped (vs. silently forwarded somewhere). The broker logs a
    // warning to stderr, but we don't capture subprocess stderr in assertions.
    test("response for unknown forwarded request is ignored", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        const client = await TestClient.connectAndInit(sockPath);

        // Send a response with an id that doesn't match any pending forwarded request
        client.send({ id: "nonexistent-req-id", result: { ok: true } });

        // Broker should just log a warning and continue functioning
        await new Promise((r) => setTimeout(r, 200));
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);

        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });

  // ── Stale socket cleanup ──────────────────────────────────────────────────

  describe("stale socket cleanup", () => {
    // Windows named pipes vanish with their owner; there is no stale file.
    test.skipIf(!IS_UNIX)("removes stale socket file before listening", async () => {

      const sockPath = testSocketPath(tempDir);
      const endpoint = endpointFor(sockPath);
      const mockDir = createMockCodex(tempDir);

      // Create a stale socket file
      writeFileSync(sockPath, "stale");

      const proc = spawnBroker(endpoint, mockDir);
      await waitForSocket(sockPath);

      try {
        // Should be able to connect despite the stale file
        const client = await TestClient.connectAndInit(sockPath);
        const result = await client.request("thread/list") as { data: unknown[] };
        expect(result.data).toBeArrayOfSize(0);
        await client.close();
      } finally {
        proc.kill();
      }
    }, 15_000);
  });
});
