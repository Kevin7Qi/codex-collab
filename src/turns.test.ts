import { describe, expect, test, beforeEach } from "bun:test";
import { runTurn, runReview } from "./turns";
import { EventDispatcher } from "./events";
import { autoApproveHandler } from "./approvals";
import type { ApprovalHandler } from "./approvals";
import type { AppServerClient } from "./protocol";
import type {
  TurnResult, TurnCompletedParams, TurnStartResponse,
  ReviewStartResponse, RequestId,
} from "./types";
import { mkdirSync, rmSync, existsSync } from "fs";

const TEST_LOG_DIR = `${process.env.TMPDIR || "/tmp/claude-1000"}/codex-collab-test-turns`;

beforeEach(() => {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

/**
 * Build a mock AppServerClient that:
 * - Returns a TurnStartResponse (or ReviewStartResponse) for the start method
 * - Fires turn/completed notification after a short delay
 * - Supports on()/onRequest() with proper unsubscribe
 */
function createMockClient(opts: {
  startMethod: string;
  startResponse: TurnStartResponse | ReviewStartResponse;
  completionParams: TurnCompletedParams;
  completionDelayMs?: number;
}): AppServerClient {
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();

  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === opts.startMethod) {
        // Simulate: after responding, fire turn/completed notification
        setTimeout(() => {
          const handlers = notificationHandlers.get("turn/completed");
          if (handlers) {
            for (const h of handlers) h(opts.completionParams);
          }
        }, opts.completionDelayMs ?? 50);
        return opts.startResponse as T;
      }
      throw new Error(`Unexpected request method: ${method}`);
    },

    notify() {},

    on(method: string, handler: (params: unknown) => void): () => void {
      if (!notificationHandlers.has(method)) {
        notificationHandlers.set(method, new Set());
      }
      notificationHandlers.get(method)!.add(handler);
      return () => {
        notificationHandlers.get(method)?.delete(handler);
      };
    },

    onRequest(method: string, handler: (params: unknown) => unknown | Promise<unknown>): () => void {
      requestHandlers.set(method, handler);
      return () => {
        requestHandlers.delete(method);
      };
    },

    respond() {},

    async close() {},

    userAgent: "mock/1.0",
  };
}

