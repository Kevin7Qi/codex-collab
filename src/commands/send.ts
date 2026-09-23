// src/commands/send.ts — send: hand a message to a Claude Code session, and its reply back
//
// Invoked BY CODEX from its own session — the TUI, the app, an exec run —
// none of which codex-collab started. The session is named (see `peers`),
// or is the only one live in the workspace, or is started for the
// occasion. The reply prints on stdout, which lands in Codex's context.
//
// Every message is a TASK (claude-tasks.ts), and `send` has two halves. The
// one Codex runs chooses the session, records the task, and starts the other:
// a detached receiver (`recv-task`, private) that registers, for as long as
// the task takes, as a peer in Claude Code's session registry — under its own
// pid, with its own socket — delivers the message straight to the session's
// messaging socket, and writes the reply into the task's record when it
// comes. The first half then only watches the record. Its `--timeout` bounds
// how long the COMMAND waits, and nothing else: a reply that comes later is
// kept, and `task wait` / `task result` collect it. Which is why the session
// is told no deadline — there is none for it to fit its work into.
//
// The exit code says how it went (see `exitCodeFor`): 0 replied, 3 no reply
// yet and the task goes on, 5 the session stopped at a prompt, 1 failure.
//
// Nothing else has to be running. The receiver's sockets are also why `send`
// cannot run inside Codex's sandbox, which blocks every unix socket: Codex
// reruns a command outside the sandbox when asked to, and the notice below
// says so.

import { connect, createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mailboxRoot, resolveStateDir, resolveWorkspaceDir } from "../config";
import {
  buildEnvelope,
  buildRegistryEntry,
  ownPidDomain,
  parseEnvelope,
  procIdentity,
  procStartOf,
  procStartTicksOf,
  sessionsDir,
  sniffRegistryVersion,
  workspaceSuffix,
} from "../peer";
import {
  CLAUDE_EFFORTS,
  DEFAULT_SPAWN_LINGER_SEC,
  DEFAULT_SPAWN_RESUME_SEC,
  describeModelChoice,
  forgetSpawnedSession,
  isAutocompactWindow,
  isClaudeEffort,
  isModelName,
  listClaudeSessions,
  markSpawnedSessionStopped,
  resolveSession,
  resumableSession,
  sessionStatusNow,
  spawnClaudeSession,
  spawnEnv,
  spawnedSessionName,
  stopAndConfirm,
  transientSessionId,
  type ClaudeSession,
} from "../claude-sessions";
import { describeTrouble, turnEndedOnError, turnTrouble } from "../claude-transcript";
import { FINAL_STATUSES, TASK_MAX_WAIT_SEC, createTask, isTaskId, loadTask, taskLogFile, updateTask, type TaskRecord } from "../claude-tasks";
import { sanitizeForTerminal, verifyMailboxDir } from "../questions";
import { acquireLockAsync } from "../lock";
import { DEFAULT_TASK_WAIT_SEC, dirHint, exitCodeFor, reportOutcome, showsHints, waitForTask } from "./task";
import { MAX_TIMEOUT_SECONDS, die, formatDuration, loadUserConfig, parseOptions, type UserConfig } from "./shared";

/** Codex sets CODEX_SANDBOX in every command it runs inside its sandbox,
 *  and in none it runs outside it. CODEX_SANDBOX_NETWORK_DISABLED is not
 *  that signal: Codex keeps it set on a command it runs unsandboxed
 *  (verified on 0.153.4 with an allowed command), so treating it as the
 *  sandbox would refuse the very rerun the refusal asks for. */
export function insideCodexSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SANDBOX !== undefined;
}

/** Whether Codex ran this command at all, sandboxed or not. */
export function underCodex(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODEX_SANDBOX !== undefined || env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined || env.CODEX_THREAD_ID !== undefined;
}

/** The Codex thread this command runs in, as Codex hands it to its shell. */
export function codexThreadId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.CODEX_THREAD_ID;
  return id && /^[0-9a-f-]{8,}$/i.test(id) ? id : null;
}

/** The name a task's receiver registers under, which IS the address its
 *  reply is sent to: codex(<thread>-<workspace>-<task>). The same family as
 *  the broker's front door and thread peers, so Claude can tell which Codex
 *  session is talking and from which workspace — and one address per task,
 *  so that whatever is sent to it can only be that task's. With a name a
 *  Codex thread's tasks shared, a session's second thought about a finished
 *  task would reach whichever task held the name by then, and be recorded as
 *  its reply; sent to a finished task's own address it finds nobody, and
 *  Claude is told so. */
