// src/commands/kill.ts — kill command handler

import { getLatestRun, listRunsForThread, loadThreadIndex, updateRun, updateThreadStatus } from "../threads";
import { writeFileSync } from "fs";
import { join } from "path";
import { pauseThreadGoal, clearThreadGoal, isGoalFeatureUnavailable } from "../goals";
import type { AppServerClient } from "../client";
import type { ThreadGoal } from "../types";
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
  isThreadProcessAlive,
} from "./shared";

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

  // A run that JOINED another client's turn on a shared app-server owns
  // nothing on the server: the signal file stops its wait, and that is all
  // a kill may do — the turn, and any goal on the thread, are theirs.
  // The run that is RUNNING, not merely the newest record: an invocation
  // refused as busy leaves a newer, failed record beside the live one.
  const activeRunOf = (id: string) => listRunsForThread(ws.stateDir, id).find((r) => r.status === "running") ?? getLatestRun(ws.stateDir, id);
  const latestRun = shortId ? activeRunOf(shortId) : null;
  const joinedRecord = threadRunning && latestRun?.status === "running" && latestRun.joined === true;
  // A run still starting has not learned whose turn it is waiting on: on a
  // shared app-server the thread's active turn may be another client's.
  // Its own process reacts to the signal file; the server is left alone.
  // Both of these hold only while that process is alive: a run whose
  // process died mid-start left whatever it started to the broker's
  // orphan recovery (or, on a private server, to the interrupt below).
  const runAlive = !!shortId && isThreadProcessAlive(ws.pidsDir, shortId);
  // A joined turn is another client's whether or not our process lives.
  const joined = joinedRecord;
  const startingRecord = threadRunning && latestRun?.status === "running" && latestRun.phase === "starting" && !joined;
  const starting = startingRecord && runAlive;

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
  if (startingRecord && !runAlive) {
    // The run's process died before its start settled. On a shared server
    // whatever it started is not known to be ours — the broker's orphan
    // recovery handles it — so the server is left alone; on a private one
    // every turn is ours, and the interrupt below is right.
    let shared = false;
    try {
      shared = await withClient(async (client) => client.server.kind === "shared", options.dir);
    } catch { /* unreachable server: nothing to interrupt anyway */ }
    if (shared) {
      if (shortId) {
        updateThreadStatus(ws.stateDir, threadId, "interrupted");
        removePidFile(ws.pidsDir, shortId);
      }
      progress("The run's process is gone. Nothing on the server was touched, since the turn it was starting may be another client's; a turn of ours is the broker's to recover.");
      return;
    }
  }
  if (starting) {
    // A CLI run polls the signal file; a peer's attempt is cancelled in the
    // broker. Neither touches the server: the turn may be another client's.
    let cancelled = false;
    try {
      cancelled = await withClient(async (client) => {
        if (!client.isBrokered) return false;
        const r = await client.request<{ cancelled?: boolean }>("broker/cancelJoined", { threadId });
        return r?.cancelled === true;
      }, options.dir);
    } catch { /* no broker to reach: the signal file is all there is */ }
    // The attempt may have settled between the ledger read and the cancel:
    // a peer run now running under a turn of its own reacts to no signal
    // file, so it is stopped like any other run, below. (A CLI run keeps
    // its "starting" phase until its own process advances it, and that
    // process polls the file.)
    const now = !cancelled && shortId ? activeRunOf(shortId) : null;
    const startedMeanwhile = now?.status === "running" && now.phase !== "starting" && now.joined !== true;
    if (!startedMeanwhile) {
      progress(
        cancelled || killSignalWritten
          ? "The run is still starting; it was told to stop and will not go on. Nothing on the server was touched, since the turn may be another client's."
          : "The run is still starting and could not be signalled; nothing on the server was touched.",
      );
      return;
    }
    progress("The run started while the kill was on its way; stopping its turn.");
  }
  if (joined) {
    // A CLI run polls the signal file written above; a peer's wait lives in
    // the broker and is cancelled there. Neither touches the turn. Both are
    // tried — the record does not say which kind of run joined.
    let cancelled = false;
    try {
      cancelled = await withClient(async (client) => {
        if (!client.isBrokered) return false;
        const r = await client.request<{ cancelled?: boolean }>("broker/cancelJoined", { threadId });
        return r?.cancelled === true;
      }, options.dir);
    } catch (e) {
      console.error(`[codex] Warning: could not reach the broker to stop a peer wait: ${e instanceof Error ? e.message : String(e)}`);
    }
    progress(
      cancelled || killSignalWritten
        ? "Stopped waiting: the turn belongs to another client of the shared app-server and continues there."
        : "The turn belongs to another client of the shared app-server; nothing here to stop.",
    );
    if (!runAlive && shortId) {
      // Nobody is waiting any more: the ledger must not say "running".
      updateThreadStatus(ws.stateDir, threadId, "interrupted");
      removePidFile(ws.pidsDir, shortId);
    }
    return;
  }
  try {
    await withClient(async (client) => {
      // Goal FIRST, interrupt second: with an active goal, `turn/interrupt`
      // alone just makes the server start a fresh continuation turn. Pause
      // keeps the goal resumable (a later turn continues it); --clear
      // abandons it entirely.
      // Whether the goal is CONFIRMED gone server-side (cleared now, or the
      // server said there is none). The ledger reconciliation below must not
      // outrun reality: stamping "cleared" while the clear actually failed
      // would leave a resumable server-side goal the user believes abandoned.
      let goalKnownGone = false;
      try {
        const { goal, readFailed } = await readGoalWithRetry(client, threadId);
        if (goal) {
          if (options.clear) {
            if (await clearThreadGoal(client, threadId)) {
              goalStopped = true;
              goalKnownGone = true;
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
            goalKnownGone = true;
            progress("Cleared goal (state was unreadable — cleared blindly).");
          }
        } else if (readFailed) {
          progress("Could not read goal state — if a goal is active, the running process pauses it on kill.");
        } else {
          goalKnownGone = true; // read succeeded: no goal on this thread
          if (options.clear) progress("No goal on this thread.");
        }
      } catch (e) {
        console.error(`[codex] Warning: could not stop thread goal: ${e instanceof Error ? e.message : String(e)}`);
      }

      // After --clear, reconcile the ledger: the latest run's goal mirror is
      // what `threads` shows, and leaving it "paused"/"active" would keep
      // advertising a goal that no longer exists (inviting a pointless
      // resume). Only once the server-side goal is confirmed gone — the
      // no-goal-but-stale-mirror case included.
      if (options.clear && goalKnownGone && shortId) {
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
