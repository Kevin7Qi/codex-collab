// src/commands/send.ts — send: message a Claude Code session and wait for its reply
//
// Invoked BY CODEX from its own session — the TUI, the app, an exec run —
// none of which codex-collab started. The session is named (see `peers`),
// or is the only one live in the workspace, or is started for the
// occasion. The reply prints on stdout, which lands in Codex's context;
// no reply within the deadline prints a notice and exits 0 all the same —
// from Codex's point of view the command always returns, only the advice
// differs. Non-zero exits are for genuine failures: no session to reach,
// an unreachable socket, the sandbox.
//
// How it works: this process registers itself, for the duration of the
// exchange, as a peer in Claude Code's session registry — under its own
// pid, with its own socket — delivers the message straight to the
// session's messaging socket, and receives the reply on its own. Nothing
// else has to be running. That is also why it cannot run inside Codex's
// sandbox, which blocks every unix socket: Codex reruns a command outside
// the sandbox when asked to, and the notice below says so.

import { connect, createServer, type Server } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mailboxRoot, resolveStateDir, resolveWorkspaceDir } from "../config";
import {
  buildEnvelope,
  buildRegistryEntry,
  parseEnvelope,
  procStartOf,
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
  isClaudeEffort,
  isModelName,
  listClaudeSessions,
  markSpawnedSessionStopped,
  resolveSession,
  resumableSession,
  sessionStatusNow,
  spawnClaudeSession,
  stopClaudeSession,
  transientSessionId,
  type ClaudeSession,
} from "../claude-sessions";
import { sanitizeForTerminal, verifyMailboxDir } from "../questions";
import { acquireLockAsync } from "../lock";
import { MAX_TIMEOUT_SECONDS, die, formatDuration, loadUserConfig, parseOptions, type UserConfig } from "./shared";

/** Default reply deadline (seconds) — the same order as the ask channel's. */
export const DEFAULT_SEND_TIMEOUT_SEC = 600;

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

/** The name this exchange registers under: codex(<thread>-<workspace>),
 *  the same family as the broker's front door and thread peers, so Claude
 *  can tell which Codex session is talking and from which workspace. */
export function senderName(cwd: string, threadId: string | null): string {
  const tag = threadId ? threadId.replace(/-/g, "").slice(0, 8) : `shell-${process.pid}`;
  return `codex(${tag}-${workspaceSuffix(cwd)})`;
}

/** The name IS the address: two parallel sends from one Codex thread must
 *  not register the same one, or a reply by name lands on either. When a
 *  live entry already carries `name`, this exchange takes `name` with its
 *  pid inside the parentheses. */
export function uniqueSenderName(name: string, taken: (candidate: string) => boolean = nameIsTaken): string {
  if (!taken(name)) return name;
  return name.replace(/\)$/, `-${process.pid})`);
}

function nameIsTaken(name: string): boolean {
  try {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
        if (entry?.name !== name || typeof entry?.pid !== "number" || entry.pid === process.pid) continue;
        process.kill(entry.pid, 0);
        return true;
      } catch { /* dead or unreadable — not taken */ }
    }
  } catch { /* registry gone */ }
  return false;
}

/** The text Claude receives: the message, then one line saying who sent
 *  it and whether it is waiting. */
export function composeMessage(
  text: string,
  opts: { threadId: string | null; wait: boolean; timeoutSec: number },
): string {
  const who = opts.threadId ? `Codex thread ${opts.threadId}` : "a Codex session";
  const trailer = opts.wait
    ? `(From ${who}, waiting for your reply — send it to this peer; it waits up to ${formatDuration(opts.timeoutSec * 1000)}.)`
    : `(From ${who}. It is not waiting for a reply, and a reply cannot reach it.)`;
  return `${text}\n\n${trailer}`;
}

/** Where a session's reply lands: a socket of ours under codex-collab's
 *  temp root (the ask mailbox's home). Short enough for a unix socket
 *  path wherever the home directory is, and a location every codex-collab
 *  process recognizes as ours (`isCodexCollabSocket`), so a `send` in
 *  flight is never listed as a Claude session. */
export function ownSocketPath(pid = process.pid): string {
  return join(mailboxRoot(), `send-${pid}.sock`);
}

/** Said when something fails that a sandbox would explain. Codex does not
 *  mark its sandbox the same way on every platform, so a failure under
 *  Codex gets the hint even when CODEX_SANDBOX is absent. */
function sandboxHint(): string {
  return underCodex()
    ? "\nIf Codex ran this command in its sandbox, that is the cause: the sandbox blocks local sockets and the session registry. Rerun it outside the sandbox (with escalated permissions)."
    : "";
}

/** Split Codex's arguments into target and message: `--to <name>`, or a
 *  first positional that names a live session exactly, else no target. */
