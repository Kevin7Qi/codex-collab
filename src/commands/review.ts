// src/commands/review.ts — review command handler

import { join } from "path";
import { runReview } from "../turns";
import { updateThreadStatus, runLogRelPath } from "../threads";
import { getDefaultBranch } from "../git";
import type { ReviewTarget } from "../types";
import { wrapBrokerBusy } from "../broker";
import {
  die,
  parseOptions,
  applyUserConfig,
  withClient,
  resolveDefaults,
  startOrResumeThread,
  createDispatcher,
  armQuestionChannel,
  getApprovalHandler,
  getWorkspacePaths,
  recordTerminalRunState,
  recordRunFailure,
  hasPendingApproval,
  tagExitCode,
  EXIT_CODES,
  progress,
  writePidFile,
  removePidFile,
  setActiveThreadId,
  setActiveReviewThreadId,
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
        progress(`Forked thread ${shortId} for read-only review`);
      } else {
        const effort = effective.reasoningEffort ? `, ${effective.reasoningEffort}` : "";
        progress(`Thread ${shortId} started for review (${effective.model}${effort}, read-only)`);
      }
    }

    updateThreadStatus(ws.stateDir, threadId, "running");
    setActiveThreadId(threadId);
    setActiveShortId(shortId);
    setActiveWsPaths(ws);
    setActiveRunId(runId);
    writePidFile(ws.pidsDir, shortId);

    // No guardianDir: review threads are ephemeral (never persisted
    // server-side), so a Guardian denial here could not be overridden later —
    // thread/resume on the dead thread would fail. Denials still show in the
    // progress stream and log.
    const dispatcher = createDispatcher(join(ws.stateDir, runLogRelPath(shortId, runId)), options);
    // Reviews arm the ask channel too: `review --resume` on a thread that
    // was taught the channel leaves the instructions in Codex's history, so
    // a mid-review ask must surface instead of silently stalling.
    armQuestionChannel(dispatcher, ws, runId, options.dir);

    // Note: model/cwd/approval/sandbox already reached the server via the
    // thread start/fork params in startOrResumeThread; review/start itself
    // only accepts {threadId, target, delivery}, so there are no per-turn
    // overrides to spread here (runReview would discard them).
    try {
      const result = await runReview(client, threadId, target, {
        dispatcher,
        approvalHandler: getApprovalHandler(effective.approvalPolicy, ws.approvalsDir, {
          workspaceDir: options.dir,
          dispatcher,
          stateDir: ws.stateDir,
          runId,
        }),
        timeoutMs: options.timeout * 1000,
        killSignalsDir: ws.killSignalsDir,
        onTurnId: (id) => setActiveTurnId(id),
        onReviewThreadId: (id) => setActiveReviewThreadId(id),
      });

      return recordTerminalRunState(ws, threadId, runId, result, "Review", options.contentOnly);
    } catch (e) {
      e = wrapBrokerBusy(e);
      // Same snapshot-before-clear as handleRun: a review that died with an
      // approval still pending exits approval-pending, not generic failure.
      if (hasPendingApproval(ws.stateDir, runId)) {
        tagExitCode(e, EXIT_CODES.approvalPending);
      }
      recordRunFailure(ws, threadId, runId, e);
      throw e;
    } finally {
      // Same disposal contract as handleRun — see armQuestionChannel.
      dispatcher.setQuestionContext(null);
      setActiveThreadId(undefined);
      setActiveReviewThreadId(undefined);
      setActiveShortId(undefined);
      setActiveTurnId(undefined);
      setActiveWsPaths(undefined);
      setActiveRunId(undefined);
      removePidFile(ws.pidsDir, shortId);
    }
  }, options.dir, true);

  process.exit(exitCode);
}
