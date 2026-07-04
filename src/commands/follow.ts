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
import { resolve } from "path";
import {
  findShortId,
  listRuns,
  listRunsForThread,
  loadRun,
  loadThreadIndex,
} from "../threads";
import { resolveRunLogPath } from "./threads";
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

/** Read bytes [offset, min(size, maxOffset)) from the log. Returns the new
 *  offset and the raw bytes (decoded by the caller's streaming decoder, so
 *  multi-byte characters split across reads survive). `maxOffset` bounds a
 *  replay to this run's own section of a shared thread log. */
function readNewBytes(logPath: string, offset: number, maxOffset: number | null = null): { bytes: Buffer; offset: number } {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0), offset };
    throw e;
  }
  try {
    let size = fstatSync(fd).size;
    if (maxOffset !== null && maxOffset < size) size = maxOffset;
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

/** Run-specific liveness. Prefer the record's own runner PID: the thread's
 *  PID file tracks only the LATEST runner, so a stale older `running` record
 *  would read as alive through its successor's file and stall a watch
 *  forever. Records from older versions (no pid field) fall back to the
 *  thread-level check. Exported for tests. */
export function runIsLive(run: RunRecord, pidsDir: string): boolean {
  if (typeof run.pid === "number" && run.pid > 0) {
    try {
      process.kill(run.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  return isThreadProcessAlive(pidsDir, run.shortId);
}

/**
 * Candidate runs for bare-follow selection, newest first. Run records whose
 * thread is no longer in the index are excluded: `delete` now removes them,
 * but records orphaned by older versions would otherwise attach follow to a
 * thread with no mapping, no log, and no PID file — a stale `running` orphan
 * reads as alive (missing PID file = alive) and would hang the tail forever.
 */
function candidateRuns(stateDir: string): RunRecord[] {
  const runs = listRuns(stateDir); // newest first
  const index = loadThreadIndex(stateDir);
  return runs.filter(r => Object.hasOwn(index, r.shortId));
}

/**
 * Pick the run a one-shot bare `follow` attaches to: the newest run that is
 * both marked running AND whose runner process is alive (a stale `running`
 * record from a crash shouldn't shadow real work), else the newest run
 * overall (replay). Exported for tests.
 */
export function pickDefaultRun(stateDir: string, pidsDir: string): RunRecord | null {
  const runs = candidateRuns(stateDir);
  const live = runs.find(r => r.status === "running" && runIsLive(r, pidsDir));
  return live ?? runs[0] ?? null;
}

/**
 * Watch-mode start run: the OLDEST live run, not the newest — the watch
 * displays runs in start order, and starting from the newest would leave an
 * older still-running (possibly approval-blocked) run invisible until the
 * newer one finished. Falls back to the newest run overall for a replay.
 * Exported for tests.
 */
export function pickWatchStartRun(stateDir: string, pidsDir: string): RunRecord | null {
  const runs = candidateRuns(stateDir);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === "running" && runIsLive(runs[i], pidsDir)) {
      return runs[i];
    }
  }
  return runs[0] ?? null;
}

/**
 * Scoped-follow selection within one thread: prefer a LIVE running run —
 * an older run can still be active (or approval-blocked) while a newer
 * terminal record exists, and replaying the newer one would exit without
 * ever showing the active work. Watch mode asks for the oldest live run
 * (start-order display); one-shot follow takes the newest. Falls back to
 * the latest record for a replay. Exported for tests.
 */
export function pickThreadRun(
  stateDir: string,
  pidsDir: string,
  shortId: string,
  oldestLive = false,
): RunRecord | null {
  const runs = listRunsForThread(stateDir, shortId); // newest first
  const live = runs.filter(r => r.status === "running" && runIsLive(r, pidsDir));
  if (live.length > 0) return oldestLive ? live[live.length - 1] : live[0];
  return runs[0] ?? null;
}

/** True iff run `a` comes after run `b` (startedAt, runId tiebreak). */
function laterThan(a: RunRecord, b: RunRecord): boolean {
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return a.runId > b.runId;
}

/**
 * Where this run's section of its log file ends: the smallest logOffset of
 * any LATER run writing to the SAME file, or null (unbounded — this run owns
 * the file's tail). Per-run records own their file exclusively, so the bound
 * is always null for them; legacy records share `logs/{shortId}.log`, where
 * a replay that read to EOF would swallow the next run's entries and the
 * watch loop would then render them a second time.
 *
 * "Later" must include runs at the SAME offset: a run that dies before
 * writing any log bytes leaves the next run starting at the identical
 * offset, and the empty run's replay must be zero-length, not the tail.
 * Exported for tests.
 */
export function replayBound(stateDir: string, run: RunRecord): number | null {
  // Canonicalize before comparing: migration-created records store logFile
  // as an absolute path while normal legacy records store the same physical
  // file as a stateDir-relative "logs/{shortId}.log" — a raw string compare
  // would fail to group them and leave the older run's replay unbounded.
  const logFileOf = (r: RunRecord): string | null =>
    r.logFile ? resolve(stateDir, r.logFile) : null;
  const runLogFile = logFileOf(run);
  let bound: number | null = null;
  for (const r of listRunsForThread(stateDir, run.shortId)) {
    if (r.runId === run.runId) continue;
    if (logFileOf(r) !== runLogFile) continue;
    const later = r.logOffset > run.logOffset
      || (r.logOffset === run.logOffset && laterThan(r, run));
    if (later && (bound === null || r.logOffset < bound)) {
      bound = r.logOffset;
    }
  }
  return bound;
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
  const runs = scopedShortId
    ? listRunsForThread(stateDir, scopedShortId)
    : candidateRuns(stateDir);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!seen.has(runs[i].runId)) return runs[i]; // newest-first list → walk backwards
  }
  return null;
}

