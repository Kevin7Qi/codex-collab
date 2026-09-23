// src/commands/peers.ts — peers: the Claude Code sessions a Codex session can message
//
// Invoked by Codex from its own session (or by a person). Reads the same
// registry Claude Code's ListAgents reads, so what it lists is exactly
// who `codex-collab send` can reach. Works inside Codex's sandbox: it only
// reads.

import { resolveStateDir, resolveWorkspaceDir } from "../config";
import { describeModelChoice, listClaudeSessions, markSpawnedSessionStopped, readSpawnedSessions, resolveSession, resumableSession, runReaper, stopSpawnedSession, type ClaudeSession, type SpawnedSession } from "../claude-sessions";
import { outstandingTasksFor } from "../claude-tasks";
import { insideCodexSandbox, resumeWindowSec, sandboxHint } from "./send";
import { die, formatDuration, loadUserConfig, parseOptions } from "./shared";

function idleFor(session: ClaudeSession, now: number): string | null {
  if (session.status !== "idle" || session.statusUpdatedAt === null) return null;
  return formatDuration(Math.max(0, now - session.statusUpdatedAt));
}

/** Where a person would find the session, when the registry says: a
 *  session in the VS Code extension's panel, or in a tmux pane, is every bit
 *  as `interactive` as one in the terminal in front of them — and without
 *  this, a listed session nobody can see in any terminal looks like a ghost. */
export function whereItLives(s: Pick<ClaudeSession, "entrypoint" | "tmux">): string | null {
  if (s.tmux) return `tmux ${s.tmux}`;
  if (s.entrypoint === "claude-vscode") return "in VS Code";
  if (s.entrypoint && s.entrypoint !== "cli") return `via ${s.entrypoint}`;
  return null;
}

/** One line per session, columns aligned. Exported for tests. */
export function formatSessions(sessions: ClaudeSession[], now = Date.now()): string {
  // A row is marked only where the mark tells rows apart. From inside
  // Codex's sandbox no process can be checked, so EVERY row would carry it —
  // that case gets one line under the table instead (`unverifiedNotice`).
  const mixed = sessions.some((s) => s.verified) && sessions.some((s) => !s.verified);
  const rows = sessions.map((s) => {
    const notes: string[] = [];
    const where = whereItLives(s);
    if (where) notes.push(where);
    if (!s.verified && mixed) notes.push("unverified: its process cannot be checked from here");
    if (s.spawned) {
      notes.push("started by codex-collab");
      // What a started session runs on is fixed when it starts, so it is
      // what a Codex session needs to see before sending it harder work.
      if (s.spawned.model || s.spawned.effort) notes.push(describeModelChoice(s.spawned.model, s.spawned.effort));
      const idle = idleFor(s, now);
      if (idle) notes.push(`idle ${idle}`);
      notes.push(`stops after ${formatDuration(s.spawned.lingerSec * 1000)} idle`);
    }
    return {
      name: s.name,
      status: s.status,
      kind: s.kind === "bg" ? "background" : s.kind,
      note: notes.join(" · "),
    };
  });
  const w = (key: "name" | "status" | "kind") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const header = `  ${"NAME".padEnd(w("name"))}  ${"STATUS".padEnd(w("status"))}  ${"KIND".padEnd(w("kind"))}`.trimEnd();
  const lines = rows.map((r) =>
    `  ${r.name.padEnd(w("name"))}  ${r.status.padEnd(w("status"))}  ${r.kind.padEnd(w("kind"))}${r.note ? `  ${r.note}` : ""}`.trimEnd());
  return [header, ...lines].join("\n");
}

/** Said once, under the table, when no listed session could be checked — the
 *  normal view from inside Codex's sandbox (its own PID namespace from
 *  0.154, no `ps` before that), where the listing rests on each session's
 *  messaging socket being in place. Nothing is lost by it: `send` runs
 *  outside the sandbox and checks the process before it delivers. null when
 *  at least one session was verified (the rows say which were not). */
