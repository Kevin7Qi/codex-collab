// src/commands/run.ts — run command handler

import { updateThreadStatus } from "../threads";
import { runTurn } from "../turns";
import { config, loadTemplateWithMeta, interpolateTemplate, type SandboxMode } from "../config";
import { wrapBrokerBusy } from "../broker";
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
  recordTerminalRunState,
  recordRunFailure,
  progress,
  writePidFile,
  removePidFile,
  setActiveThreadId,
  setActiveShortId,
  setActiveTurnId,
  setActiveWsPaths,
  setActiveRunId,
} from "./shared";

export async function handleRun(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  applyUserConfig(options);

  if (positional.length === 0) {
    die("No prompt provided\nUsage: codex-collab run \"prompt\" [options]");
  }

  let prompt = positional.join(" ");

  if (options.template) {
    const { meta, body } = loadTemplateWithMeta(options.template);
    prompt = interpolateTemplate(body, { PROMPT: prompt });
    // Apply template's suggested sandbox if user didn't explicitly set one.
    // Mark as explicit so it's forwarded on resume too.
    if (meta.sandbox && !options.explicit.has("sandbox")) {
      const validSandboxes: readonly string[] = config.sandboxModes;
      if (!validSandboxes.includes(meta.sandbox)) {
        die(`Template "${options.template}" has invalid sandbox: ${meta.sandbox}\nValid: ${config.sandboxModes.join(", ")}`);
      }
      options.sandbox = meta.sandbox as SandboxMode;
      options.explicit.add("sandbox");
    }
  }
  const ws = getWorkspacePaths(options.dir);

  const exitCode = await withClient(async (client) => {
    await resolveDefaults(client, options);

    const { threadId, shortId, runId, effective } = await startOrResumeThread(client, options, ws, undefined, prompt);

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

    updateThreadStatus(ws.threadsFile, threadId, "running");
    setActiveThreadId(threadId);
    setActiveShortId(shortId);
    setActiveWsPaths(ws);
    setActiveRunId(runId);
    writePidFile(ws.pidsDir, shortId);

    const dispatcher = createDispatcher(shortId, ws.logsDir, options);

    try {
      const result = await runTurn(
        client,
        threadId,
        [{ type: "text", text: prompt }],
        {
          dispatcher,
          approvalHandler: getApprovalHandler(effective.approvalPolicy, ws.approvalsDir, options.dir),
          timeoutMs: options.timeout * 1000,
          killSignalsDir: ws.killSignalsDir,
          onTurnId: (id) => setActiveTurnId(id),
          ...turnOverrides(options),
        },
      );

      return recordTerminalRunState(ws, threadId, runId, result, "Turn", options.contentOnly);
    } catch (e) {
      e = wrapBrokerBusy(e);
      recordRunFailure(ws, threadId, runId, e);
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
