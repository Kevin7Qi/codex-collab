// src/commands/kill.ts — kill command handler

import {
  legacyFindShortId as findShortId,
  loadThreadMapping,
  updateThreadStatus,
} from "../threads";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  die,
  parseOptions,
  validateIdOrDie,
  resolveThreadIdOrDie,
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
  if (!id) die("Usage: codex-collab kill <id>");
  validateIdOrDie(id);

  const threadId = resolveThreadIdOrDie(ws.threadsFile, id);
  const shortId = findShortId(ws.threadsFile, threadId);

  // Skip kill for threads that have already reached a terminal status
  if (shortId) {
    const mapping = loadThreadMapping(ws.threadsFile);
    const localStatus = mapping[shortId]?.lastStatus;
    if (localStatus && localStatus !== "running") {
      progress(`Thread ${id} is already ${localStatus}`);
      return;
    }
  }

  // Write kill signal file so the running process can detect the kill.
  // Tag with the target run's PID; falls back to "*" (wildcard — matches
  // any active run on this thread) when no PID file is available.
  let killSignalWritten = false;
  const signalPath = join(ws.killSignalsDir, threadId);
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

  // Try to interrupt the active turn on the server (immediate effect).
  // The kill signal file handles the case where the run process is polling.
  // A connection-level failure (broker spawn, codex binary missing) must not
  // abort the command — the signal file is already written and the polling
  // run will still die, so fall through to report that.
  let serverInterrupted = false;
  try {
    await withClient(async (client) => {
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
    updateThreadStatus(ws.threadsFile, threadId, "interrupted");
    if (shortId) removePidFile(ws.pidsDir, shortId);
    progress(`Stopped thread ${id}`);
  } else {
    progress(`Could not signal thread ${id} — try again.`);
  }
}