export function senderName(cwd: string, threadId: string | null, taskId: string): string {
  const tag = threadId ? threadId.replace(/-/g, "").slice(0, 8) : "shell";
  return `codex(${tag}-${workspaceSuffix(cwd)}-${taskId})`;
}

/** The text Claude receives: the message, then one line saying who sent it
 *  and where the reply goes. It names no deadline. The reply is kept whenever
 *  it comes, so there is none on Claude's side — and a number here, however
 *  generous, is a budget a careful model cuts its work to fit. */
export function composeMessage(text: string, opts: { threadId: string | null }): string {
  const who = opts.threadId ? `Codex thread ${opts.threadId}` : "a Codex session";
  return `${text}\n\n(From ${who}. Reply to this peer when you are done; your reply is kept for it.)`;
}

/** Where a task's reply lands: a socket of its receiver's under
 *  codex-collab's temp root (the ask mailbox's home). Short enough for a unix
 *  socket path wherever the home directory is, and a location every
 *  codex-collab process recognizes as ours (`isCodexCollabSocket`), so a
 *  task in flight is never listed as a Claude session. */
export function taskSocketPath(id: string): string {
  return join(mailboxRoot(), `task-${id}.sock`);
}

/** Said when something fails that a sandbox would explain. Codex does not
 *  mark its sandbox the same way on every platform, so a failure under
 *  Codex gets the hint even when CODEX_SANDBOX is absent. */
export function sandboxHint(): string {
  return underCodex()
    ? "\nIf Codex ran this command in its sandbox, that is the cause: the sandbox blocks local sockets and the session registry. Rerun it outside the sandbox (with escalated permissions)."
    : "";
}

/** Split Codex's arguments into target and message: `--to <name>`; else,
 *  with two or more, the first is the target, live or not. A name that is
 *  not live stays a name: folded into the message, it would send that
 *  message to whichever other session is live — the user's own, perhaps. A
 *  single argument is the message, unless it is exactly a live session's
 *  name. */
export function splitTarget(
  positional: string[],
  to: string | null,
  sessions: ClaudeSession[],
): { targetName: string | null; message: string } {
  if (to) return { targetName: to, message: positional.join(" ") };
  if (positional.length >= 2) {
    return { targetName: positional[0], message: positional.slice(1).join(" ") };
  }
  if (positional.length === 1 && sessions.some((s) => s.name === positional[0])) {
    // A name and no message: almost certainly a forgotten argument, not a
    // message that happens to be the session's name.
    return { targetName: positional[0], message: "" };
  }
  return { targetName: null, message: positional.join(" ") };
}

/** Watch a started session for the one state it cannot leave by itself:
 *  `waiting`, at a prompt, with nobody attached. Resolves "blocked" once the
 *  registry has said so on several looks in a row (a prompt a hook or the
 *  classifier answers is gone again within a moment). */
export function watchForBlocked(pid: number, opts: { pollMs?: number; looks?: number } = {}): { blocked: Promise<"blocked">; stop(): void } {
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_BLOCKED_POLL_MS) || 2000);
  const looks = opts.looks ?? 5;
  let timer: ReturnType<typeof setInterval> | null = null;
  const blocked = new Promise<"blocked">((resolve) => {
    let seen = 0;
    timer = setInterval(() => {
      seen = sessionStatusNow(pid) === "waiting" ? seen + 1 : 0;
      if (seen >= looks) resolve("blocked");
    }, pollMs);
  });
  return { blocked, stop() { if (timer) clearInterval(timer); } };
}

/** How long after it was stopped a started session is still resumed:
 *  `config spawn-resume` in seconds, `off` for never, else the default. */
export function resumeWindowSec(cfg: UserConfig): number {
  const v = cfg["spawn-resume"];
  if (v === undefined) return DEFAULT_SPAWN_RESUME_SEC;
  if (v === "off") return 0;
  const n = Number(v);
  if (Number.isInteger(n) && n > 0 && n <= MAX_TIMEOUT_SECONDS) return n;
  console.error(`[codex] Warning: ignoring invalid spawn-resume in config: ${v}`);
  return DEFAULT_SPAWN_RESUME_SEC;
}

/** What to tell Codex when it chose a model or effort for a session that
 *  was already running: the choice is made at start and cannot change after.
 *  null when what it asked for is what the session runs on anyway. */
export function choiceNotAppliedNote(target: ClaudeSession, askedModel?: string, askedEffort?: string): string | null {
  if (!target.spawned) {
    return `${target.name} is the user's own session and runs on what they chose: --model and --effort apply only to a session \`send\` starts, so yours did not apply.`;
  }
  const { model, effort } = target.spawned;
  if ((askedModel === undefined || askedModel === model) && (askedEffort === undefined || askedEffort === effort)) return null;
  return `${target.name} is already running on ${describeModelChoice(model, effort)}: --model and --effort apply only when \`send\` starts a session, so yours did not apply.`;
}