/**
 * Seed the --watch seen-set: everything already in the ledger EXCEPT runs
 * that are currently live (running with an alive runner) and the run being
 * attached first. Marking history as seen keeps a new watch from replaying
 * the whole workspace; leaving live runs unseen keeps concurrent active
 * work from being silently skipped once the first run finishes.
 * Exported for tests.
 */
export function seedSeenRuns(stateDir: string, pidsDir: string, exceptRunId?: string): Set<string> {
  const seen = new Set<string>();
  for (const r of listRuns(stateDir)) {
    if (r.runId === exceptRunId) continue;
    const live = r.status === "running" && runIsLive(r, pidsDir);
    if (!live) seen.add(r.runId);
  }
  return seen;
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
  // The run's own log file (per-run records) or the shared thread log
  // (legacy records / migration fallback), confined to the logs dirs.
  const logPath = resolveRunLogPath(ws.stateDir, ws.logsDir, run);
  // Computed fresh before every read (loop top and finish) — see below.
  let bound: number | null = null;

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

  // Render everything the writer flushed that we haven't shown yet —
  // bounded to this run's log section (a later run on the same thread may
  // already have appended past it) — then flush any unterminated
  // agent-output block. Used on every exit path: normal completion AND a
  // dead runner, whose last flushed bytes must not be dropped.
  const drainRemaining = () => {
    bound = replayBound(ws.stateDir, run);
    const tail = readNewBytes(logPath, offset, bound);
    offset = tail.offset;
    show(tail.bytes);
    for (const entry of parser.drain()) {
      for (const line of renderEntry(entry, render)) console.log(line);
    }
  };

  const finish = (rec: RunRecord): FollowOutcome => {
    drainRemaining();
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
    // Refresh the bound BEFORE reading, never after: a follow-up run
    // registers its record (fixing its logOffset) before it writes its
    // first log byte, so a read clamped to a just-computed bound can never
    // consume the next run's section — a bound carried over from the
    // previous iteration could be stale by one 300ms sleep.
    bound = replayBound(ws.stateDir, run);
    const next = readNewBytes(logPath, offset, bound);
    offset = next.offset;
    show(next.bytes);

    const rec = loadRun(ws.stateDir, run.runId) ?? run;
    if (rec.status !== "running") return finish(rec);

    // Run says running but its runner process is gone: don't sit forever on
    // a log that will never terminate. Run-specific check — the thread's PID
    // file may already belong to a successor run's live process.
    if (!runIsLive(rec, ws.pidsDir)) {
      drainRemaining(); // the runner's last flushed bytes, incl. a partial answer
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
    // Watch mode displays runs in start order, so it starts from the OLDEST
    // live run; a one-shot follow attaches to the newest (most relevant) one.
    run = options.watch
      ? pickWatchStartRun(ws.stateDir, ws.pidsDir)
      : pickDefaultRun(ws.stateDir, ws.pidsDir);
    if (!run && !options.watch) {
      die("No runs in this workspace yet.\nUsage: codex-collab follow [id] [--watch]");
    }
  } else {
    const threadId = resolveThreadIdOrDie(ws.stateDir, positional[0]);
    scopedShortId = findShortId(ws.stateDir, threadId) ?? positional[0];
    // Live-first, like the bare path: a newer terminal record must not
    // shadow an older run that is still active on this thread.
    run = pickThreadRun(ws.stateDir, ws.pidsDir, scopedShortId, options.watch);
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
  const seen = seedSeenRuns(ws.stateDir, ws.pidsDir, run?.runId);

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
