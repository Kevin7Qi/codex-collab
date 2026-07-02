import { describe, expect, test, beforeEach } from "bun:test";
import { runTurn, runReview, belongsToTurn } from "./turns";
import { EventDispatcher } from "./events";
import { autoApproveHandler } from "./approvals";
import type { ApprovalHandler } from "./approvals";
import type { AppServerClient } from "./client";
import type {
  TurnCompletedParams, TurnStartResponse,
  ReviewStartResponse,
} from "./types";
import { mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  updateThreadStatus,
  loadThreadMapping,
  saveThreadMapping,
} from "./threads";

const TEST_LOG_DIR = join(tmpdir(), "codex-collab-test-turns");
const TEST_KILL_DIR = join(tmpdir(), "codex-collab-test-kill-signals");

beforeEach(() => {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
  if (existsSync(TEST_KILL_DIR)) rmSync(TEST_KILL_DIR, { recursive: true });
  mkdirSync(TEST_KILL_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// Mock client builders
// ---------------------------------------------------------------------------

type NotificationMap = Map<string, Set<(params: unknown) => void>>;
type RequestHandlerMap = Map<string, (params: unknown) => unknown | Promise<unknown>>;

interface MockClientKit {
  client: AppServerClient;
  /** Fire a notification to all registered handlers for a method. */
  emit(method: string, params: unknown): void;
  /** Access registered server-request handlers (for approval wiring tests). */
  requestHandlers: RequestHandlerMap;
  /** Simulate an unexpected connection loss (fires onClose handlers). */
  triggerClose(): void;
}

/**
 * Build a mock AppServerClient with an exposed emit() for firing notifications
 * and a custom request handler. All boilerplate (on, onRequest, notify, respond,
 * close, userAgent) is provided.
 */
function buildMockClient(
  onRequest: (method: string, params?: unknown) => unknown,
): MockClientKit {
  const notificationHandlers: NotificationMap = new Map();
  const requestHandlers: RequestHandlerMap = new Map();
  const closeHandlers = new Set<() => void>();

  function emit(method: string, params: unknown): void {
    const handlers = notificationHandlers.get(method);
    if (handlers) {
      for (const h of handlers) h(params);
    }
  }

  function triggerClose(): void {
    for (const h of closeHandlers) h();
  }

  const client: AppServerClient = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      return onRequest(method, params) as T;
    },
    notify() {},
    on(method: string, handler: (params: unknown) => void): () => void {
      if (!notificationHandlers.has(method)) {
        notificationHandlers.set(method, new Set());
      }
      notificationHandlers.get(method)!.add(handler);
      return () => { notificationHandlers.get(method)?.delete(handler); };
    },
    onAny(_handler: (method: string, params: unknown) => void): () => void {
      // Mock client only fires `on(method)` handlers; tests don't exercise
      // the wildcard path.
      return () => {};
    },
    onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
      requestHandlers.set(method, handler);
      return () => { requestHandlers.delete(method); };
    },
    respond() {},
    onClose(handler: () => void) {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },
    async close() {},
    userAgent: "mock/1.0",
    brokerBusy: false,
  };

  return { client, emit, requestHandlers, triggerClose };
}

/** Standard turn/completed notification payload. */
function completedTurn(turnId: string, status = "completed", error: { message: string } | null = null): TurnCompletedParams {
  return {
    threadId: "thr-1",
    turn: { id: turnId, items: [], status: status as "completed", error },
  };
}

/** Standard in-progress turn response. */
function inProgressTurn(turnId: string): TurnStartResponse {
  return { turn: { id: turnId, items: [], status: "inProgress", error: null } };
}

/**
 * Build a simple mock that auto-fires turn/completed after the start method.
 * Used for tests that only care about the completion result, not the event stream.
 */