export async function handleSend(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const cwd = options.dir;
  const wsRoot = resolveWorkspaceDir(cwd);
  const stateDir = resolveStateDir(cwd);
  const timeoutSec = options.explicit.has("timeout") ? options.timeout : DEFAULT_TASK_WAIT_SEC;
  const wait = !options.noWait;

  if (process.platform === "win32") {
    die("codex-collab send is unavailable on Windows: Claude Code's cross-session messaging, which it rides on, does not exist there.");
  }
  if (insideCodexSandbox()) {
    die(
      "codex-collab send cannot run inside the Codex sandbox: it reaches the Claude Code session over a local socket, which the sandbox blocks.\n" +
      "Rerun this command outside the sandbox (with escalated permissions). `codex-collab peers` works inside it.\n" +
      "(The user can let Codex run `send` without asking: `codex-collab config codex-rule on`.)",
    );
  }

  // What a session started here should run on, if Codex says: `-m` and
  // `-r`/`--effort`, the same flags `run` takes for Codex's models. Only
  // explicit flags count — the configured `model`/`reasoning` are Codex's.
  const askedModel = options.explicit.has("model") && options.model ? options.model : undefined;
  const askedEffort = options.explicit.has("reasoning") ? String(options.reasoning) : undefined;
  if (askedEffort !== undefined && !isClaudeEffort(askedEffort)) {
    die(`Invalid effort for a Claude Code session: ${askedEffort}\nValid: ${CLAUDE_EFFORTS.join(", ")} (\`codex-collab models --claude\` lists the models)`);
  }

  const sessions = listClaudeSessions({ cwd, stateDir });
  const { targetName, message: rawMessage } = splitTarget(positional, options.to, sessions);
  let message = rawMessage;
  if (message === "-") {
    if (process.stdin.isTTY) console.error("[codex] Reading message from stdin — end with Ctrl-D.");
    message = readFileSync(0, "utf-8");
  }
  message = sanitizeForTerminal(message).trim();
  if (!message) {
    die('No message provided\nUsage: codex-collab send [<peer>] "message" [--to <peer>] [--timeout <sec>] [--no-wait] [--model <model>] [--effort <level>] [--fresh]');
  }

  // ── Whom to send to ──
  let target!: ClaudeSession;
  let startedHere = false;
  const notes: string[] = [];
  // The session codex-collab starts for this workspace always has this name,
  // resumed or new: named when it is not live, it is started again.
  const startedName = spawnedSessionName(cwd);
  let start: "any" | "named" | null = null;
  if (targetName) {
    const { session, ambiguous } = resolveSession(sessions, targetName);
    if (session) {
      target = session;
    } else if (ambiguous.length > 1) {
      die(`"${targetName}" matches several sessions: ${ambiguous.map((s) => s.name).join(", ")} — name one exactly.`);
    } else if (targetName === startedName) {
      start = "named";
    } else {
      const live = sessions.length ? `Live here: ${sessions.map((s) => s.name).join(", ")}` : "No Claude Code session is live in this workspace.";
      die(`No live Claude Code session named "${targetName}" in this workspace. ${live}`);
    }
  } else if (sessions.length === 1) {
    target = sessions[0];
    notes.push(`Sending to ${target.name} — the only Claude Code session in this workspace.`);
  } else if (sessions.length > 1) {
    die(
      "Several Claude Code sessions are live in this workspace — name one:\n" +
      sessions.map((s) => `  codex-collab send ${JSON.stringify(s.name)} "…"`).join("\n"),
    );
  } else {
    start = "any";
  }
  if (start) {
    const cfg = loadUserConfig();
    const notLive = start === "named" ? `${startedName} is not live` : "No Claude Code session is live in this workspace";
    if (options.noSpawn || cfg.spawn === "off") {
      die(notLive + (cfg.spawn === "off" ? " (starting one is off: `codex-collab config spawn on` enables it)." : " (--no-spawn)."));
    }
    let lingerSec = DEFAULT_SPAWN_LINGER_SEC;
    if (cfg.linger !== undefined) {
      if (typeof cfg.linger === "number" && Number.isInteger(cfg.linger) && cfg.linger > 0 && cfg.linger <= MAX_TIMEOUT_SECONDS) {
        lingerSec = cfg.linger;
      } else {
        console.error(`[codex] Warning: ignoring invalid linger in config: ${cfg.linger}`);
      }
    }
    // Flag, then the user's configured default, then nothing — which leaves
    // the session on the user's Claude Code default.
    let model = askedModel;
    if (model === undefined && cfg["spawn-model"] !== undefined) {
      if (isModelName(cfg["spawn-model"])) model = cfg["spawn-model"];
      else console.error(`[codex] Warning: ignoring invalid spawn-model in config: ${cfg["spawn-model"]}`);
    }
    let effort = askedEffort;
    if (effort === undefined && cfg["spawn-effort"] !== undefined) {
      if (isClaudeEffort(cfg["spawn-effort"])) effort = cfg["spawn-effort"];
      else console.error(`[codex] Warning: ignoring invalid spawn-effort in config: ${cfg["spawn-effort"]}`);
    }
    let autocompact: string | undefined;
    if (cfg["spawn-autocompact"] !== undefined) {
      if (isAutocompactWindow(cfg["spawn-autocompact"])) autocompact = cfg["spawn-autocompact"];
      else console.error(`[codex] Warning: ignoring invalid spawn-autocompact in config: ${cfg["spawn-autocompact"]}`);
    }
    // One spawn per workspace at a time: two sends racing here would each
    // start a session under the same name. The second waits, then finds the
    // first's session live and uses it.
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      die(`Could not create ${stateDir}: ${e instanceof Error ? e.message : String(e)}${sandboxHint()}`);
    }
    let release: () => void;
    try {
      release = await acquireLockAsync(join(stateDir, "spawn.lock"), { maxAttempts: 2000, staleThresholdMs: 120_000 });
    } catch {
      die("Another `codex-collab send` is still starting a Claude Code session for this workspace — retry in a moment.");
    }
    try {
      const again = listClaudeSessions({ cwd, stateDir });
      const startedMeanwhile = start === "named" ? again.find((s) => s.name === startedName) : again.length === 1 ? again[0] : undefined;
      if (start === "any" && again.length > 1) {
        die("Several Claude Code sessions are live in this workspace — name one:\n" + again.map((s) => `  codex-collab send ${JSON.stringify(s.name)} "…"`).join("\n"));
      } else if (startedMeanwhile) {
        target = startedMeanwhile;
        notes.push(`Sending to ${target.name} — a background Claude Code session started for this workspace just now.`);
      } else {
        // A session stopped for idling still has its conversation: pick it
        // up again rather than explain everything to a new one. `--fresh`,
        // or a resume that fails (the conversation was removed, or has aged
        // out of Claude Code's own history), starts a new session instead.
        const stopped = options.fresh ? null : resumableSession(stateDir, resumeWindowSec(cfg));
        let resumed: ClaudeSession | null = null;
        if (stopped) {
          const ago = formatDuration(Math.max(1000, Date.now() - Date.parse(stopped.stoppedAt!)));
          console.log(`${notLive} — resuming ${stopped.name}, stopped ${ago} ago, with its conversation so far…`);
          // A resumed session is a new process, and runs on what is chosen
          // now, as a new one would: the flags, else the configured defaults.
          // What it ran on before was chosen for the work it had then.
          try {
            resumed = await spawnClaudeSession({ cwd, stateDir, lingerSec, model, effort, autocompact, resume: stopped });
            notes.push(`Resumed ${resumed.name} (its conversation so far is intact; on ${describeModelChoice(model, effort)}; it stops after ${formatDuration(lingerSec * 1000)} idle).`);
          } catch (e) {
            console.log(`Could not resume it (${(e instanceof Error ? e.message : String(e)).split("\n")[0]}) — starting a new session instead.`);
            forgetSpawnedSession(stateDir, stopped.id);
          }
        } else {
          console.log(`${notLive} — starting one in the background…`);
        }
        if (resumed) {
          target = resumed;
        } else {
          try {
            target = await spawnClaudeSession({ cwd, stateDir, lingerSec, model, effort, autocompact });
          } catch (e) {
            die((e instanceof Error ? e.message : String(e)) + sandboxHint());
          }
          notes.push(`Started ${target.name} (a background Claude Code session on ${describeModelChoice(model, effort)}; it stops after ${formatDuration(lingerSec * 1000)} idle).`);
        }
        startedHere = true;
      }
    } finally {
      release();
    }
  }

  // A model or effort Codex chose applies only to a session started just
  // now. Where it could not apply, say so: Codex should know what it is
  // actually talking to before it weighs the reply.
  if (!startedHere && (askedModel !== undefined || askedEffort !== undefined)) {
    const note = choiceNotAppliedNote(target, askedModel, askedEffort);
    if (note) notes.push(note);
  }

  // ── Record the task, and hand it to a receiver of its own ──
  const threadId = codexThreadId();
  let task: TaskRecord;
  try {
    task = createTask(stateDir, {
      cwd: wsRoot,
      threadId,
      message,
      target: { name: target.name, pid: target.pid, socketPath: target.socketPath, sessionId: target.sessionId, procStart: target.procStart, spawned: target.spawned },
      // A caller willing to wait longer than a task is normally waited on
      // must not see it expire under them.
      maxWaitSec: Math.max(TASK_MAX_WAIT_SEC, timeoutSec),
    });
  } catch (e) {
    die(`Could not record the task under ${stateDir}: ${e instanceof Error ? e.message : String(e)}${sandboxHint()}`);
  }
  const delivered = await startReceiver(task, stateDir, cwd);

  for (const note of notes) console.log(note);
  const hint = dirHint(options);
  const busy = target.status === "busy" ? " It is busy — your message joins its current turn." : "";
  if (!wait) {
    console.log(`Sent to ${target.name} as task ${task.id}.${busy} Not waiting; its reply is kept.`);
    if (showsHints()) {
      console.log(`  codex-collab task wait ${task.id}${hint}     waits for it`);
      console.log(`  codex-collab task result ${task.id}${hint}   prints it once it is there`);
    }
    process.exit(0);
  }
  console.log(`Sent to ${target.name} as task ${task.id}.${busy} Waiting up to ${formatDuration(timeoutSec * 1000)} for its reply…`);

  const started = Date.now();
  const outcome = FINAL_STATUSES.has(delivered.status) ? delivered : await waitForTask(stateDir, task.id, timeoutSec * 1000);
  if (!outcome) die(`Task ${task.id} was removed while it was being waited on.`);
  console.log("");
  reportOutcome(outcome, { waitedMs: Date.now() - started, hint });
  process.exit(exitCodeFor(outcome.status));
}