describe("runTurn", () => {
  test("returns completed TurnResult", async () => {
    const client = createMockClient({
      startMethod: "turn/start",
      startResponse: {
        turn: { id: "turn-1", items: [], status: "inProgress" },
      },
      completionParams: {
        threadId: "thr-1",
        turn: {
          id: "turn-1",
          items: [{ type: "agentMessage", id: "msg-1", text: "Hello from Codex" }],
          status: "completed",
        },
      },
    });

    const dispatcher = new EventDispatcher("test-turn", TEST_LOG_DIR, () => {});

    const result = await runTurn(client, "thr-1", [{ type: "text", text: "hello" }], {
      dispatcher,
      approvalHandler: autoApproveHandler,
      timeoutMs: 5000,
    });

    expect(result.status).toBe("completed");
    // Output comes from turn.items agentMessage fallback since no deltas streamed
    expect(result.output).toBe("Hello from Codex");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("returns accumulated output from deltas when available", async () => {
    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

    const client: AppServerClient = {
      async request<T>(method: string): Promise<T> {
        if (method === "turn/start") {
          // Fire agent message deltas, then turn/completed
          setTimeout(() => {
            const deltaHandlers = notificationHandlers.get("item/agentMessage/delta");
            if (deltaHandlers) {
              for (const h of deltaHandlers) {
                h({ threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "Streamed " });
              }
              for (const h of deltaHandlers) {
                h({ threadId: "thr-1", turnId: "turn-1", itemId: "msg-1", delta: "output" });
              }
            }
          }, 20);

          setTimeout(() => {
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({
                  threadId: "thr-1",
                  turn: {
                    id: "turn-1",
                    items: [{ type: "agentMessage", id: "msg-1", text: "Streamed output" }],
                    status: "completed",
                  },
                });
              }
            }
          }, 50);

          return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      notify() {},
      on(method: string, handler: (params: unknown) => void): () => void {
        if (!notificationHandlers.has(method)) {
          notificationHandlers.set(method, new Set());
        }
        notificationHandlers.get(method)!.add(handler);
        return () => { notificationHandlers.get(method)?.delete(handler); };
      },
      onRequest(): () => void { return () => {}; },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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
      startResponse: {
        turn: { id: "turn-1", items: [], status: "inProgress" },
      },
      completionParams: {
        threadId: "thr-1",
        turn: {
          id: "turn-1",
          items: [],
          status: "failed",
          error: { message: "Context window exceeded", codexErrorInfo: "ContextWindowExceeded" },
        },
      },
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

  test("times out when turn/completed never fires", async () => {
    // Client that never fires turn/completed
    const client: AppServerClient = {
      async request<T>(): Promise<T> {
        return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
      },
      notify() {},
      on(): () => void { return () => {}; },
      onRequest(): () => void { return () => {}; },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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
    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

    const client: AppServerClient = {
      async request<T>(method: string): Promise<T> {
        if (method === "turn/start") {
          // Fire item/completed for a command and file change, then turn/completed
          setTimeout(() => {
            const completedHandlers = notificationHandlers.get("item/completed");
            if (completedHandlers) {
              for (const h of completedHandlers) {
                h({
                  item: {
                    type: "commandExecution", id: "cmd-1",
                    command: "npm test", cwd: "/proj",
                    status: "completed", exitCode: 0, durationMs: 1200,
                  },
                  threadId: "thr-1",
                  turnId: "turn-1",
                });
              }
              for (const h of completedHandlers) {
                h({
                  item: {
                    type: "fileChange", id: "fc-1",
                    changes: [{ path: "src/foo.ts", kind: { type: "update", move_path: null }, diff: "+1,-1" }],
                    status: "completed",
                  },
                  threadId: "thr-1",
                  turnId: "turn-1",
                });
              }
            }
          }, 20);

          setTimeout(() => {
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({
                  threadId: "thr-1",
                  turn: { id: "turn-1", items: [], status: "completed" },
                });
              }
            }
          }, 50);

          return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      notify() {},
      on(method: string, handler: (params: unknown) => void): () => void {
        if (!notificationHandlers.has(method)) {
          notificationHandlers.set(method, new Set());
        }
        notificationHandlers.get(method)!.add(handler);
        return () => { notificationHandlers.get(method)?.delete(handler); };
      },
      onRequest(): () => void { return () => {}; },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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

    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

    const client: AppServerClient = {
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === "turn/start") {
          capturedParams = params;
          setTimeout(() => {
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({
                  threadId: "thr-1",
                  turn: { id: "turn-1", items: [], status: "completed" },
                });
              }
            }
          }, 20);
          return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      notify() {},
      on(method: string, handler: (params: unknown) => void): () => void {
        if (!notificationHandlers.has(method)) {
          notificationHandlers.set(method, new Set());
        }
        notificationHandlers.get(method)!.add(handler);
        return () => { notificationHandlers.get(method)?.delete(handler); };
      },
      onRequest(): () => void { return () => {}; },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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
    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

    const client: AppServerClient = {
      async request<T>(method: string): Promise<T> {
        if (method === "turn/start") {
          // Fire turn/completed for wrong turn first, then correct turn
          setTimeout(() => {
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({ threadId: "thr-1", turn: { id: "wrong-turn", items: [], status: "completed" } });
              }
            }
          }, 20);

          setTimeout(() => {
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({
                  threadId: "thr-1",
                  turn: {
                    id: "turn-1",
                    items: [{ type: "agentMessage", id: "m1", text: "correct" }],
                    status: "completed",
                  },
                });
              }
            }
          }, 50);

          return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      notify() {},
      on(method: string, handler: (params: unknown) => void): () => void {
        if (!notificationHandlers.has(method)) notificationHandlers.set(method, new Set());
        notificationHandlers.get(method)!.add(handler);
        return () => { notificationHandlers.get(method)?.delete(handler); };
      },
      onRequest(): () => void { return () => {}; },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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
  test("sends review/start and returns TurnResult", async () => {
    const client = createMockClient({
      startMethod: "review/start",
      startResponse: {
        turn: { id: "review-turn-1", items: [], status: "inProgress" },
        reviewThreadId: "review-thr-1",
      } as ReviewStartResponse,
      completionParams: {
        threadId: "thr-1",
        turn: {
          id: "review-turn-1",
          items: [{ type: "agentMessage", id: "msg-1", text: "Review: looks good" }],
          status: "completed",
        },
      },
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
        turn: { id: "review-turn-2", items: [], status: "inProgress" },
        reviewThreadId: "review-thr-2",
      } as ReviewStartResponse,
      completionParams: {
        threadId: "thr-1",
        turn: {
          id: "review-turn-2",
          items: [],
          status: "failed",
          error: { message: "No changes to review" },
        },
      },
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

    const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
    const requestHandlerMap = new Map<string, (params: unknown) => unknown | Promise<unknown>>();

    const client: AppServerClient = {
      async request<T>(method: string): Promise<T> {
        if (method === "turn/start") {
          // After start, trigger approval requests via the registered onRequest handlers
          setTimeout(async () => {
            // Simulate a command approval request
            const cmdHandler = requestHandlerMap.get("item/commandExecution/requestApproval");
            if (cmdHandler) {
              await cmdHandler({
                threadId: "thr-1", turnId: "turn-1", itemId: "item-1",
                approvalId: "appr-1", reason: "needs sudo", command: "sudo rm -rf", cwd: "/",
              });
            }

            // Simulate a file change approval request
            const fileHandler = requestHandlerMap.get("item/fileChange/requestApproval");
            if (fileHandler) {
              await fileHandler({
                threadId: "thr-1", turnId: "turn-1", itemId: "item-2",
                reason: "write outside cwd", grantRoot: "/etc",
              });
            }

            // Now fire turn/completed
            const handlers = notificationHandlers.get("turn/completed");
            if (handlers) {
              for (const h of handlers) {
                h({
                  threadId: "thr-1",
                  turn: { id: "turn-1", items: [], status: "completed" },
                });
              }
            }
          }, 50);

          return { turn: { id: "turn-1", items: [], status: "inProgress" } } as T;
        }
        throw new Error(`Unexpected method: ${method}`);
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
        requestHandlerMap.set(method, handler);
        return () => { requestHandlerMap.delete(method); };
      },
      respond() {},
      async close() {},
      userAgent: "mock/1.0",
    };

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
