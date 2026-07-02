// src/commands/follow.ts — live tail of a running turn
//
// `follow <id>` is the primary human-facing view of Codex working: run it in
// a split terminal pane (zero model-context cost) or in the foreground for
// short turns. It replays the current run's log section for context, then
// tails the log until the run reaches a terminal state, and exits with a
// clear status line. The log file + run record are the source of truth, so
// it attaches to any run regardless of who owns the runner process —
// foreground, background, or detached — and survives broker handoffs.

import { openSync, readSync, closeSync, fstatSync } from "fs";
import { join } from "path";
import {
  legacyFindShortId as findShortId,
  getLatestRun,
  loadRun,
} from "../threads";
import { LogEntryParser, renderEntry, renderFinalStatus, type RenderOptions } from "../render";
import type { RunRecord } from "../types";
import {
  die,
  parseOptions,
  getWorkspacePaths,
  resolveThreadIdOrDie,
  isThreadProcessAlive,
  formatAge,
} from "./shared";

const POLL_INTERVAL_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read bytes [offset, size) from the log. Returns the new offset and the
 *  raw bytes (decoded by the caller's streaming decoder, so multi-byte
 *  characters split across reads survive). */
function readNewBytes(logPath: string, offset: number): { bytes: Buffer; offset: number } {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0), offset };
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) {
      // A shrunk file means the log was cleaned/rotated under us — restart
      // from its current end rather than re-printing unrelated old content.
      return { bytes: Buffer.alloc(0), offset: Math.min(offset, size) };
    }
    const bytes = Buffer.alloc(size - offset);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), offset: offset + read };
  } finally {
    closeSync(fd);
  }
}

export async function handleFollow(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  if (positional.length === 0) {
    die("No thread ID provided\nUsage: codex-collab follow <id>");
  }

  const ws = getWorkspacePaths(options.dir);
  const threadId = resolveThreadIdOrDie(ws.threadsFile, positional[0]);
  const shortId = findShortId(ws.threadsFile, threadId) ?? positional[0];
  const logPath = join(ws.logsDir, `${shortId}.log`);

  const render: RenderOptions = {
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    width: (process.stdout.isTTY && process.stdout.columns) || 120,
  };

  const run = getLatestRun(ws.stateDir, shortId);
  if (!run) {
    die(`No run history for thread ${shortId}. For the raw log, use: codex-collab output ${shortId}`);
  }

  const started = new Date(run.startedAt).getTime();
  const age = Number.isFinite(started) ? formatAge(Math.round(started / 1000)) : "unknown time";
  const headerBits = [
    `thread ${shortId}`,
    run.kind,
    `started ${age}`,
    ...(run.model ? [run.model] : []),
  ];
  console.log(renderDim(`⏵ following ${headerBits.join(" · ")}`, render.color));

  const parser = new LogEntryParser();
  const decoder = new TextDecoder("utf-8");
  let offset = run.logOffset;

  const show = (chunkBytes: Buffer) => {
    const text = decoder.decode(chunkBytes, { stream: true });
    for (const entry of parser.feed(text)) {
      for (const line of renderEntry(entry, render)) console.log(line);
    }
  };

  const finish = (rec: RunRecord): never => {
    // Drain whatever the writer flushed after the terminal-state update.
    const tail = readNewBytes(logPath, offset);
    show(tail.bytes);
    for (const entry of parser.drain()) {
      for (const line of renderEntry(entry, render)) console.log(line);
    }
    console.log(renderFinalStatus(rec.status, {
      elapsed: rec.elapsed,
      filesChanged: rec.filesChanged?.length,
      error: rec.error,
    }, render.color));
    process.exit(rec.status === "completed" ? 0 : 1);
  };

  // Attach-after-finish: replay this run's log section, then the status line.
  if (run.status !== "running") {
    finish(run);
  }

  while (true) {
    const next = readNewBytes(logPath, offset);
    offset = next.offset;
    show(next.bytes);

    const rec = loadRun(ws.stateDir, run.runId) ?? run;
    if (rec.status !== "running") finish(rec);

    // Run says running but its runner process is gone: don't sit forever on
    // a log that will never terminate. (A missing PID file reads as alive —
    // see isThreadProcessAlive — so this only trips on a confirmed-dead PID.)
    if (!isThreadProcessAlive(ws.pidsDir, shortId)) {
      console.error(`[codex] Runner process for ${shortId} is gone but the run is still marked running — it may have crashed. Check: codex-collab threads`);
      process.exit(1);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function renderDim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}