// ---------------------------------------------------------------------------
// The receiver — the half of `send` that outlives the command
// ---------------------------------------------------------------------------

/** How long `send` waits for a receiver to deliver. It covers a runtime
 *  start, a `ps`, two locks and one local connect. */
const RECEIVER_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Start `task`'s receiver, detached, and return once it has delivered the
 *  message (the record has left `pending`) — or die with the reason it could
 *  not. The handshake is the record itself, as `run --detach` uses the run
 *  ledger: what `send` reports as sent has been sent. */
async function startReceiver(task: TaskRecord, stateDir: string, cwd: string): Promise<TaskRecord> {
  const logPath = taskLogFile(stateDir, task.id);
  const logFd = openSync(logPath, "a", 0o600);
  // Its own process group and no terminal: the task must outlive this
  // command, a Ctrl-C in the invoking shell, and the Codex turn that ran it.
  // Codex's markers are dropped, as for the reaper — it is nobody's command.
  const child = spawn(process.execPath, ["run", process.argv[1], "recv-task", task.id, "--dir", cwd], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: spawnEnv(),
  });
  closeSync(logFd);
  let childGone = false;
  let spawnError: Error | null = null;
  child.once("exit", () => { childGone = true; });
  child.once("error", (e) => { spawnError = e; childGone = true; });
  child.unref();

  /** The receiver is gone and the record still says `pending`: nobody else
   *  will ever write it, so this command may — the record has one writer at
   *  a time, and that writer has just left. */
  const giveUp: (reason: string) => never = (reason) => {
    updateTask(stateDir, task.id, { status: "failed", error: reason, finishedAt: new Date().toISOString() });
    let tail = "";
    try { tail = readFileSync(logPath, "utf-8").trim().split("\n").slice(-10).join("\n"); } catch { /* none */ }
    die(`${reason}${sandboxHint()}${tail ? `\nReceiver output (${logPath}):\n${tail}` : ""}`);
  };
  /** What the record says once it has left `pending`: delivered (returned),
   *  or the receiver's own account of why not (fatal). */
  const verdict = (now: TaskRecord | null): TaskRecord | null => {
    if (!now || now.status === "pending") return null;
    // Delivered is delivered, whatever became of the receiver afterwards:
    // "could not deliver" here would have Codex send the message again.
    if (now.status === "failed" && !now.deliveredAt) die(`${now.error ?? "The message could not be delivered."}${sandboxHint()}`);
    return now;
  };

  const deadline = Date.now() + RECEIVER_HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const now = verdict(loadTask(stateDir, task.id));
    if (now) return now;
    if (spawnError) giveUp(`Could not start the process that collects the reply: ${(spawnError as Error).message}`);
    if (childGone) {
      // It may have delivered, been answered and left since that look.
      const last = verdict(loadTask(stateDir, task.id));
      if (last) return last;
      giveUp("The process that collects the reply exited before it delivered the message.");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Reporting failure while the receiver lives would let it deliver after
  // Codex was told the message never went: stop it, and see it gone, before
  // anything is said — it may be delivering at this very moment, and then
  // the record says so.
  if (!childGone && child.pid) {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ }
    const until = Date.now() + 5000;
    while (!childGone && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    if (!childGone) { try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  const last = verdict(loadTask(stateDir, task.id));
  if (last) return last;
  giveUp(`The message was not delivered within ${RECEIVER_HANDSHAKE_TIMEOUT_MS / 1000}s.`);
}

/** Remove what a receiver that was killed outright left behind: its entry in
 *  Claude Code's registry and its socket. Every other way out of a receiver
 *  removes both; SIGKILL, an out-of-memory kill or a power cut runs no code,
 *  and a receiver now lives for hours. Two witnesses are asked before
 *  anything is removed — the process is gone, AND nothing answers at the
 *  socket — because from inside a pid namespace of its own every host process
 *  looks gone, while a connection that a sandbox refuses is not "nobody
 *  there". Returns how many were removed. */
export async function sweepDeadReceivers(): Promise<number> {
  let files: string[];
  try {
    files = readdirSync(sessionsDir());
  } catch {
    return 0;
  }
  const ours = join(mailboxRoot(), "task-");
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const path = join(sessionsDir(), file);
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const socket = entry?.messagingSocketPath;
    if (typeof socket !== "string" || !socket.startsWith(ours) || entry.pid === process.pid) continue;
    if (procIdentity(entry) !== "dead") continue;
    const nobodyThere = await new Promise<boolean>((resolve) => {
      const sock = connect({ path: socket }, () => { sock.destroy(); resolve(false); });
      sock.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" || e.code === "ENOENT"));
      sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    });
    if (!nobodyThere) continue;
    try { unlinkSync(socket); } catch { /* gone */ }
    try { unlinkSync(path); removed++; } catch { /* gone */ }
  }
  return removed;
}

/** Write one envelope to a session's messaging socket. */
function deliver(socketPath: string, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = connect({ path: socketPath }, () => {
      sock.write(line, (err) => {
        if (err) reject(err);
        else sock.end(resolve);
      });
    });
    sock.on("error", reject);
  });
}