function createMockClient(opts: {
  startMethod: string;
  startResponse: TurnStartResponse | ReviewStartResponse;
  completionParams: TurnCompletedParams;
  completionDelayMs?: number;
}): AppServerClient {
  const { client, emit } = buildMockClient((method) => {
    if (method === opts.startMethod) {
      setTimeout(() => emit("turn/completed", opts.completionParams), opts.completionDelayMs ?? 50);
      return opts.startResponse;
    }
    throw new Error(`Unexpected request method: ${method}`);
  });
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runTurn", () => {
  test("returns completed TurnResult with delta-streamed output", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/agentMessage/delta", { threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "Hello from Codex" });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-turn", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Hello from Codex");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("returns accumulated output from deltas when available", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/agentMessage/delta", { threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "Streamed " });
          emit("item/agentMessage/delta", { threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "output" });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-turn-delta", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Streamed output");
  });

  test("returns failed TurnResult with error message", async () => {
    const client = createMockClient({
      startMethod: "turn/start",
      startResponse: inProgressTurn("turn-1"),
      completionParams: completedTurn("turn-1", "failed", { message: "Context window exceeded" }),
    });

    const dispatcher = new EventDispatcher("test-turn-err", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Context window exceeded");
    expect(result.output).toBe("");
  });

  test("handles instant turn/completed (race condition prevention)", async () => {
    // Simulates the race: turn/completed fires synchronously during request(),
    // before waitFor() is called. The buffered awaiter catches it.
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        // Fire turn/completed synchronously — before the response promise resolves
        emit("turn/completed", completedTurn("turn-1"));
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-instant", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
  });

  test("times out when turn/completed never fires", async () => {
    const { client } = buildMockClient(() => inProgressTurn("turn-1"));

    const dispatcher = new EventDispatcher("test-turn-timeout", TEST_LOG_DIR, () => {});

    const start = Date.now();
    try {
      await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 200,
        killSignalsDir: TEST_KILL_DIR,
      });
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect((e as Error).message).toContain("timed out");
      expect(Date.now() - start).toBeGreaterThanOrEqual(180);
    }
  });

  test("collects files changed and commands run from dispatcher", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/completed", {
            item: {
              type: "commandExecution", id: "cmd-1",
              command: "npm test", cwd: "/proj",
              status: "completed", exitCode: 0, durationMs: 1200,
              processId: null, commandActions: [],
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
          emit("item/completed", {
            item: {
              type: "fileChange", id: "fc-1",
              changes: [{ path: "src/foo.ts", kind: { type: "update", move_path: null }, diff: "+1,-1" }],
              status: "completed",
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-turn-collect", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "run tests" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.commandsRun).toHaveLength(1);
    expect(result.commandsRun[0].command).toBe("npm test");
    expect(result.commandsRun[0].exitCode).toBe(0);
    expect(result.filesChanged).toHaveLength(1);
    expect(result.filesChanged[0].path).toBe("src/foo.ts");
    expect(result.filesChanged[0].kind).toBe("update");
  });

  test("passes optional params (cwd, model, effort, approvalPolicy)", async () => {
    let capturedParams: unknown;

    const { client, emit } = buildMockClient((method, params) => {
      if (method === "turn/start") {
        capturedParams = params;
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 20);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-turn-params", TEST_LOG_DIR, () => {});

    await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
      cwd: "/my/project",
      model: "gpt-5.3-codex",
      effort: "high",
      approvalPolicy: "on-request",
    });

    const p = capturedParams as Record<string, unknown>;
    expect(p.threadId).toBe("thr-1");
    expect(p.cwd).toBe("/my/project");
    expect(p.model).toBe("gpt-5.3-codex");
    expect(p.effort).toBe("high");
    expect(p.approvalPolicy).toBe("on-request");
  });

  test("ignores turn/completed for different turnId", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/agentMessage/delta", { threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "correct" });
        }, 10);
        // Fire turn/completed for wrong turn first, then correct turn
        setTimeout(() => {
          emit("turn/completed", completedTurn("wrong-turn"));
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-turnid-filter", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("correct");
  });
});

