// src/commands/peers.ts — peers: the Claude Code sessions a Codex session can message
//
// Invoked by Codex from its own session (or by a person). Reads the same
// registry Claude Code's ListAgents reads, so what it lists is exactly
// who `codex-collab send` can reach. Works inside Codex's sandbox: it only
// reads.

import { resolveStateDir, resolveWorkspaceDir } from "../config";
import { describeModelChoice, listClaudeSessions, readSpawnedSessions, runReaper, type ClaudeSession, type SpawnedSession } from "../claude-sessions";
import { formatDuration, loadUserConfig, parseOptions } from "./shared";

function idleFor(session: ClaudeSession, now: number): string | null {
  if (session.status !== "idle" || session.statusUpdatedAt === null) return null;
  return formatDuration(Math.max(0, now - session.statusUpdatedAt));
}

/** One line per session, columns aligned. Exported for tests. */
export function formatSessions(sessions: ClaudeSession[], now = Date.now()): string {
  // A row is marked only where the mark tells rows apart. From inside
  // Codex's sandbox no process can be checked, so EVERY row would carry it —
  // that case gets one line under the table instead (`unverifiedNotice`).
  const mixed = sessions.some((s) => s.verified) && sessions.some((s) => !s.verified);
  const rows = sessions.map((s) => {
    const notes: string[] = [];
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

export async function handlePeers(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  if (process.platform === "win32") {
    if (options.json) console.log("[]");
    else console.log("Claude Code's cross-session messaging does not exist on Windows, so there are no sessions to reach from here.");
    return;
  }
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
      console.log("`codex-collab send \"…\"` starts one in the background and messages it.");
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
  const known: SpawnedSession | undefined = readSpawnedSessions(stateDir).find((s) => s.id === id && s.pid === pid);
  if (!known) {
    console.error(`No Claude Code session with id ${id} and pid ${pid} was started by codex-collab for this workspace — nothing to reap.`);
    process.exit(1);
  }
  await runReaper({ ...known, lingerSec }, stateDir);
}
