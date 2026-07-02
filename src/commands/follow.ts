// src/commands/follow.ts — live tail of a running turn
//
// `follow [id]` is the primary human-facing view of Codex working: run it in
// a split terminal pane (zero model-context cost) or in the foreground for
// short turns. It replays the current run's log section for context, then
// tails the log until the run reaches a terminal state, and exits with a
// clear status line — or, with --watch, stays attached and picks up the next
// run automatically (multi-turn Claude ⇄ Codex conversations in one pane).
// The log file + run record are the source of truth, so it attaches to any
// run regardless of who owns the runner process — foreground, background, or
// detached — and survives broker handoffs.

import { openSync, readSync, closeSync, fstatSync } from "fs";
import { join } from "path";
import {
  legacyFindShortId as findShortId,
  getLatestRun,
  listRuns,
  listRunsForThread,
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
  type WorkspacePaths,
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

/**
 * Pick the run a bare `follow` should attach to: the newest run that is both
 * marked running AND whose runner process is alive (a stale `running` record
 * from a crash shouldn't shadow real work), else the newest run overall
 * (replay). Exported for tests.
 */
export function pickDefaultRun(stateDir: string, pidsDir: string): RunRecord | null {
  const runs = listRuns(stateDir); // newest first
  const live = runs.find(r => r.status === "running" && isThreadProcessAlive(pidsDir, r.shortId));
  return live ?? runs[0] ?? null;
}

/**
 * In watch mode, find the next run to display: the OLDEST run not yet seen
 * (scoped to one thread, or the whole workspace). Walking oldest-first with
 * a seen-set guarantees every run is displayed exactly once, in start order,
 * even when multiple threads run concurrently — runs that finished while the
 * watcher was attached elsewhere show up as quick replays instead of being
 * skipped. Returns null while there's nothing unseen. Exported for tests.
 */
export function nextUnseenRun(
  stateDir: string,
  seen: ReadonlySet<string>,
  scopedShortId: string | null,
): RunRecord | null {
  const runs = scopedShortId ? listRunsForThread(stateDir, scopedShortId) : listRuns(stateDir);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!seen.has(runs[i].runId)) return runs[i]; // newest-first list → walk backwards
  }
  return null;
}

interface FollowOutcome {
  record: RunRecord;
  /** The record still said running but the runner process was confirmed dead. */
  runnerDied: boolean;
}

/** Render one run from its logOffset until it reaches a terminal state
 *  (replay + live tail). Prints the header and the final status line. */
async function followRun(ws: WorkspacePaths, run: RunRecord, render: RenderOptions): Promise<FollowOutcome> {
  const shortId = run.shortId;
  const logPath = join(ws.logsDir, `${shortId}.log`);

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

  const finish = (rec: RunRecord): FollowOutcome => {
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
    return { record: rec, runnerDied: false };
  };

  // Attach-after-finish: replay this run's log section, then the status line.
  if (run.status !== "running") {
    return finish(run);
  }

  while (true) {
    const next = readNewBytes(logPath, offset);
    offset = next.offset;
    show(next.bytes);

    const rec = loadRun(ws.stateDir, run.runId) ?? run;
    if (rec.status !== "running") return finish(rec);

    // Run says running but its runner process is gone: don't sit forever on
    // a log that will never terminate. (A missing PID file reads as alive —
    // see isThreadProcessAlive — so this only trips on a confirmed-dead PID.)
    if (!isThreadProcessAlive(ws.pidsDir, shortId)) {
      console.error(`[codex] Runner process for ${shortId} is gone but the run is still marked running — it may have crashed. Check: codex-collab threads`);
      return { record: rec, runnerDied: true };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

export async function handleFollow(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);

  const render: RenderOptions = {
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    width: (process.stdout.isTTY && process.stdout.columns) || 120,
  };

  // ID-scoped follow watches that thread; bare follow watches the workspace.
  let scopedShortId: string | null = null;
  let run: RunRecord | null;
  if (positional.length === 0) {
    run = pickDefaultRun(ws.stateDir, ws.pidsDir);
    if (!run && !options.watch) {
      die("No runs in this workspace yet.\nUsage: codex-collab follow [id] [--watch]");
    }
  } else {
    const threadId = resolveThreadIdOrDie(ws.threadsFile, positional[0]);
    scopedShortId = findShortId(ws.threadsFile, threadId) ?? positional[0];
    run = getLatestRun(ws.stateDir, scopedShortId);
    if (!run && !options.watch) {
      die(`No run history for thread ${scopedShortId}. For the raw log, use: codex-collab output ${scopedShortId}`);
    }
  }

  if (!options.watch) {
    const outcome = await followRun(ws, run!, render);
    process.exit(outcome.runnerDied || outcome.record.status !== "completed" ? 1 : 0);
  }

  // --watch: stay attached across runs — a multi-turn Claude ⇄ Codex
  // conversation shows up as consecutive runs, each followed as it appears;
  // concurrent threads are serialized in start order (one pane, one stream —
  // open a second `follow <id> --watch` pane to track two threads live).
  // Runs until Ctrl-C.
  //
  // Seed the seen-set with everything that already exists except the run we
  // first attach to, so starting a watch doesn't replay workspace history.
  const seen = new Set<string>();
  for (const r of listRuns(ws.stateDir)) {
    if (r.runId !== run?.runId) seen.add(r.runId);
  }

  let hadRun = false;
  while (true) {
    if (run) {
      seen.add(run.runId);
      await followRun(ws, run, render);
      console.log("");
      hadRun = true;
    }
    run = nextUnseenRun(ws.stateDir, seen, scopedShortId);
    if (!run) {
      console.log(renderDim(
        hadRun ? "⏳ waiting for the next run… (Ctrl-C to stop)" : "⏳ waiting for the first run… (Ctrl-C to stop)",
        render.color,
      ));
      do {
        await sleep(POLL_INTERVAL_MS);
        run = nextUnseenRun(ws.stateDir, seen, scopedShortId);
      } while (!run);
    }
  }
}

function renderDim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}
