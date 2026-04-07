// src/commands/run.ts — run command handler

import { config } from "../config";
import { updateThreadStatus } from "../threads";
import { runTurn } from "../turns";
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
} from "./shared";

export async function handleRun(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  applyUserConfig(options);

  if (positional.length === 0) {
    die("No prompt provided\nUsage: codex-collab run \"prompt\" [options]");
  }

  const prompt = positional.join(" ");

  const exitCode = await withClient(async (client) => {
    await resolveDefaults(client, options);

    const { threadId, shortId, effective } = await startOrResumeThread(client, options, undefined, prompt);

    if (options.contentOnly) {
      console.error(`[codex] Running (thread ${shortId})...`);
    } else {
      if (options.resumeId) {
        progress(`Resumed thread ${shortId} (${effective.model})`);
      } else {
        progress(`Thread ${shortId} started (${effective.model}, ${options.sandbox})`);
      }
      progress("Turn started");
    }

    updateThreadStatus(config.threadsFile, threadId, "running");
    setActiveThreadId(threadId);
    setActiveShortId(shortId);
    writePidFile(shortId);

    const dispatcher = createDispatcher(shortId, options);

    try {
      const result = await runTurn(
        client,
        threadId,
        [{ type: "text", text: prompt }],
        {
          dispatcher,
          approvalHandler: getApprovalHandler(effective.approvalPolicy),
          timeoutMs: options.timeout * 1000,
          ...turnOverrides(options),
        },
      );

      updateThreadStatus(config.threadsFile, threadId, result.status as "completed" | "failed" | "interrupted");
      return printResult(result, shortId, "Turn", options.contentOnly);
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
