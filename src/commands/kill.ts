// src/commands/kill.ts — kill command handler

import { getLatestRun, loadThreadIndex, updateRun, updateThreadStatus } from "../threads";
import { writeFileSync } from "fs";
import { join } from "path";
import { pauseThreadGoal, clearThreadGoal, isGoalFeatureUnavailable } from "../goals";
import type { AppServerClient } from "../client";
import type { ThreadGoal } from "../types";

/** Read the thread goal with a few retries: a live goal-following run owns
 *  the broker stream and its own in-flight polls can transiently bounce our
 *  request with "broker busy" — exactly the moment kill is most used. */
async function readGoalWithRetry(
  client: AppServerClient,
  threadId: string,
): Promise<{ goal: ThreadGoal | null; readFailed: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.request<{ goal: ThreadGoal | null }>("thread/goal/get", { threadId });
      return { goal: res.goal ?? null, readFailed: false };
    } catch (e) {
      if (isGoalFeatureUnavailable(e)) return { goal: null, readFailed: false };
      if (attempt >= 2) {
        console.error(`[codex] Warning: could not read thread goal: ${e instanceof Error ? e.message : String(e)}`);
        return { goal: null, readFailed: true };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
import {
  die,
  parseOptions,
  validateIdOrDie,
  resolveThreadIdAllowRaw,
  progress,
  withClient,
  readPidFile,
  removePidFile,
  getWorkspacePaths,
} from "./shared";

export async function handleKill(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const id = positional[0];
  if (!id) die("Usage: codex-collab kill <id> [--clear]");
  validateIdOrDie(id);

  const { threadId, shortId } = resolveThreadIdAllowRaw(ws.stateDir, id);

  // A thread already at a terminal status has no run to kill — but with
  // --clear the goal is the target, and a goal outlives its runs (that's
  // the point of the timeout-pause), so fall through to the goal handling.
  let threadRunning = true;
  if (shortId) {
    const index = loadThreadIndex(ws.stateDir);
    const localStatus = index[shortId]?.lastStatus;
    if (localStatus && localStatus !== "running") {
      if (!options.clear) {
        progress(`Thread ${id} is already ${localStatus}`);
        return;
      }
      threadRunning = false;
    }
  }

  // Write kill signal file so the running process can detect the kill.
  // Tag with the target run's PID; falls back to "*" (wildcard — matches
  // any active run on this thread) when no PID file is available. Skipped
  // when nothing is running (--clear on a settled thread) — a lingering
  // wildcard signal would target the thread's NEXT run.
  let killSignalWritten = false;
  const signalPath = join(ws.killSignalsDir, threadId);
  if (threadRunning) {
    const pid = shortId ? readPidFile(ws.pidsDir, shortId) : null;
    const targetPid = pid !== null ? String(pid) : "*";
    try {
      writeFileSync(signalPath, targetPid, { mode: 0o600 });
      killSignalWritten = true;
    } catch (e) {
      console.error(
        `[codex] Warning: could not write kill signal: ${e instanceof Error ? e.message : String(e)}. ` +
        `The running process may not detect the kill.`,
      );
    }
  }

  // Try to interrupt the active turn on the server (immediate effect).
  // The kill signal file handles the case where the run process is polling.
  // A connection-level failure (broker spawn, codex binary missing) must not
  // abort the command — the signal file is already written and the polling
  // run will still die, so fall through to report that.
  let serverInterrupted = false;
  let goalStopped = false;
  try {
    await withClient(async (client) => {
      // Goal FIRST, interrupt second: with an active goal, `turn/interrupt`
      // alone just makes the server start a fresh continuation turn. Pause
      // keeps the goal resumable (a later turn continues it); --clear
      // abandons it entirely.
      try {
        const { goal, readFailed } = await readGoalWithRetry(client, threadId);
        if (goal) {
          if (options.clear) {
            if (await clearThreadGoal(client, threadId)) {
              goalStopped = true;
              progress(`Cleared goal (was ${goal.status}): ${goal.objective.split("\n", 1)[0].slice(0, 80)}`);
            }
          } else if (goal.status === "active") {
            if (await pauseThreadGoal(client, threadId)) {
              goalStopped = true;
              progress("Paused goal — a new turn on this thread resumes it; `kill --clear` abandons it.");
            }
          }
        } else if (readFailed && options.clear) {
          // Can't see the goal but the user asked for it gone — clear blindly
          // (clearing a goal-less thread is a no-op server-side).
          if (await clearThreadGoal(client, threadId)) {
            goalStopped = true;
            progress("Cleared goal (state was unreadable — cleared blindly).");
          }
        } else if (readFailed) {
          progress("Could not read goal state — if a goal is active, the running process pauses it on kill.");
        } else if (options.clear) {
          progress("No goal on this thread.");
        }
      } catch (e) {
        console.error(`[codex] Warning: could not stop thread goal: ${e instanceof Error ? e.message : String(e)}`);
      }

      // After --clear, reconcile the ledger: the latest run's goal mirror is
      // what `threads` shows, and leaving it "paused"/"active" would keep
      // advertising a goal that no longer exists (inviting a pointless
      // resume). Stamped even when the server had no goal — that's exactly
      // the stale-mirror case.
      if (options.clear && shortId) {
        try {
          const latest = getLatestRun(ws.stateDir, shortId);
          if (latest?.goal && latest.goal.status !== "complete" && latest.goal.status !== "cleared") {
            updateRun(ws.stateDir, latest.runId, {
              goal: { ...latest.goal, status: "cleared", updatedAt: new Date().toISOString() },
            });
          }
        } catch (e) {
          console.error(`[codex] Warning: could not update run record goal state: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      try {
        const { thread } = await client.request<{
          thread: {
            id: string;
            status: { type: string };
            turns: Array<{ id: string; status: string }>;
          };
        }>("thread/read", { threadId, includeTurns: true });

        if (thread.status.type === "active") {
          const activeTurn = thread.turns?.find(
            (t) => t.status === "inProgress",
          );
          if (activeTurn) {
            await client.request("turn/interrupt", {
              threadId,
              turnId: activeTurn.id,
            });
            serverInterrupted = true;
            progress(`Interrupted turn ${activeTurn.id}`);
          }
        }
      } catch (e) {
        if (e instanceof Error && !e.message.includes("not found")) {
          console.error(`[codex] Warning: could not read/interrupt thread: ${e.message}`);
        }
      }
    }, options.dir);
  } catch (e) {
    console.error(`[codex] Warning: could not reach app server: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (killSignalWritten || serverInterrupted) {
    if (shortId) {
      updateThreadStatus(ws.stateDir, threadId, "interrupted");
      removePidFile(ws.pidsDir, shortId);
    }
    progress(`Stopped thread ${id}`);
  } else if (goalStopped) {
    // --clear on a settled thread: nothing was running, only the goal ended.
    progress(`Goal ${options.clear ? "cleared" : "paused"} on thread ${id}`);
  } else if (!threadRunning) {
    progress(`Nothing to stop on thread ${id}.`);
  } else {
    progress(`Could not signal thread ${id} — try again.`);
  }
}