/** Watch for a turn that ended on an error without replying: the session's
 *  transcript names an API error since `since`, and the session has settled
 *  into doing nothing (`idle`, or gone from the registry's view of work) for
 *  a full minute of looks in a row. Claude Code retries some errors itself,
 *  and a person watching the session can tell it to try again: a turn that
 *  comes back to life within the minute is never reported as dead.
 *
 *  Both halves are narrow on purpose. `turnEndedOnError` asks whether the last
 *  thing said in that conversation is the error, so a session that hit one and
 *  carried on is not caught. And only `idle` counts as settled: `waiting` is a
 *  session stopped at a prompt, where a person is about to act, and an entry
 *  that cannot be read says nothing at all. */
export function watchForStalledTurn(
  target: TaskRecord["target"],
  since: string,
  opts: { pollMs?: number; looks?: number } = {},
): { stalled: Promise<"stalled">; stop(): void } {
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_STALL_POLL_MS) || 3000);
  const looks = opts.looks ?? 20;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stalled = new Promise<"stalled">((resolve) => {
    let seen = 0;
    timer = setInterval(() => {
      const settled = sessionStatusNow(target.pid) === "idle";
      seen = settled && turnEndedOnError(target.sessionId, since) ? seen + 1 : 0;
      if (seen >= looks) resolve("stalled");
    }, pollMs);
  });
  return { stalled, stop() { if (timer) clearInterval(timer); } };
}