describe("runReview", () => {
  test("captures review output from exitedReviewMode item/completed", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "review/start") {
        setTimeout(() => {
          emit("item/completed", {
            item: { type: "exitedReviewMode", id: "review-turn-1", review: "Review: looks good" },
            threadId: "thr-1",
            turnId: "review-turn-1",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("review-turn-1")), 50);
        return {
          turn: { id: "review-turn-1", items: [], status: "inProgress", error: null },
          reviewThreadId: "review-thr-1",
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-review", TEST_LOG_DIR, () => {});

    const result = await runReview(
      client,
      "thr-1",
      { type: "uncommittedChanges" },
      {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 5000,
        killSignalsDir: TEST_KILL_DIR,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Review: looks good");
  });

  test("on local kill signal during a review, turn/interrupt is sent to the review subthread", async () => {
    // Without the interrupt in the KillSignalError branch, broker-backed
    // reviews would close their socket on kill but keep running on the
    // shared app-server until the orphan watchdog fires. The interrupt
    // must also use the review subthread (not the caller's parent) for
    // the same reason as the timeout path.
    const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
    const { client, emit } = buildMockClient((method, params) => {
      if (method === "review/start") {
        // Don't emit turn/completed — wait for the kill signal to fire.
        return {
          turn: { id: "review-turn-kill", items: [], status: "inProgress", error: null },
          reviewThreadId: "review-thr-kill",
        };
      }
      if (method === "turn/interrupt") {
        interruptCalls.push(params as { threadId: string; turnId: string });
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    void emit;

    const dispatcher = new EventDispatcher("test-review-kill", TEST_LOG_DIR, () => {});

    // Drop a kill signal file after a brief delay so the awaiter picks it up.
    setTimeout(() => {
      writeFileSync(join(TEST_KILL_DIR, "thr-parent"), "*");
    }, 50);

    const result = await runReview(
      client,
      "thr-parent",
      { type: "uncommittedChanges" },
      {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 5000, // not the timeout path — kill signal fires first
        killSignalsDir: TEST_KILL_DIR,
      },
    );

    expect(result.status).toBe("interrupted");
    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0].threadId).toBe("review-thr-kill");
    expect(interruptCalls[0].turnId).toBe("review-turn-kill");
  });

  test("on timeout, turn/interrupt targets the review subthread, not the parent", async () => {
    // Reviews run on a subthread distinct from the caller's threadId.
    // Earlier code only retained params.threadId for the cleanup interrupt,
    // so on broker-timeout the orphaned review would keep running on the
    // *review* subthread, holding the broker busy until the watchdog fires.
    const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
    const { client, emit } = buildMockClient((method, params) => {
      if (method === "review/start") {
        // Don't emit turn/completed — let the client-side timeout fire.
        return {
          turn: { id: "review-turn-1", items: [], status: "inProgress", error: null },
          reviewThreadId: "review-thr-1",
        };
      }
      if (method === "turn/interrupt") {
        interruptCalls.push(params as { threadId: string; turnId: string });
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    void emit; // keep mock alive

    const dispatcher = new EventDispatcher("test-review-interrupt", TEST_LOG_DIR, () => {});

    await expect(
      runReview(
        client,
        "thr-parent",
        { type: "uncommittedChanges" },
        {
          dispatcher,
          approvalHandler: autoApproveHandler,
          timeoutMs: 50,
          killSignalsDir: TEST_KILL_DIR,
        },
      ),
    ).rejects.toThrow();

    expect(interruptCalls).toHaveLength(1);
    expect(interruptCalls[0].threadId).toBe("review-thr-1");
    expect(interruptCalls[0].turnId).toBe("review-turn-1");
  });

  test("completion inference fires on a review whose item events are scoped to the review subthread", async () => {
    // Realistic: item/completed for review-turn items arrives with
    // threadId=reviewThreadId, not the caller's parent. The inner handler
    // in executeTurn must still match these — pre-fix it filtered on the
    // parent threadId only, so processItemCompleted never ran, the
    // inference timer never armed, and a lost turn/completed would let
    // the CLI hang until timeoutMs.
    const { client, emit } = buildMockClient((method) => {
      if (method === "review/start") {
        // Emit the review's exitedReviewMode on the REVIEW subthread, then
        // never send turn/completed. Pre-fix, this leaves the turn hanging
        // until the timeout. Post-fix, the inference debounce kicks in.
        setTimeout(() => {
          emit("item/completed", {
            item: { type: "exitedReviewMode", id: "review-turn-3", review: "All clear" },
            threadId: "review-thr-3", // subthread, NOT the parent
            turnId: "review-turn-3",
          });
        }, 20);
        return {
          turn: { id: "review-turn-3", items: [], status: "inProgress", error: null },
          reviewThreadId: "review-thr-3",
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    void emit;

    const dispatcher = new EventDispatcher("test-review-subthread-inference", TEST_LOG_DIR, () => {});

    const t0 = Date.now();
    const result = await runReview(
      client,
      "thr-parent",
      { type: "uncommittedChanges" },
      {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 30_000, // generous: success means inference fires, not timeout
        killSignalsDir: TEST_KILL_DIR,
      },
    );
    const elapsed = Date.now() - t0;

    // Inference completion should fire ~250ms after the exitedReviewMode item
    // (the inference debounce delay). Definitely well under the 30s timeout.
    expect(result.status).toBe("completed");
    expect(elapsed).toBeLessThan(2000);
  });

  test("returns failed result when review fails", async () => {
    const client = createMockClient({
      startMethod: "review/start",
      startResponse: {
        turn: { id: "review-turn-2", items: [], status: "inProgress", error: null },
        reviewThreadId: "review-thr-2",
      } as ReviewStartResponse,
      completionParams: completedTurn("review-turn-2", "failed", { message: "No changes to review" }),
    });

    const dispatcher = new EventDispatcher("test-review-err", TEST_LOG_DIR, () => {});

    const result = await runReview(
      client,
      "thr-1",
      { type: "baseBranch", branch: "main" },
      {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 5000,
        killSignalsDir: TEST_KILL_DIR,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("No changes to review");
  });
});

describe("review output via exitedReviewMode", () => {
  test("exitedReviewMode overrides any earlier accumulated output", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "review/start") {
        // Some delta arrives first (shouldn't happen for reviews, but test the override)
        setTimeout(() => {
          emit("item/agentMessage/delta", { threadId: "thr-1", turnId: "review-turn-1", itemId: "msg-1", delta: "partial" });
        }, 10);
        // Then exitedReviewMode arrives with the full review
        setTimeout(() => {
          emit("item/completed", {
            item: { type: "exitedReviewMode", id: "review-turn-1", review: "Full review text" },
            threadId: "thr-1",
            turnId: "review-turn-1",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("review-turn-1")), 50);
        return {
          turn: { id: "review-turn-1", items: [], status: "inProgress", error: null },
          reviewThreadId: "review-thr-1",
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-review-override", TEST_LOG_DIR, () => {});

    const result = await runReview(
      client,
      "thr-1",
      { type: "uncommittedChanges" },
      {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 5000,
        killSignalsDir: TEST_KILL_DIR,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Full review text");
  });
});

// ---------------------------------------------------------------------------
// Kill signal tests
// ---------------------------------------------------------------------------

describe("kill signal", () => {

  test("kill signal during slow turn/start returns interrupted result", async () => {
    const { client } = buildMockClient((method) => {
      if (method === "turn/start") {
        // Simulate a slow/stuck turn/start — resolves after 2s
        return new Promise((resolve) =>
          setTimeout(() => resolve(inProgressTurn("turn-1")), 2000),
        );
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    // Kill signal arrives after 100ms — should win race 1 against the 2s request
    setTimeout(() => {
      writeFileSync(join(TEST_KILL_DIR, "thr-1"), "", { mode: 0o600 });
    }, 100);

    const dispatcher = new EventDispatcher("test-kill-request", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 10_000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("interrupted");
    expect(result.error).toBe("Thread killed by user");
    expect(existsSync(join(TEST_KILL_DIR, "thr-1"))).toBe(false);
  });

  test("kill signal during turn returns interrupted result", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        // Write the kill signal file after a short delay (simulates `codex-collab kill`)
        setTimeout(() => {
          writeFileSync(join(TEST_KILL_DIR, "thr-1"), "", { mode: 0o600 });
        }, 100);
        // Never fire turn/completed — the kill signal should end the turn
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-kill", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 10_000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("interrupted");
    expect(result.error).toBe("Thread killed by user");
    // Signal file should be cleaned up in finally block
    expect(existsSync(join(TEST_KILL_DIR, "thr-1"))).toBe(false);
  });

  test("stale signal cleared at turn start — turn completes normally", async () => {
    // Pre-write a stale signal file (simulates leftover from a previous kill).
    // Backdate its mtime to before process start so it's treated as stale.
    const stalePath = join(TEST_KILL_DIR, "thr-1");
    writeFileSync(stalePath, "", { mode: 0o600 });
    const beforeProcessStart = new Date(Date.now() - process.uptime() * 1000 - 10_000);
    utimesSync(stalePath, beforeProcessStart, beforeProcessStart);

    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-stale-kill", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
  });

  test("fresh signal NOT cleared at turn start — turn is interrupted", async () => {
    // Write a signal file with current mtime (simulates a concurrent kill).
    // No backdating — mtime is after process start, so it should be preserved.
    writeFileSync(join(TEST_KILL_DIR, "thr-1"), "", { mode: 0o600 });

    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-fresh-kill", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("interrupted");
    expect(result.error).toBe("Thread killed by user");
  });

  test("PID-tagged signal targeting a different PID is treated as stale at startup", async () => {
    // Pretend a previous run wrote a signal targeting some other PID. Both
    // the startup check and the polling loop must reject it.
    writeFileSync(join(TEST_KILL_DIR, "thr-1"), "99999999", { mode: 0o600 });

    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-pid-mismatch", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    // Startup check unlinks the wrong-PID signal; turn proceeds normally.
    expect(result.status).toBe("completed");
  });

  test("PID-tagged signal targeting our PID is honored", async () => {
    // A signal explicitly addressed to this run's PID must trigger the kill.
    writeFileSync(join(TEST_KILL_DIR, "thr-1"), String(process.pid), { mode: 0o600 });

    const { client } = buildMockClient((method) => {
      if (method === "turn/start") return inProgressTurn("turn-1");
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-pid-match", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("interrupted");
  });

  test("PID-tagged wildcard signal is honored", async () => {
    // The "*" wildcard means "any active run on this thread" — used when the
    // killer can't read a PID file.
    writeFileSync(join(TEST_KILL_DIR, "thr-1"), "*", { mode: 0o600 });

    const { client } = buildMockClient((method) => {
      if (method === "turn/start") return inProgressTurn("turn-1");
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-wildcard", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("interrupted");
  });

  test("stale wildcard signal is cleared at turn start", async () => {
    const stalePath = join(TEST_KILL_DIR, "thr-1");
    writeFileSync(stalePath, "*", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(stalePath, staleTime, staleTime);

    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-stale-wildcard", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
  });

  test("normal completion wins race — no kill signal", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-no-kill", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
  });

  test("signal file cleaned up on normal completion", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-cleanup", TEST_LOG_DIR, () => {});

    await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    // unlinkSync in finally should not error when no signal exists
    expect(existsSync(join(TEST_KILL_DIR, "thr-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-kill error propagation
// ---------------------------------------------------------------------------

describe("error propagation", () => {
  test("non-kill errors propagate through the catch block", async () => {
    const { client } = buildMockClient((method) => {
      if (method === "turn/start") {
        throw new Error("Server exploded");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-propagate", TEST_LOG_DIR, () => {});

    await expect(
      runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 5000,
        killSignalsDir: TEST_KILL_DIR,
      }),
    ).rejects.toThrow("Server exploded");
  });
});

// ---------------------------------------------------------------------------
// updateThreadStatus
// ---------------------------------------------------------------------------

const TEST_THREADS_FILE = join(tmpdir(), "codex-collab-test-threads", "threads.json");

describe("updateThreadStatus", () => {
  beforeEach(() => {
    const dir = join(tmpdir(), "codex-collab-test-threads");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
  });

  test("updates status and timestamp", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: {
        threadId: "thr-1",
        createdAt: "2026-01-01T00:00:00Z",
        lastStatus: "running",
      },
    });

    updateThreadStatus(TEST_THREADS_FILE, "thr-1", "completed");
    const loaded = loadThreadMapping(TEST_THREADS_FILE);
    expect(loaded.abc12345.lastStatus).toBe("completed");
    expect(loaded.abc12345.updatedAt).toBeDefined();
  });

  test("warns on unknown thread", () => {
    saveThreadMapping(TEST_THREADS_FILE, {});
    const warnings: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => warnings.push(msg);
    updateThreadStatus(TEST_THREADS_FILE, "thr-unknown", "running");
    console.error = origError;
    expect(warnings.some((w) => w.includes("unknown thread"))).toBe(true);
  });
});

describe("approval wiring", () => {
  test("approval requests are routed through the handler", async () => {
    const approvalCalls: string[] = [];
    const mockApprovalHandler: ApprovalHandler = {
      async handleCommandApproval(req) {
        approvalCalls.push(`cmd:${req.command}`);
        return "accept";
      },
      async handleFileChangeApproval(req) {
        approvalCalls.push(`file:${req.grantRoot}`);
        return "decline";
      },
    };

    const { client, emit, requestHandlers } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(async () => {
          const cmdHandler = requestHandlers.get("item/commandExecution/requestApproval");
          if (cmdHandler) {
            await cmdHandler({
              threadId: "thr-1", turnId: "turn-1", itemId: "item-1",
              approvalId: "appr-1", reason: "needs sudo", command: "sudo rm -rf", cwd: "/",
            });
          }

          const fileHandler = requestHandlers.get("item/fileChange/requestApproval");
          if (fileHandler) {
            await fileHandler({
              threadId: "thr-1", turnId: "turn-1", itemId: "item-2",
              reason: "write outside cwd", grantRoot: "/etc",
            });
          }

          emit("turn/completed", completedTurn("turn-1"));
        }, 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-approval-wiring", TEST_LOG_DIR, () => {});

    await runTurn(client, "thr-1", [{ type: "text", text: "do stuff" }], {
      dispatcher,
      approvalHandler: mockApprovalHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(approvalCalls).toContain("cmd:sudo rm -rf");
    expect(approvalCalls).toContain("file:/etc");
  });
});

// ---------------------------------------------------------------------------
// belongsToTurn
// ---------------------------------------------------------------------------

describe("belongsToTurn", () => {
  test("matches when threadId and turnId match", () => {
    expect(belongsToTurn(
      { threadId: "thr-1", turnId: "turn-1" },
      "thr-1",
      "turn-1",
    )).toBe(true);
  });

  test("rejects when threadId differs", () => {
    expect(belongsToTurn(
      { threadId: "thr-2", turnId: "turn-1" },
      "thr-1",
      "turn-1",
    )).toBe(false);
  });

  test("rejects when turnId differs", () => {
    expect(belongsToTurn(
      { threadId: "thr-1", turnId: "turn-2" },
      "thr-1",
      "turn-1",
    )).toBe(false);
  });

  test("rejects when both differ", () => {
    expect(belongsToTurn(
      { threadId: "thr-2", turnId: "turn-2" },
      "thr-1",
      "turn-1",
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reasoning extraction
// ---------------------------------------------------------------------------

describe("notification buffering and turn filtering", () => {
  test("replays buffered item/completed after turnId is known", async () => {
    // Simulate: item/completed arrives BEFORE the turn/start response resolves.
    // The mock fires item/completed synchronously during the request handler,
    // which means it arrives before the turn/start response promise resolves.
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        // Fire item/completed synchronously before returning the response
        emit("item/completed", {
          item: {
            type: "agentMessage", id: "msg-early",
            text: "Buffered final answer", phase: "final_answer",
          },
          threadId: "thr-1",
          turnId: "turn-1",
        });
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-buffer-replay", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Buffered final answer");
  });

  test("buffered notifications for a different thread are ignored", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        // Fire item/completed for a different thread
        emit("item/completed", {
          item: {
            type: "agentMessage", id: "msg-other",
            text: "Foreign output", phase: "final_answer",
          },
          threadId: "thr-OTHER",
          turnId: "turn-1",
        });
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-buffer-other-thread", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.output).toBe("");
  });

  test("live events from a foreign turn do not contaminate output or captures", async () => {
    // Regression: on a shared (broker) app-server, an orphaned turn from a
    // previous client can still emit items mid-run. Those must not land in
    // this run's output, filesChanged, or commandsRun.
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          // Our turn's final answer
          emit("item/completed", {
            item: { type: "agentMessage", id: "m-ours", text: "Ours", phase: "final_answer" },
            threadId: "thr-1", turnId: "turn-1",
          });
          // Foreign turn's events arriving interleaved (turnId differs)
          emit("item/completed", {
            item: { type: "agentMessage", id: "m-foreign", text: "Foreign", phase: "final_answer" },
            threadId: "thr-1", turnId: "turn-FOREIGN",
          });
          emit("item/completed", {
            item: {
              type: "fileChange", id: "fc-foreign",
              changes: [{ path: "evil.ts", kind: { type: "add", move_path: null }, diff: "+1" }],
              status: "completed",
            },
            threadId: "thr-OTHER", turnId: "turn-FOREIGN",
          });
          emit("item/agentMessage/delta", {
            threadId: "thr-OTHER", turnId: "turn-FOREIGN", itemId: "m-foreign", delta: "sneaky",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 80);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-foreign-filter", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.output).toBe("Ours");
    expect(result.filesChanged).toHaveLength(0);
  });
});

describe("connection loss", () => {
  test("rejects promptly when the connection dies mid-turn", async () => {
    // Regression: without the onClose race, a dead app-server/broker left the
    // CLI waiting for the full turn timeout before a misleading
    // "Turn timed out" error.
    const { client, triggerClose } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => triggerClose(), 30);
        return inProgressTurn("turn-1");
      }
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-conn-loss", TEST_LOG_DIR, () => {});

    const started = Date.now();
    await expect(
      runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
        dispatcher,
        approvalHandler: autoApproveHandler,
        timeoutMs: 60_000,
        killSignalsDir: TEST_KILL_DIR,
      }),
    ).rejects.toThrow("Connection to Codex lost");
    // Must fail fast, not wait out the 60s turn timeout
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("completion inference", () => {
  test("infers completion when turn/completed is lost after agentMessage completes", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/agentMessage/delta", {
            threadId: "thr-1", turnId: "turn-1", itemId: "msg-1",
            delta: "Inferred output",
          });
          // Fire agentMessage item/completed with final_answer phase — triggers inference timer
          emit("item/completed", {
            item: { type: "agentMessage", id: "msg-1", text: "Inferred output", phase: "final_answer" },
            threadId: "thr-1",
            turnId: "turn-1",
          });
          // Never fire turn/completed — inference should kick in after 250ms
        }, 20);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-infer-completion", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Inferred output");
  });

  test("normal turn/completed cancels inference timer", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/agentMessage/delta", {
            threadId: "thr-1", turnId: "turn-1", itemId: "msg-1",
            delta: "Normal output",
          });
          emit("item/completed", {
            item: { type: "agentMessage", id: "msg-1", text: "Normal output" },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 20);
        // turn/completed arrives well within the 250ms inference window
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-normal-beats-inference", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Normal output");
  });

  test("new item activity resets inference timer", async () => {
    // agentMessage completes, then a command starts and completes.
    // The inference timer should be reset by the command activity.
    const startMs = Date.now();
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/completed", {
            item: { type: "agentMessage", id: "msg-1", text: "early" },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 20);
        // Command completes 200ms later (resets the 250ms timer)
        setTimeout(() => {
          emit("item/completed", {
            item: {
              type: "commandExecution", id: "cmd-1",
              command: "echo hi", cwd: "/", status: "completed",
              exitCode: 0, durationMs: 50, processId: null, commandActions: [],
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
          // Now fire agentMessage with final_answer to trigger inference
          emit("item/completed", {
            item: { type: "agentMessage", id: "msg-2", text: "final", phase: "final_answer" },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 200);
        // No turn/completed — inference should resolve ~450ms from start
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-inference-reset", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    // Should have taken at least ~400ms (200ms delay + 250ms inference timer)
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
    // Command should be captured
    expect(result.commandsRun.length).toBeGreaterThanOrEqual(1);
    expect(result.commandsRun[0].command).toBe("echo hi");
  });
});

// ---------------------------------------------------------------------------
// Structured file/command capture (supplementary)
// ---------------------------------------------------------------------------

describe("structured capture from item/completed", () => {
  test("captures files and commands from item/completed notifications", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/completed", {
            item: {
              type: "commandExecution", id: "cmd-1",
              command: "bun test", cwd: "/proj",
              status: "completed", exitCode: 0, durationMs: 500,
              processId: null, commandActions: [],
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
          emit("item/completed", {
            item: {
              type: "fileChange", id: "fc-1",
              changes: [{ path: "src/main.ts", kind: { type: "add", move_path: null }, diff: "+10" }],
              status: "completed",
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 80);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-structured-capture", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "build" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.commandsRun).toHaveLength(1);
    expect(result.commandsRun[0].command).toBe("bun test");
    expect(result.commandsRun[0].exitCode).toBe(0);
    expect(result.filesChanged).toHaveLength(1);
    expect(result.filesChanged[0].path).toBe("src/main.ts");
    expect(result.filesChanged[0].kind).toBe("add");
  });

  test("deduplicates between dispatcher and turn-level capture", async () => {
    // Both dispatcher and turn-level capture will see the same item/completed,
    // so result should have exactly 1 command and 1 file (not 2).
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/completed", {
            item: {
              type: "commandExecution", id: "cmd-1",
              command: "npm test", cwd: "/proj",
              status: "completed", exitCode: 0, durationMs: 1200,
              processId: null, commandActions: [],
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
          emit("item/completed", {
            item: {
              type: "fileChange", id: "fc-1",
              changes: [{ path: "src/foo.ts", kind: { type: "update", move_path: null }, diff: "+1,-1" }],
              status: "completed",
            },
            threadId: "thr-1",
            turnId: "turn-1",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 80);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("test-dedup-capture", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "run tests" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    // Should be exactly 1 of each, not duplicated
    expect(result.commandsRun).toHaveLength(1);
    expect(result.filesChanged).toHaveLength(1);
  });
});

describe("Guardian event routing", () => {
  test("autoApprovalReview notifications reach the dispatcher; foreign-turn ones are filtered", async () => {
    const { client, emit } = buildMockClient((method) => {
      if (method === "turn/start") {
        setTimeout(() => {
          emit("item/autoApprovalReview/started", {
            threadId: "thr-1", turnId: "turn-1", itemId: "i1", command: "touch guard.txt",
          });
          emit("item/autoApprovalReview/completed", {
            threadId: "thr-1", turnId: "turn-1", itemId: "i1", decision: "approved", command: "touch guard.txt",
          });
          // Orphaned turn on the shared app-server — must not surface here
          emit("item/autoApprovalReview/completed", {
            threadId: "thr-other", turnId: "turn-other", itemId: "i9", decision: "rejected", command: "rm -rf /",
          });
        }, 20);
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 50);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian-routing", TEST_LOG_DIR, (line) => lines.push(line));

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
    });

    expect(result.status).toBe("completed");
    expect(lines.some(l => l.includes("Guardian reviewing") && l.includes("touch guard.txt"))).toBe(true);
    expect(lines.some(l => l.includes("Guardian approved"))).toBe(true);
    expect(lines.some(l => l.includes("rm -rf /"))).toBe(false);
  });
});

describe("per-turn approvalsReviewer forwarding", () => {
  test("runTurn forwards approvalsReviewer into turn/start params", async () => {
    let captured: Record<string, unknown> | undefined;
    const { client, emit } = buildMockClient((method, params) => {
      if (method === "turn/start") {
        captured = params as Record<string, unknown>;
        setTimeout(() => emit("turn/completed", completedTurn("turn-1")), 20);
        return inProgressTurn("turn-1");
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const dispatcher = new EventDispatcher("reviewer-fwd", TEST_LOG_DIR, () => {});
    await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
      killSignalsDir: TEST_KILL_DIR,
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });

    // Guardian routing must reach the wire: on a thread already loaded in the
    // long-lived broker app-server, the per-turn param is the reliable path
    // (thread/resume-level settings can be ignored, like sandbox).
    expect(captured?.approvalsReviewer).toBe("auto_review");
    expect(captured?.approvalPolicy).toBe("on-request");
  });
});