export function unverifiedNotice(sessions: ClaudeSession[]): string | null {
  if (sessions.length === 0 || sessions.some((s) => s.verified)) return null;
  return "Seen from inside a sandbox: these sessions' processes cannot be checked from here, so each is listed because its messaging socket is in place. `codex-collab send` checks again, outside the sandbox, before it delivers.";
}

/** `codex-collab peers stop [<name>]` — stop a session codex-collab started.
 *
 *  Codex had no way to end a session that was not going to answer, so it
 *  reached for the pid: read /proc, check the start time, SIGTERM. That is a
 *  careful version of the wrong thing — Claude Code's own supervisor takes a
 *  background session that dies that way in the middle of a turn for a
 *  crash, and brings it back as a new process. This stops it the way it was
 *  started, through `claude stop`, which keeps the conversation for the next
 *  `send`.
 *
 *  Only a session codex-collab started for this workspace: a session the user
 *  is working in is theirs to close, whatever a Codex session thinks of it. */
async function handlePeersStop(name: string | undefined, cwd: string): Promise<void> {
  // Stopping reaches Claude Code the same way `send` reaches a session, and
  // the sandbox blocks both: inside it `claude stop` cannot connect and the
  // confirming signal cannot be sent, so it would report a session stopped
  // that is still running.
  if (insideCodexSandbox()) {
    die(
      "codex-collab peers stop cannot run inside the Codex sandbox: it stops the session through Claude Code, which the sandbox blocks.\n" +
      "Rerun this command outside the sandbox (with escalated permissions).",
    );
  }
  const stateDir = resolveStateDir(cwd);
  const sessions = listClaudeSessions({ cwd, stateDir });
  let session: ClaudeSession | undefined;
  if (name) {
    const resolved = resolveSession(sessions, name);
    if (!resolved.session) {
      die(resolved.ambiguous.length > 1
        ? `"${name}" matches several sessions: ${resolved.ambiguous.map((s) => s.name).join(", ")} — name one exactly.`
        : `No live Claude Code session named "${name}" in this workspace.`);
    }
    session = resolved.session;
  } else if (sessions.length === 1) {
    session = sessions[0];
  } else {
    die(sessions.length === 0
      ? "No Claude Code session is live in this workspace."
      : `Several Claude Code sessions are live here — name one:\n${sessions.map((s) => `  codex-collab peers stop ${JSON.stringify(s.name)}`).join("\n")}`);
  }
  // Which sessions are ours is decided one way everywhere (spawnedRecordFor):
  // by session id, or by pid and start time together. The record comes with
  // the pid the session has now, which is what the confirming signal checks.
  const ours = session.spawned;
  if (!ours) {
    die(`${session.name} was not started by codex-collab, so it is not ours to stop — it is a session its user is working in. \`codex-collab peers\` marks the ones started here.`);
  }
  const waiting = outstandingTasksFor(stateDir, { pid: session.pid, sessionId: session.sessionId });
  // `claude stop` can fail quietly, and a record marked stopped while its
  // session runs makes that session read as the user's own — no reaper, no
  // watch for a prompt, and a resume offered for a conversation still live.
  // So it counts as stopped only once it is seen gone (stopSpawnedSession).
  const { gone, signalled } = await stopSpawnedSession(ours);
  if (!gone) {
    die(`${session.name} is still running: \`claude stop\` did not take, and ${signalled
      ? "the session came back after a signal"
      : "its process could not be verified as one codex-collab started, so no signal was sent"}. Its record is unchanged.${sandboxHint()}`);
  }
  markSpawnedSessionStopped(stateDir, ours.id);
  console.log(`Stopped ${session.name}. Its conversation is kept: \`codex-collab send\` picks it up where it stopped.`);
  if (waiting.length > 0) {
    console.log(`${waiting.length} task${waiting.length === 1 ? " was" : "s were"} still waiting on it (${waiting.map((t) => t.id).join(", ")}) — ${waiting.length === 1 ? "it ends" : "they end"} with no reply.`);
  }
}