/** Watch for the session a task waits on going away: its registry entry
 *  gone, or now another session's, or its process dead. Resolves "lost" once
 *  that has held for several looks in a row — Claude Code rewrites entries
 *  while it runs, and one unreadable moment is no evidence. */
export function watchForLost(target: TaskRecord["target"], opts: { pollMs?: number; looks?: number } = {}): { lost: Promise<"lost">; stop(): void } {
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_LOST_POLL_MS) || 2000);
  const looks = opts.looks ?? 3;
  const file = join(sessionsDir(), `${target.pid}.json`);
  const gone = (): boolean => {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      return true;
    }
    if (!entry || entry.pid !== target.pid) return true;
    if (target.sessionId && entry.sessionId !== target.sessionId) return true;
    if (target.procStart && entry.procStart !== target.procStart) return true;
    return procIdentity(entry) === "dead";
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  const lost = new Promise<"lost">((resolve) => {
    let seen = 0;
    timer = setInterval(() => {
      seen = gone() ? seen + 1 : 0;
      if (seen >= looks) resolve("lost");
    }, pollMs);
  });
  return { lost, stop() { if (timer) clearInterval(timer); } };
}

/** `codex-collab recv-task <id> --dir <workspace>` (private). Started
 *  detached by `send`: delivers the task's message from an address of its
 *  own, then listens there until the session replies, is found stopped at a
 *  prompt, goes away, or the task's longest wait is over — and writes which
 *  into the task's record. What it prints goes to the task's log. */
