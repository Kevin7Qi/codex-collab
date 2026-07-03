// src/commands/run.ts — run command handler

import { spawn as childSpawn, spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync } from "fs";
import { join } from "path";
import { updateThreadStatus, generateRunId, loadRun, updateRun } from "../threads";
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
  consumeInjectedRunId,
} from "./shared";

/** How long the detach parent waits for the child's turn to start.
 *  Covers a cold broker spawn + app-server handshake + model/list fetch. */
const DETACH_HANDSHAKE_TIMEOUT_MS = 60_000;


/** Terminate a detached runner and everything it spawned. `detached: true`
 *  gave the child its own process group (pgid = pid), so a group signal
 *  reaches its direct-connection app-server too; the shared broker lives in
 *  a separate group and is untouched. The child's SIGTERM handler interrupts
 *  an in-flight turn and records the run cancelled. Exported for tests. */
export function killDetachedRunner(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch { /* already gone */ }
}

/** Remove the --detach flag (both `--detach` and `--detach=x` spellings —
 *  the latter would make the child re-enter detachRun forever) from the args
 *  re-executed by the detached child. Tokens after a `--` terminator are
 *  prompt text and survive verbatim. Exported for tests. */
export function stripDetachFlag(args: string[]): string[] {
  const out: string[] = [];
  let terminated = false;
  for (const arg of args) {
    if (arg === "--") terminated = true;
    if (!terminated && (arg === "--detach" || arg.startsWith("--detach="))) continue;
    out.push(arg);
  }
  return out;
}

/**
 * Hand the turn to a detached runner and return once it's actually running.
 *
 * The child is this same CLI re-executed without `--detach`, in its own
 * process group (a Ctrl-C in the invoking shell must not kill the turn),
 * with stdout/stderr captured to a per-run file for post-mortems. The
 * handshake is the run ledger: the parent pre-generates the runId, passes it
 * via CODEX_COLLAB_RUN_ID, and waits for the record to advance past phase
 * "starting" — the child bumps the phase when turn/start responds, so
 * success here means "turn is running", not merely "thread was created".
 */
async function detachRun(args: string[], options: ReturnType<typeof parseOptions>["options"]): Promise<never> {
  const ws = getWorkspacePaths(options.dir);
  const runId = generateRunId();
  const childArgs = stripDetachFlag(args);

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

  const logTail = (): string => {
    try {
      return readFileSync(detachLog, "utf-8").trim().split("\n").slice(-15).join("\n");
    } catch {
      return "";
    }
  };
  const dieWithRunnerOutput: (reason: string) => never = (reason) => {
    const tail = logTail();
    die(`${reason}${tail ? `\nRunner output (${detachLog}):\n${tail}` : `\nNo runner output captured (${detachLog}).`}`);
  };

  const deadline = Date.now() + DETACH_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rec = loadRun(ws.stateDir, runId);
    if (rec) {
      // Record exists = thread/start succeeded. Now wait for the turn:
      // the child bumps phase past "starting" when turn/start responds.
      if (rec.status === "running" && rec.phase !== "starting") {
        progress(`Detached: thread ${rec.shortId} running${rec.model ? ` (${rec.model})` : ""}`);
        progress(`  Follow:   codex-collab follow ${rec.shortId}`);
        progress(`  Output:   codex-collab output ${rec.shortId}`);
        progress(`  Kill:     codex-collab kill ${rec.shortId}`);
        process.exit(0);
      }
      if (rec.status === "completed") {
        // Turn finished before we even noticed it start — report done.
        progress(`Detached run already completed: thread ${rec.shortId}`);
        progress(`  Output:   codex-collab output ${rec.shortId}`);
        process.exit(0);
      }
      if (rec.status === "cancelled") {
        dieWithRunnerOutput(`Detached run was interrupted before the turn started (thread ${rec.shortId}).`);
      }
      // A `failed` record is only definitive once the child has exited: the
      // broker-busy fallback records a transient failure, reconnects
      // directly, and re-creates this same record — while the child lives,
      // keep waiting (the 60s deadline + kill below is the backstop).
      // Reporting failure early would either orphan a runner that later
      // executes the turn, or require killing a legitimately-retrying one.
      if (childExited && rec.status === "failed") {
        dieWithRunnerOutput(`Detached run failed to start${rec.error ? `: ${rec.error}` : "."}`);
      }
      if (childExited && rec.status === "running" && rec.phase === "starting") {
        // Child died between creating the record and turn/start — the record
        // will sit in "starting" forever.
        dieWithRunnerOutput(`Detached runner died before the turn started (thread ${rec.shortId}).`);
      }
    } else if (childExited) {
      // A child that died before creating the record will never hand-shake —
      // fail fast with its captured output instead of waiting out the timeout.
      dieWithRunnerOutput("Detached runner exited before the turn started.");
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Reporting failure while leaving the runner alive would let the turn
  // execute (and modify the workspace) after the user was told it failed.
  // A slow-but-healthy runner is indistinguishable from a stuck one here,
  // so terminate it — its SIGTERM handler records the run as cancelled.
  if (!childExited && proc.pid) killDetachedRunner(proc.pid);
  dieWithRunnerOutput(`Detached runner did not start a turn within ${DETACH_HANDSHAKE_TIMEOUT_MS / 1000}s — terminated it.`);
}

export async function handleRun(args: string[]): Promise<void> {
  // Scrub the detach parent's injected runId out of the environment before
  // anything can spawn (broker, app-server, Codex's shell commands all
  // inherit it otherwise — and a nested codex-collab inside the turn would
  // collide with this run's record). The value stays available internally.
  consumeInjectedRunId();

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
          onTurnId: (id) => {
            setActiveTurnId(id);
            // Advance past "starting" — the detach parent's signal that the
            // turn is actually running (turn/start responded), and useful
            // state for `threads`/`follow` regardless of detach.
            try {
              updateRun(ws.stateDir, runId, { phase: "running" });
            } catch (e) {
              console.error(`[codex] Warning: could not update run phase: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
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
