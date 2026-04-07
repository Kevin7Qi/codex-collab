// src/commands/kill.ts — kill command handler

import { config } from "../config";
import {
  legacyResolveThreadId as resolveThreadId,
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
  progress,
  withClient,
  removePidFile,
} from "./shared";

export async function handleKill(args: string[]): Promise<void> {
  const { positional } = parseOptions(args);
  const id = positional[0];
  if (!id) die("Usage: codex-collab kill <id>");
  validateIdOrDie(id);

  const threadId = resolveThreadId(config.threadsFile, id);
  const shortId = findShortId(config.threadsFile, threadId);

  // Skip kill for threads that have already reached a terminal status
  if (shortId) {
    const mapping = loadThreadMapping(config.threadsFile);
    const localStatus = mapping[shortId]?.lastStatus;
    if (localStatus && localStatus !== "running") {
      progress(`Thread ${id} is already ${localStatus}`);
      return;
    }
  }

  // Write kill signal file so the running process can detect the kill
  let killSignalWritten = false;
  const signalPath = join(config.killSignalsDir, threadId);
  try {
    writeFileSync(signalPath, "", { mode: 0o600 });
    killSignalWritten = true;
  } catch (e) {
    console.error(
      `[codex] Warning: could not write kill signal: ${e instanceof Error ? e.message : String(e)}. ` +
      `The running process may not detect the kill.`,
    );
  }

  // Try to interrupt the active turn on the server (immediate effect).
  // The kill signal file handles the case where the run process is polling.
  let serverInterrupted = false;
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
  });

  if (killSignalWritten || serverInterrupted) {
    updateThreadStatus(config.threadsFile, threadId, "interrupted");
    if (shortId) removePidFile(shortId);
    progress(`Stopped thread ${id}`);
  } else {
    progress(`Could not signal thread ${id} — try again.`);
  }
}
