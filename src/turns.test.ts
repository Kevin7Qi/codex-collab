import { describe, expect, test, beforeEach } from "bun:test";
import { runTurn, runReview } from "./turns";
import { EventDispatcher } from "./events";
import { autoApproveHandler } from "./approvals";
import type { ApprovalHandler } from "./approvals";
import type { AppServerClient } from "./protocol";
import type {
  TurnCompletedParams, TurnStartResponse,
  ReviewStartResponse,
} from "./types";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_LOG_DIR = join(tmpdir(), "codex-collab-test-turns");

beforeEach(() => {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
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

  function emit(method: string, params: unknown): void {
    const handlers = notificationHandlers.get(method);
    if (handlers) {
      for (const h of handlers) h(params);
    }
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
    onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
      requestHandlers.set(method, handler);
      return () => { requestHandlers.delete(method); };
    },
    respond() {},
    async close() {},
    userAgent: "mock/1.0",
  };

  return { client, emit, requestHandlers };
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
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Review: looks good");
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
      },
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("Full review text");
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
    });

    expect(approvalCalls).toContain("cmd:sudo rm -rf");
    expect(approvalCalls).toContain("file:/etc");
  });
});
