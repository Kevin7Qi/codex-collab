// src/goals.ts — Goal protocol helpers (thread/goal/get|set|clear)
//
// Codex's Goal mode is SERVER-driven multi-turn: with an active goal, the
// goal runtime auto-starts a new turn the instant one completes. These
// helpers are the CLI's levers on that machinery. Two design rules:
//
// 1. Reading goal state is an ENHANCEMENT — a failure must never take a
//    run down with it (the goals feature may be disabled, the state db
//    unavailable, or the server too old). Read helpers return null.
// 2. PAUSING is a BRAKE — the timeout and kill paths rely on it to stop
//    headless token burn, so its failure is loud (returned to the caller,
//    who decides how loud).
//
// Pause-before-interrupt ordering matters everywhere: `turn/interrupt` does
// not pause a goal, so interrupting first just makes the server start a
// fresh continuation turn (verified against codex 0.142.3).

import type { AppServerClient } from "./client";
import type { ThreadGoal, ThreadGoalStatus } from "./types";

/** Statuses the server will NOT continue from. Everything but `active`. */
export function isTerminalGoalStatus(status: ThreadGoalStatus): boolean {
  return status !== "active";
}

/** Goal statuses that mean "Codex needs you": the model stalled out
 *  (`blocked`, stamped after 3 consecutive no-progress turns) or a server
 *  brake engaged (usage/token-budget). Mapped to their own exit code so
 *  callers can distinguish "goal needs attention" from success/failure.
 *  Accepts the run-record widening ("cleared") for caller convenience. */
export function goalNeedsAttention(status: ThreadGoalStatus | "cleared"): boolean {
  return status === "blocked" || status === "usageLimited" || status === "budgetLimited";
}

/** True iff the error means the goals feature isn't available at all —
 *  disabled by config, method unknown to an older server, or the goal state
 *  db missing. Callers treat these as "no goal", silently. */
export function isGoalFeatureUnavailable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("goals feature is disabled")
    || msg.includes("method not found")
    || msg.includes("unknown method")
    || msg.includes("sqlite state db unavailable");
}

/** Read the thread's goal. Returns null when there is no goal, the feature
 *  is unavailable, or the read fails (with a warning for real failures) —
 *  goal awareness must never break a run that would otherwise work. */
export async function getThreadGoal(
  client: AppServerClient,
  threadId: string,
): Promise<ThreadGoal | null> {
  try {
    const res = await client.request<{ goal: ThreadGoal | null }>("thread/goal/get", { threadId });
    return res.goal ?? null;
  } catch (e) {
    if (!isGoalFeatureUnavailable(e)) {
      console.error(`[codex] Warning: could not read thread goal: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }
}

/** Pause the thread's goal so the server stops auto-continuing. This is the
 *  brake the timeout and kill paths depend on — returns false on failure so
 *  the caller can warn that the goal may keep burning tokens headless.
 *  Status-only set preserves the objective (verified 0.142.3). */
export async function pauseThreadGoal(
  client: AppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request("thread/goal/set", { threadId, status: "paused" });
    return true;
  } catch (e) {
    if (isGoalFeatureUnavailable(e)) return true; // nothing to pause
    console.error(`[codex] Warning: could not pause thread goal: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Clear (abandon) the thread's goal. Used by `kill --clear`. */
export async function clearThreadGoal(
  client: AppServerClient,
  threadId: string,
): Promise<boolean> {
  try {
    await client.request("thread/goal/clear", { threadId });
    return true;
  } catch (e) {
    if (isGoalFeatureUnavailable(e)) return true; // nothing to clear
    console.error(`[codex] Warning: could not clear thread goal: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
