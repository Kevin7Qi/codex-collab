import { describe, expect, test } from "bun:test";
import {
  clearThreadGoal,
  getThreadGoal,
  goalNeedsAttention,
  isGoalFeatureUnavailable,
  isTerminalGoalStatus,
  pauseThreadGoal,
  setThreadGoal,
} from "./goals";
import type { AppServerClient } from "./client";
import type { ThreadGoal } from "./types";

function clientWith(onRequest: (method: string, params?: unknown) => unknown): AppServerClient {
  return {
    async request<T>(method: string, params?: unknown): Promise<T> {
      return onRequest(method, params) as T;
    },
    notify() {},
    on: () => () => {},
    onAny: () => () => {},
    onRequest: () => () => {},
    respond() {},
    onClose: () => () => {},
    async close() {},
    userAgent: "mock/1.0",
    brokerBusy: false,
  };
}

const goal: ThreadGoal = {
  threadId: "thr-1",
  objective: "ship it",
  status: "active",
  tokenBudget: 100_000,
  tokensUsed: 42_000,
  timeUsedSeconds: 60,
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
};

describe("goal status classification", () => {
  test("only active is non-terminal", () => {
    expect(isTerminalGoalStatus("active")).toBe(false);
    for (const s of ["complete", "paused", "blocked", "usageLimited", "budgetLimited"] as const) {
      expect(isTerminalGoalStatus(s)).toBe(true);
    }
  });

  test("needs-attention covers blocked and the server brakes, not pause/completion", () => {
    expect(goalNeedsAttention("blocked")).toBe(true);
    expect(goalNeedsAttention("usageLimited")).toBe(true);
    expect(goalNeedsAttention("budgetLimited")).toBe(true);
    expect(goalNeedsAttention("active")).toBe(false);
    expect(goalNeedsAttention("paused")).toBe(false);
    expect(goalNeedsAttention("complete")).toBe(false);
  });
});

describe("feature-unavailable classification", () => {
  test("recognizes the disabled/missing shapes", () => {
    expect(isGoalFeatureUnavailable(new Error("goals feature is disabled"))).toBe(true);
    expect(isGoalFeatureUnavailable(new Error("Method not found"))).toBe(true);
    expect(isGoalFeatureUnavailable(new Error("sqlite state db unavailable for thread goals"))).toBe(true);
  });

  test("real failures are not misclassified", () => {
    expect(isGoalFeatureUnavailable(new Error("connection reset"))).toBe(false);
    expect(isGoalFeatureUnavailable("goals feature is disabled")).toBe(false); // non-Error
  });
});

describe("getThreadGoal", () => {
  test("returns the goal from thread/goal/get", async () => {
    const client = clientWith((method, params) => {
      expect(method).toBe("thread/goal/get");
      expect((params as { threadId: string }).threadId).toBe("thr-1");
      return { goal };
    });
    expect(await getThreadGoal(client, "thr-1")).toEqual(goal);
  });

  test("returns null for no goal, feature-unavailable, and read failures", async () => {
    expect(await getThreadGoal(clientWith(() => ({ goal: null })), "thr-1")).toBeNull();
    expect(await getThreadGoal(clientWith(() => { throw new Error("goals feature is disabled"); }), "thr-1")).toBeNull();
    // Real failure: warn (not asserted) but still null — reads must not break runs.
    expect(await getThreadGoal(clientWith(() => { throw new Error("boom"); }), "thr-1")).toBeNull();
  });
});

describe("pauseThreadGoal / clearThreadGoal", () => {
  test("pause sends a status-only thread/goal/set", async () => {
    let sent: unknown;
    const client = clientWith((method, params) => {
      expect(method).toBe("thread/goal/set");
      sent = params;
      return { goal: { ...goal, status: "paused" } };
    });
    expect(await pauseThreadGoal(client, "thr-1")).toBe(true);
    expect(sent).toEqual({ threadId: "thr-1", status: "paused" });
  });

  test("pause reports failure — it is the headless-burn brake", async () => {
    const client = clientWith(() => { throw new Error("write failed"); });
    expect(await pauseThreadGoal(client, "thr-1")).toBe(false);
  });

  test("pause/clear on an unavailable feature succeed vacuously", async () => {
    const client = clientWith(() => { throw new Error("goals feature is disabled"); });
    expect(await pauseThreadGoal(client, "thr-1")).toBe(true);
    expect(await clearThreadGoal(client, "thr-1")).toBe(true);
  });

  test("clear sends thread/goal/clear", async () => {
    let cleared = false;
    const client = clientWith((method) => {
      expect(method).toBe("thread/goal/clear");
      cleared = true;
      return { cleared: true };
    });
    expect(await clearThreadGoal(client, "thr-1")).toBe(true);
    expect(cleared).toBe(true);
  });
});

describe("setThreadGoal", () => {
  test("sends objective and budget, returns the created goal", async () => {
    let sent: unknown;
    const client = clientWith((method, params) => {
      expect(method).toBe("thread/goal/set");
      sent = params;
      return { goal };
    });
    expect(await setThreadGoal(client, "thr-1", "ship it", 100_000)).toEqual(goal);
    expect(sent).toEqual({ threadId: "thr-1", objective: "ship it", tokenBudget: 100_000 });
  });

  test("omits tokenBudget entirely when not given", async () => {
    let sent: unknown;
    const client = clientWith((method, params) => {
      sent = params;
      return { goal: { ...goal, tokenBudget: null } };
    });
    await setThreadGoal(client, "thr-1", "ship it");
    expect(sent).toEqual({ threadId: "thr-1", objective: "ship it" });
  });

  test("errors propagate — a user-requested set must not fail silently", async () => {
    const client = clientWith(() => { throw new Error("goals feature is disabled"); });
    await expect(setThreadGoal(client, "thr-1", "ship it")).rejects.toThrow("goals feature is disabled");
  });
});