export async function handlePeers(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  if (process.platform === "win32") {
    if (options.json) console.log("[]");
    else console.log("Claude Code's cross-session messaging does not exist on Windows, so there are no sessions to reach from here.");
    return;
  }
  if (positional[0] === "stop") return handlePeersStop(positional[1], options.dir);
  const cwd = options.dir;
  const stateDir = resolveStateDir(cwd);
  const sessions = listClaudeSessions({ cwd, all: options.all, stateDir });

  if (options.json) {
    console.log(JSON.stringify(sessions.map((s) => ({
      name: s.name,
      status: s.status,
      kind: s.kind,
      cwd: s.cwd,
      pid: s.pid,
      entrypoint: s.entrypoint,
      tmux: s.tmux,
      verified: s.verified,
      spawned: s.spawned ? { id: s.spawned.id, startedAt: s.spawned.startedAt, lingerSec: s.spawned.lingerSec, model: s.spawned.model ?? null, effort: s.spawned.effort ?? null } : null,
    })), null, 2));
    return;
  }

  const scope = options.all ? "on this machine" : `in this workspace (${resolveWorkspaceDir(cwd)})`;
  if (sessions.length === 0) {
    const spawn = loadUserConfig().spawn !== "off";
    console.log(`No Claude Code session is live ${scope}.`);
    if (spawn && !options.all) {
      // Whether `send` would start from nothing or pick a conversation up
      // again decides how much a Codex session needs to explain.
      const stopped = resumableSession(stateDir, resumeWindowSec(loadUserConfig()));
      if (stopped) {
        const ago = formatDuration(Math.max(1000, Date.now() - Date.parse(stopped.stoppedAt!)));
        console.log(`\`codex-collab send "…"\` resumes ${stopped.name}, stopped ${ago} ago, with its conversation so far (\`--fresh\` starts a new session instead).`);
      } else {
        console.log("`codex-collab send \"…\"` starts one in the background and messages it.");
      }
    }
    if (!options.all) console.log("`codex-collab peers --all` lists sessions in other workspaces.");
    return;
  }
  console.log(`Claude Code sessions ${scope}:`);
  console.log(formatSessions(sessions));
  console.log("");
  const notice = unverifiedNotice(sessions);
  if (notice) console.log(notice);
  console.log('Message one and wait for its reply: codex-collab send <name> "…"');
}

// ---------------------------------------------------------------------------
// reap-claude (private) — the detached reaper for a session `send` started
// ---------------------------------------------------------------------------

/** `codex-collab reap-claude <id> <pid> <lingerSec> --dir <workspace>`.
 *  Started detached by `send` right after it spawns a Claude Code session;
 *  polls the session's registry entry and stops it once it has idled for
 *  the linger. Exits on its own when the session is gone. */
export async function handleReapClaude(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const [id, pidText, lingerText] = positional;
  const pid = Number(pidText);
  const lingerSec = Number(lingerText);
  if (!id || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(lingerSec) || lingerSec <= 0) {
    console.error("Usage: codex-collab reap-claude <id> <pid> <lingerSec> [--dir <workspace>]");
    process.exit(1);
  }
  const stateDir = resolveStateDir(options.dir);
  // Only a session this workspace recorded as spawned is ours to stop: the
  // record is written before the reaper starts, so an id it does not know
  // is a hand-typed one — and the fallback signal in stopClaudeSession
  // would otherwise reach whatever idle session owns that pid.
  const known: SpawnedSession | undefined = readSpawnedSessions(stateDir).find((s) => s.id === id && s.pid === pid && !s.stoppedAt);
  if (!known) {
    console.error(`No Claude Code session with id ${id} and pid ${pid} was started by codex-collab for this workspace — nothing to reap.`);
    process.exit(1);
  }
  await runReaper({ ...known, lingerSec }, stateDir);
}
