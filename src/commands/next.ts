// src/commands/next.ts — next command handler (the attention primitive)
//
// Blocks until the first attention-worthy event in the workspace — a pending
// ask-channel question or a pending interactive approval — prints ONE JSON
// event line, and exits. Replaces the POSIX `until`-loop the skill used to
// document for approvals with a single command that behaves identically on
// macOS, Linux, and Windows, and self-terminates when the workspace goes
// idle so a watcher armed alongside a run never dangles after the run ends.
//
// Exit codes: 0 = event delivered · 10 = workspace idle (nothing running,
// nothing pending) · 3 = --timeout elapsed with no event.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { resolveMailboxDir } from "../config";
import { listPendingQuestions, questionSummary, QUESTION_POLL_INTERVAL_MS } from "../questions";
import { listRuns } from "../threads";
import { getWorkspacePaths, parseOptions, readPidFile } from "./shared";
import type { RunRecord } from "../types";

export const NEXT_EXIT_CODES = {
  event: 0,
  timeout: 3,
  idle: 10,
} as const;

/** Grace window before an idle exit when no run has been observed yet —
 *  covers the race where `next` is armed in the same breath as the run it
 *  watches, before that run has created its ledger record. */
const LAUNCH_GRACE_MS = 30_000;

export interface PendingApprovalFile {
  id: string;
  kind: string | null;
  summary: string | null;
}

/** The approval `next` should fire on, if any: one whose raising run is
 *  alive and still blocked on it. Exported for tests. */
export function findLiveApproval(
  approvals: PendingApprovalFile[],
  aliveRuns: RunRecord[],
): PendingApprovalFile | undefined {
  return approvals.find((a) => aliveRuns.some((r) => r.pendingApproval?.id === a.id));
}

/** Pending approvals = request `.json` files with no `.decision` sibling.
 *  Same on-disk contract InteractiveApprovalHandler maintains. Exported for
 *  tests. */
export function listPendingApprovals(approvalsDir: string): PendingApprovalFile[] {
  if (!existsSync(approvalsDir)) return [];
  const pending: PendingApprovalFile[] = [];
  for (const file of readdirSync(approvalsDir)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    if (existsSync(join(approvalsDir, `${id}.decision`))) continue;
    let kind: string | null = null;
    let summary: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(join(approvalsDir, file), "utf-8"));
      if (parsed && typeof parsed === "object") {
        kind = typeof parsed.type === "string" ? parsed.type : null;
        summary = typeof parsed.command === "string" ? parsed.command
          : typeof parsed.reason === "string" ? parsed.reason : null;
      }
    } catch { /* corrupt request file — still report its existence */ }
    pending.push({ id, kind, summary });
  }
  return pending;
}

/** Exported for tests. */
export function isRunAlive(run: RunRecord, pidsDir: string): boolean {
  if (typeof run.pid === "number" && run.pid > 0) {
    return pidAlive(run.pid);
  }
  // Legacy records without a pid: only a live PID file counts. The
  // thread-level check treats a MISSING file as alive (conservative for
  // display), but a watcher must not dangle forever on a stale record from
  // a crash or an older version — every live run writes a PID file.
  const filePid = readPidFile(pidsDir, run.shortId);
  return filePid !== null && pidAlive(filePid);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function emit(event: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(event));
  process.exit(code);
}

export async function handleNext(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const mailboxDir = resolveMailboxDir(options.dir);
  // No --timeout means wait until an event or idle — the idle exit is the
  // self-cleaning path, so an unbounded wait cannot dangle forever.
  const timeoutMs = options.explicit.has("timeout") ? options.timeout * 1000 : Infinity;
  const startedAt = Date.now();
  let sawActiveRun = false;

  while (true) {
    const question = listPendingQuestions(mailboxDir)[0];
    if (question) {
      emit({
        type: "question",
        id: question.id,
        summary: questionSummary(question.question),
        askedAt: question.askedAt,
        expiresAt: question.expiresAt,
        workspaceDir: question.workspaceDir,
        answerWith: `codex-collab answer ${question.id} "<text>"`,
      }, NEXT_EXIT_CODES.event);
    }

    const aliveRuns = listRuns(ws.stateDir).filter(
      (r) => r.status === "running" && isRunAlive(r, ws.pidsDir),
    );

    // An approval is only answerable while the run that raised it is alive
    // and still blocked on it — its poller lives inside the run process, so
    // a request file left behind by a killed run would otherwise make every
    // later `next` fire instantly with a dead event.
    const approval = findLiveApproval(listPendingApprovals(ws.approvalsDir), aliveRuns);
    if (approval) {
      emit({
        type: "approval",
        id: approval.id,
        kind: approval.kind,
        summary: approval.summary,
        answerWith: `codex-collab approve ${approval.id} (or decline)`,
      }, NEXT_EXIT_CODES.event);
    }

    if (aliveRuns.length > 0) {
      sawActiveRun = true;
    } else if (sawActiveRun || Date.now() - startedAt > LAUNCH_GRACE_MS) {
      emit({ type: "idle" }, NEXT_EXIT_CODES.idle);
    }

    if (Date.now() - startedAt >= timeoutMs) {
      emit({ type: "timeout" }, NEXT_EXIT_CODES.timeout);
    }
    await new Promise((r) => setTimeout(r, QUESTION_POLL_INTERVAL_MS));
  }
}