export async function handleRecvTask(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const stateDir = resolveStateDir(options.dir);
  const id = positional[0];
  const task = isTaskId(id) ? loadTask(stateDir, id) : null;
  // Only a task `send` has just recorded is a receiver's to take: a second
  // one for the same task would deliver the message twice.
  if (!task || task.status !== "pending" || task.receiver) {
    console.error(`No pending task ${id ?? ""} in this workspace — nothing to receive.`);
    process.exit(1);
  }
  const { target } = task;
  const socketPath = taskSocketPath(task.id);
  const entryPath = join(sessionsDir(), `${process.pid}.json`);
  let server: Server | null = null;
  let finished = false;
  const release = (): void => {
    try { server?.close(); } catch { /* closed */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    try { unlinkSync(entryPath); } catch { /* gone */ }
  };
  /** The address goes first and the verdict last: whoever reads a final
   *  status finds no registration of this task left behind. */
  const finish: (patch: Partial<TaskRecord>, code?: number) => never = (patch, code = 0) => {
    release();
    finished = true;
    // A log with nothing in it explains nothing.
    try { if (statSync(taskLogFile(stateDir, task.id)).size === 0) unlinkSync(taskLogFile(stateDir, task.id)); } catch { /* none */ }
    updateTask(stateDir, task.id, { ...patch, finishedAt: new Date().toISOString() });
    process.exit(code);
  };
  // SIGINT/SIGTERM reach the CLI's own handlers (cli.ts), which exit — and
  // the exit hook says what happened. SIGHUP has no handler there.
  process.on("exit", () => {
    if (finished) return;
    release();
    try { updateTask(stateDir, task.id, { status: "failed", error: "the process collecting the reply was stopped before a reply came", finishedAt: new Date().toISOString() }); } catch { /* state dir gone */ }
  });
  process.on("SIGHUP", () => process.exit(129));

  // Who is collecting, before anything can go wrong: a reader tells a
  // receiver that died from one still at work by this.
  let ownStart: string | null = procStartTicksOf(process.pid);
  if (ownStart === null) { try { ownStart = procStartOf(process.pid); } catch { /* ps unavailable */ } }
  updateTask(stateDir, task.id, { receiver: { pid: process.pid, procStart: ownStart, pidDomain: ownPidDomain() } });

  // ── Our own address for the reply ──
  // The root must be privately ours before a socket goes in it — the same
  // check the ask mailbox makes, for the same reason (a shared temp dir).
  try {
    mkdirSync(mailboxRoot(), { recursive: true, mode: 0o700 });
    verifyMailboxDir(mailboxRoot());
  } catch (e) {
    finish({ status: "failed", error: e instanceof Error ? e.message : String(e) }, 1);
  }
  try { unlinkSync(socketPath); } catch { /* none */ }
  // Tidy up after receivers that never got the chance to: never a reason
  // for this task to fail.
  try { await sweepDeadReceivers(); } catch { /* leave them */ }

  let resolveReply!: (reply: { text: string; fromName: string }) => void;
  const reply = new Promise<{ text: string; fromName: string }>((resolve) => { resolveReply = resolve; });
  server = createServer((sock) => {
    sock.setEncoding("utf8");
    let buffer = "";
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { sock.destroy(); return; }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = parseEnvelope(line);
        if (!msg) continue;
        // The reply the task waits for is the named session's. Another
        // sender's message is not an answer — it is noted, not consumed.
        if (msg.replyPath !== target.socketPath) {
          console.log(`A message from ${msg.fromName} arrived; still waiting for ${target.name}.`);
          continue;
        }
        resolveReply({ text: msg.text, fromName: msg.fromName });
      }
    });
    sock.on("error", () => { /* a dropped connection is not a reply */ });
  });
  try {
    const listening = server;
    // Bind with group/other bits masked: the socket is connectable the
    // moment it exists, before any chmod could run (as the broker does).
    const prevUmask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        listening.once("listening", resolve);
        listening.once("error", reject);
        listening.listen(socketPath);
      });
    } finally {
      process.umask(prevUmask);
    }
  } catch (e) {
    finish({ status: "failed", error: `Could not open a socket for the reply at ${socketPath}: ${e instanceof Error ? e.message : String(e)}` }, 1);
  }
  const name = senderName(task.cwd, task.threadId, task.id);
  let registerError: unknown = null;
  try {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(entryPath, JSON.stringify(buildRegistryEntry({
      pid: process.pid,
      cwd: task.cwd,
      name,
      socketPath,
      version: sniffRegistryVersion(),
      procStart: procStartOf(process.pid),
      sessionId: transientSessionId(),
    })));
  } catch (e) {
    registerError = e;
  }
  if (registerError) {
    const e = registerError;
    finish({ status: "failed", error: `Could not register with Claude Code's session registry (${sessionsDir()}): ${e instanceof Error ? e.message : String(e)}` }, 1);
  }

  // ── Deliver ──
  try {
    await deliver(target.socketPath, buildEnvelope({
      text: composeMessage(task.message, { threadId: task.threadId }),
      ourSocketPath: socketPath,
      ourName: name,
      mode: "prompting",
    }));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    finish({ status: "failed", error: `Could not reach ${target.name} (socket ${target.socketPath}): ${detail}\nIt may have just exited — \`codex-collab peers\` shows who is live.` }, 1);
  }
  const deliveredAt = new Date().toISOString();
  updateTask(stateDir, task.id, { status: "running", deliveredAt, senderName: name });

  // ── Listen ──
  // A session codex-collab started has nobody attached. If it stops at a
  // prompt no reply will ever come — and it does stop at one when it is not
  // in auto mode after all: Claude Code falls back to asking where that mode
  // is unavailable to the session, which depends on the model. Watching for
  // it turns hours of silence into an answer Codex can act on.
  const blockedWatch = target.spawned ? watchForBlocked(target.pid) : null;
  const lostWatch = watchForLost(target);
  const remaining = Math.max(0, Date.parse(task.expiresAt) - Date.now());
  const expiry = new Promise<"expired">((r) => setTimeout(() => r("expired"), Number.isFinite(remaining) ? remaining : TASK_MAX_WAIT_SEC * 1000));
  const done: (patch: Partial<TaskRecord>) => never = (patch) => {
    blockedWatch?.stop();
    lostWatch.stop();
    finish(patch);
  };

  let noted = false;
  for (;;) {
    const stall = noted ? null : watchForStalledTurn(target, deliveredAt);
    const answer = await Promise.race([
      reply,
      expiry,
      lostWatch.lost,
      ...(stall ? [stall.stalled] : []),
      ...(blockedWatch ? [blockedWatch.blocked] : []),
    ]);
    stall?.stop();

    if (answer === "stalled") {
      // Its turn ended on an error without replying. Saying so is the whole
      // job: whether to ask it to carry on, hand the work to someone else or
      // drop it is the Codex session's to decide, and a message sent from
      // here would be one it never asked for, in a conversation it cannot see.
      const t = turnTrouble(target.sessionId, deliveredAt);
      const reason = `${target.name} ended its turn without replying${t ? `: ${describeTrouble(t)}` : ""}`;
      // A session codex-collab started has nobody to set it going again, so
      // that is the end of the task. A session the user is working in has
      // them: the task keeps its address, and its reply, and what happened is
      // recorded for whoever reads the task next.
      if (target.spawned) done({ status: "failed", error: reason });
      updateTask(stateDir, task.id, { error: reason });
      noted = true;
      continue;
    }
    if (answer === "blocked") {
      // Left as it is it would sit at that prompt until the reaper came, and
      // swallow every message sent meanwhile. Stopped, it can be resumed. Two
      // tasks may find the same session blocked: stopping and marking it are
      // both safe to do twice.
      if (target.spawned) {
        await stopAndConfirm(target.spawned);
        markSpawnedSessionStopped(stateDir, target.spawned.id);
      }
      done({ status: "blocked" });
    }
    if (answer === "lost" || answer === "expired") {
      // Why, while the transcript is still at hand: the record outlives the
      // session, and "no reply" says nothing a Codex session can act on.
      const failure = turnTrouble(target.sessionId, deliveredAt);
      done({ status: answer, ...(failure ? { error: describeTrouble(failure) } : {}) });
    }
    // A stall noted earlier belongs to a turn that then finished: leaving it
    // on the record would tell the next reader this task's turn had died.
    done({ status: "replied", reply: answer, error: undefined });
  }
}
