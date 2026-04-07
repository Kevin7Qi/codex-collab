// src/commands/review.ts — review command handler

import { config } from "../config";
import { updateThreadStatus } from "../threads";
import { runReview } from "../turns";
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
  turnOverrides,
  printResult,
  progress,
  writePidFile,
  removePidFile,
  setActiveThreadId,
  setActiveShortId,
  VALID_REVIEW_MODES,
  type Options,
} from "./shared";

function resolveReviewTarget(positional: string[], opts: Options): ReviewTarget {
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
    case "pr":
      return { type: "baseBranch", branch: opts.base };
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

  const target = resolveReviewTarget(positional, options);

  const exitCode = await withClient(async (client) => {
    await resolveDefaults(client, options);

    let reviewPreview: string;
    switch (target.type) {
      case "custom": reviewPreview = target.instructions; break;
      case "baseBranch": reviewPreview = `Review PR (base: ${target.branch})`; break;
      case "uncommittedChanges": reviewPreview = "Review uncommitted changes"; break;
      case "commit": reviewPreview = `Review commit ${target.sha}`; break;
    }
    const { threadId, shortId, effective } = await startOrResumeThread(
      client, options, { sandbox: "read-only" }, reviewPreview,
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

    updateThreadStatus(config.threadsFile, threadId, "running");
    setActiveThreadId(threadId);
    setActiveShortId(shortId);
    writePidFile(shortId);

    const dispatcher = createDispatcher(shortId, options);

    // Note: effort (reasoning level) is not forwarded to reviews — the review/start
    // protocol does not accept an effort parameter (unlike turn/start).
    try {
      const result = await runReview(client, threadId, target, {
        dispatcher,
        approvalHandler: getApprovalHandler(effective.approvalPolicy),
        timeoutMs: options.timeout * 1000,
        ...turnOverrides(options),
      });

      updateThreadStatus(config.threadsFile, threadId, result.status as "completed" | "failed" | "interrupted");
      return printResult(result, shortId, "Review", options.contentOnly);
    } catch (e) {
      updateThreadStatus(config.threadsFile, threadId, "failed");
      throw e;
    } finally {
      setActiveThreadId(undefined);
      setActiveShortId(undefined);
      removePidFile(shortId);
    }
  });

  process.exit(exitCode);
}
