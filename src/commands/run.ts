// src/commands/run.ts — run command handler

import { spawn as childSpawn } from "node:child_process";
import { openSync, closeSync, readFileSync } from "fs";
import { join } from "path";
import { updateThreadStatus, generateRunId, loadRun } from "../threads";
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

/** How long the detach parent waits for the child's run record to appear.
 *  Covers a cold broker spawn + app-server handshake + model/list fetch. */
const DETACH_HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * Hand the turn to a detached runner and return once it's actually running.
 *
 * The child is this same CLI re-executed without `--detach`, in its own
 * process group (a Ctrl-C in the invoking shell must not kill the turn),
 * with stdout/stderr captured to a per-run file for post-mortems. The
 * handshake is the run ledger itself: the parent pre-generates the runId,
 * passes it via CODEX_COLLAB_RUN_ID, and waits for the child's createRun —
 * which happens only after thread/start succeeded, so "record exists" means
 * "turn is running", not merely "child started".
 */
async function detachRun(args: string[], options: ReturnType<typeof parseOptions>["options"]): Promise<never> {
  const ws = getWorkspacePaths(options.dir);
  const runId = generateRunId();

  // Strip --detach (only before a `--` terminator — after it, the token is
  // prompt text and must survive verbatim).
  const childArgs: string[] = [];
  let terminated = false;
  for (const arg of args) {
    if (arg === "--") terminated = true;
    if (!terminated && arg === "--detach") continue;
    childArgs.push(arg);
  }

  const detachLog = join(ws.logsDir, `detached-${runId}.log`);
  const logFd = openSync(detachLog, "a");
  const proc = childSpawn(process.execPath, ["run", process.argv[1], "run", ...childArgs], {
    stdio: ["ignore", logFd, logFd],
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    env: { ...process.env, CODEX_COLLAB_RUN_ID: runId },
  });
  closeSync(logFd);
  proc.unref();

  let childExited = false;
  proc.once("exit", () => { childExited = true; });

  const deadline = Date.now() + DETACH_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rec = loadRun(ws.stateDir, runId);
    if (rec) {
      progress(`Detached: thread ${rec.shortId} running${rec.model ? ` (${rec.model})` : ""}`);
      progress(`  Follow:   codex-collab follow ${rec.shortId}`);
      progress(`  Output:   codex-collab output ${rec.shortId}`);
      progress(`  Kill:     codex-collab kill ${rec.shortId}`);
      process.exit(0);
    }
    // A child that died before creating the record will never hand-shake —
    // fail fast with its captured output instead of waiting out the timeout.
    if (childExited) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  let tail = "";
  try {
    tail = readFileSync(detachLog, "utf-8").trim().split("\n").slice(-15).join("\n");
  } catch { /* no output captured */ }
  die(
    `Detached runner ${childExited ? "exited before the turn started" : `did not start a turn within ${DETACH_HANDSHAKE_TIMEOUT_MS / 1000}s`}.` +
    (tail ? `\nRunner output (${detachLog}):\n${tail}` : `\nNo runner output captured (${detachLog}).`),
  );
}

export async function handleRun(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  applyUserConfig(options);

  if (positional.length === 0) {
    die("No prompt provided\nUsage: codex-collab run \"prompt\" [options]");
  }

  if (options.detach) {
    await detachRun(args, options);
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
          approvalHandler: getApprovalHandler(effective.approvalPolicy, ws.approvalsDir, {
            workspaceDir: options.dir,
            dispatcher,
            stateDir: ws.stateDir,
            runId,
          }),
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