export function splitTarget(
  positional: string[],
  to: string | null,
  sessions: ClaudeSession[],
): { targetName: string | null; message: string } {
  if (to) return { targetName: to, message: positional.join(" ") };
  if (positional.length >= 2 && sessions.some((s) => s.name === positional[0])) {
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
  const timeoutSec = options.explicit.has("timeout") ? options.timeout : DEFAULT_SEND_TIMEOUT_SEC;
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
  let target: ClaudeSession;
  let startedHere = false;
  const notes: string[] = [];
  if (targetName) {
    const { session, ambiguous } = resolveSession(sessions, targetName);
    if (!session) {
      const live = sessions.length ? `Live here: ${sessions.map((s) => s.name).join(", ")}` : "No Claude Code session is live in this workspace.";
      die(ambiguous.length > 1
        ? `"${targetName}" matches several sessions: ${ambiguous.map((s) => s.name).join(", ")} — name one exactly.`
        : `No live Claude Code session named "${targetName}" in this workspace. ${live}`);
    }
    target = session;
  } else if (sessions.length === 1) {
    target = sessions[0];
    notes.push(`Sending to ${target.name} — the only Claude Code session in this workspace.`);
  } else if (sessions.length > 1) {
    die(
      "Several Claude Code sessions are live in this workspace — name one:\n" +
      sessions.map((s) => `  codex-collab send ${JSON.stringify(s.name)} "…"`).join("\n"),
    );
  } else {
    const cfg = loadUserConfig();
    if (options.noSpawn || cfg.spawn === "off") {
      die("No Claude Code session is live in this workspace" + (cfg.spawn === "off" ? " (starting one is off: `codex-collab config spawn on` enables it)." : " (--no-spawn)."));
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
      if (again.length > 1) {
        die("Several Claude Code sessions are live in this workspace — name one:\n" + again.map((s) => `  codex-collab send ${JSON.stringify(s.name)} "…"`).join("\n"));
      } else if (again.length === 1) {
        target = again[0];
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
          console.log(`No Claude Code session is live in this workspace — resuming ${stopped.name}, stopped ${ago} ago, with its conversation so far…`);
          // What it ran on before holds unless Codex now says otherwise: a
          // resumed session is a new process, so a new choice can apply.
          const resumeModel = askedModel ?? stopped.model ?? model;
          const resumeEffort = askedEffort ?? stopped.effort ?? effort;
          try {
            resumed = await spawnClaudeSession({ cwd, stateDir, lingerSec, model: resumeModel, effort: resumeEffort, resume: stopped });
            notes.push(`Resumed ${resumed.name} (its conversation so far is intact; on ${describeModelChoice(resumeModel, resumeEffort)}; it stops after ${formatDuration(lingerSec * 1000)} idle).`);
          } catch (e) {
            console.log(`Could not resume it (${(e instanceof Error ? e.message : String(e)).split("\n")[0]}) — starting a new session instead.`);
            forgetSpawnedSession(stateDir, stopped.id);
          }
        } else {
          console.log("No Claude Code session is live in this workspace — starting one in the background…");
        }
        if (resumed) {
          target = resumed;
        } else {
          try {
            target = await spawnClaudeSession({ cwd, stateDir, lingerSec, model, effort });
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

  // ── Our own address for the reply ──
  mkdirSync(mailboxRoot(), { recursive: true, mode: 0o700 });
  // The root must be privately ours before a socket goes in it — the same
  // check the ask mailbox makes, for the same reason (a shared temp dir).
  try {
    verifyMailboxDir(mailboxRoot());
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  const socketPath = ownSocketPath();
  try { unlinkSync(socketPath); } catch { /* none */ }
  const threadId = codexThreadId();
  let name = senderName(cwd, threadId);
  const entryPath = join(sessionsDir(), `${process.pid}.json`);
  let server: Server | null = null;
  const cleanup = (): void => {
    try { server?.close(); } catch { /* closed */ }
    try { unlinkSync(socketPath); } catch { /* gone */ }
    try { unlinkSync(entryPath); } catch { /* gone */ }
  };
  // SIGINT/SIGTERM reach the CLI's own handlers (cli.ts), which exit — and
  // the exit hook cleans up. SIGHUP has no handler there.
  process.on("exit", cleanup);
  process.on("SIGHUP", () => { cleanup(); process.exit(129); });

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
        // The reply Codex is waiting for is the named session's. Another
        // sender's message is not an answer — it is noted, not consumed.
        if (msg.replyPath !== target.socketPath) {
          console.log(`(A message from ${msg.fromName} arrived meanwhile; still waiting for ${target.name}.)`);
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
    cleanup();
    die(`Could not open a socket for the reply at ${socketPath}: ${e instanceof Error ? e.message : String(e)}${sandboxHint()}`);
  }
  // Pick the name and register under one lock: two sends from one Codex
  // thread at once would otherwise both find the plain name free.
  let releaseRegister: (() => void) | null = null;
  let registerError: unknown = null;
  try {
    mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    releaseRegister = await acquireLockAsync(join(mailboxRoot(), "register.lock"), { maxAttempts: 200, staleThresholdMs: 10_000 });
    name = uniqueSenderName(name);
    writeFileSync(entryPath, JSON.stringify(buildRegistryEntry({
      pid: process.pid,
      cwd: wsRoot,
      name,
      socketPath,
      version: sniffRegistryVersion(),
      procStart: procStartOf(process.pid),
      sessionId: transientSessionId(),
    })));
  } catch (e) {
    registerError = e;
  } finally {
    releaseRegister?.();
  }
  if (registerError) {
    const e = registerError;
    cleanup();
    die(`Could not register with Claude Code's session registry (${sessionsDir()}): ${e instanceof Error ? e.message : String(e)}${sandboxHint()}`);
  }

  // ── Deliver ──
  const line = buildEnvelope({
    text: composeMessage(message, { threadId, wait, timeoutSec }),
    ourSocketPath: socketPath,
    ourName: name,
    mode: "prompting",
  });
  const sentAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const sock = connect({ path: target.socketPath }, () => {
        sock.write(line, (err) => {
          if (err) reject(err);
          else sock.end(resolve);
        });
      });
      sock.on("error", reject);
    });
  } catch (e) {
    cleanup();
    const detail = e instanceof Error ? e.message : String(e);
    die(`Could not reach ${target.name} (socket ${target.socketPath}): ${detail}${sandboxHint()}\nIt may have just exited — \`codex-collab peers\` shows who is live.`);
  }

  for (const note of notes) console.log(note);
  const busy = target.status === "busy" ? " It is busy — your message joins its current turn." : "";
  if (!wait) {
    console.log(`Sent to ${target.name}.${busy} Not waiting for a reply.`);
    cleanup();
    process.exit(0);
  }
  console.log(`Sent to ${target.name}.${busy} Waiting up to ${formatDuration(timeoutSec * 1000)} for its reply…`);

  // A session codex-collab started has nobody attached. If it stops at a
  // prompt no reply will ever come — and it does stop at one when it is not
  // in auto mode after all: Claude Code falls back to asking where that mode
  // is unavailable to the session, which depends on the model. Watching for
  // it turns a whole timeout of silence into an answer Codex can act on.
  const watch = target.spawned ? watchForBlocked(target.pid) : null;
  const answer = await Promise.race([
    reply,
    new Promise<null>((r) => setTimeout(r, timeoutSec * 1000)),
    ...(watch ? [watch.blocked] : []),
  ]);
  watch?.stop();
  const elapsed = formatDuration(Math.max(1000, Date.now() - sentAt));
  console.log("");
  if (answer === "blocked" && target.spawned) {
    const ranOn = describeModelChoice(target.spawned.model, target.spawned.effort);
    console.log(`NO REPLY from ${target.name}: it has stopped at a prompt (a permission request, most likely), and nobody is attached to answer it.`);
    console.log(`It was started in \`auto\` permission mode, where nothing prompts; Claude Code asks like this when that mode is not available to the session, which depends on the model. This one runs on ${ranOn}.`);
    // Left as it is it would sit at that prompt until the reaper came, and
    // swallow every message sent meanwhile. Stopped, it can be resumed.
    stopClaudeSession(target.spawned);
    markSpawnedSessionStopped(stateDir, target.spawned.id);
    console.log("It has been stopped. Send again with a model that has auto mode (`codex-collab models --claude` lists the choices; `--model sonnet` or above): the conversation resumes on it.");
  } else if (answer && answer !== "blocked") {
    console.log(`REPLY FROM ${target.name} (after ${elapsed}):`);
    // Indented so no reply line sits at column 0, the way `ask` prints answers.
    for (const l of sanitizeForTerminal(answer.text).trimEnd().split("\n")) console.log(`  ${l}`);
  } else {
    console.log(`NO REPLY from ${target.name} within ${formatDuration(timeoutSec * 1000)}. Proceed on your own judgment.`);
    console.log(sessionStatusNow(target.pid) === "waiting"
      ? "It is waiting at a prompt in its own terminal — a permission request or a question only its user can answer there."
      : "It may still be working on your message; a later reply cannot reach this command.");
    console.log("(A Claude Code session running with bypassPermissions holds peer messages for its user to approve unless its crossSessionInbound setting is accept.)");
  }
  cleanup();
  process.exit(0);
}
