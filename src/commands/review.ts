// src/commands/review.ts — review command handler

import { updateThreadStatus, updateRun } from "../threads";
import { runReview } from "../turns";
import { getDefaultBranch } from "../git";
import type { ReviewTarget } from "../types";
import {
  die,
  parseOptions,
  applyUserConfig,
  withClient,
  resolveDefaults,
  startOrResumeThread,
  createDispatcher,
  getApprovalHandler,
  getWorkspacePaths,
  turnOverrides,
  printResult,
  progress,
  formatDuration,
  writePidFile,
  removePidFile,
  setActiveThreadId,
  setActiveShortId,
  setActiveTurnId,
  setActiveWsPaths,
  setActiveRunId,
  VALID_REVIEW_MODES,
  type Options,
} from "./shared";

function resolveReviewTarget(positional: string[], opts: Options, cwd: string): ReviewTarget {
  const mode = opts.reviewMode ?? "pr";

  if (positional.length > 0) {
    if (opts.reviewMode !== null && opts.reviewMode !== "custom") {
      die(`--mode ${opts.reviewMode} does not accept positional arguments.\nUse --mode custom "instructions" for custom reviews.`);
    }
    return { type: "custom", instructions: positional.join(" ") };
  }

  if (mode === "custom") {
    die('Custom review mode requires instructions.\nUsage: codex-collab review "instructions"');
  }

  switch (mode) {
    case "pr": {
      // Use dynamically detected default branch unless --base was explicitly provided
      const base = opts.explicit.has("base") ? opts.base : getDefaultBranch(cwd);
      return { type: "baseBranch", branch: base };
    }
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "commit":
      return { type: "commit", sha: opts.reviewRef ?? "HEAD" };
    default:
      die(`Unknown review mode: ${mode}. Use: ${VALID_REVIEW_MODES.join(", ")}`);
  }
}

export async function handleReview(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  applyUserConfig(options);

  const target = resolveReviewTarget(positional, options, options.dir);
  const ws = getWorkspacePaths(options.dir);

  const exitCode = await withClient(async (client) => {
    await resolveDefaults(client, options);

    let reviewPreview: string;
    switch (target.type) {
      case "custom": reviewPreview = target.instructions; break;
      case "baseBranch": reviewPreview = `Review PR (base: ${target.branch})`; break;
      case "uncommittedChanges": reviewPreview = "Review uncommitted changes"; break;
      case "commit": reviewPreview = `Review commit ${target.sha}`; break;
    }
    const { threadId, shortId, runId, effective } = await startOrResumeThread(
      client, options, ws, { sandbox: "read-only" }, reviewPreview, true,
    );

    if (options.contentOnly) {
      console.error(`[codex] Reviewing (thread ${shortId})...`);
    } else {
      if (options.resumeId) {
        progress(`Resumed thread ${shortId} for review`);
      } else {
        progress(`Thread ${shortId} started for review (${effective.model}, read-only)`);
      }
    }

    updateThreadStatus(ws.threadsFile, threadId, "running");
    setActiveThreadId(threadId);
    setActiveShortId(shortId);
    setActiveWsPaths(ws);
    setActiveRunId(runId);
    writePidFile(ws.pidsDir, shortId);

    const dispatcher = createDispatcher(shortId, ws.logsDir, options);

    // Note: effort (reasoning level) is not forwarded to reviews — the review/start
    // protocol does not accept an effort parameter (unlike turn/start).
    try {
      const result = await runReview(client, threadId, target, {
        dispatcher,
        approvalHandler: getApprovalHandler(effective.approvalPolicy, ws.approvalsDir),
        timeoutMs: options.timeout * 1000,
        killSignalsDir: ws.killSignalsDir,
        onTurnId: (id) => setActiveTurnId(id),
        ...turnOverrides(options),
      });

      updateThreadStatus(ws.threadsFile, threadId, result.status as "completed" | "failed" | "interrupted");
      updateRun(ws.stateDir, runId, {
        status: result.status === "completed" ? "completed" : result.status === "interrupted" ? "cancelled" : "failed",
        phase: "finalizing",
        completedAt: new Date().toISOString(),
        elapsed: formatDuration(result.durationMs),
        output: result.output || null,
        filesChanged: result.filesChanged,
        commandsRun: result.commandsRun,
        error: result.error ?? null,
      });
      return printResult(result, "Review", options.contentOnly);
    } catch (e) {
      updateThreadStatus(ws.threadsFile, threadId, "failed");
      updateRun(ws.stateDir, runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      setActiveThreadId(undefined);
      setActiveShortId(undefined);
      setActiveTurnId(undefined);
      setActiveWsPaths(undefined);
      setActiveRunId(undefined);
      removePidFile(ws.pidsDir, shortId);
    }
  }, options.dir, true);

  process.exit(exitCode);
}
