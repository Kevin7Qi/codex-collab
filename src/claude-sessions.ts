// src/claude-sessions.ts — the Claude Code sessions a Codex session can reach
//
// Codex's side of peer messaging. A Codex session (the TUI, the app, an
// exec run — none of them started by codex-collab) runs `codex-collab peers`
// to see which Claude Code sessions are working in its workspace, and
// `codex-collab send` to message one and wait for its reply. Both read the
// same session registry Claude Code's own ListAgents reads
// (~/.claude/sessions/<pid>.json) — nothing here is a second source of
// truth about who is live.
//
// When no session is live, `send` can start one: `claude --bg` creates a
// real background Claude Code session that binds a messaging socket,
// finishes its first task, and then stays idle and reachable. Such a
// session is recorded here so `peers` can say codex-collab started it, and a
// small detached reaper stops it once it has been idle for the linger —
// nothing else of ours has to be running for that to happen.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkspaceDir } from "./config";
import { isCodexCollabSocket, procIdentity, sessionsDir, workspaceSuffix, type ProcProbes } from "./peer";
import { acquireLockSync } from "./lock";

/** A live Claude Code session as the registry describes it. */
export interface ClaudeSession {
  pid: number;
  name: string;
  /** `idle` or `busy` as the session last reported; `unknown` for entries
   *  that carry no status. */
  status: "idle" | "busy" | "unknown";
  /** Registry kind: interactive, bg, daemon… Background sessions
   *  (`claude --bg`) report `bg`. */
  kind: string;
  cwd: string;
  socketPath: string;
  sessionId: string | null;
  /** The start time the session registered with, verbatim — clock ticks on
   *  Linux, `ps -o lstart=` elsewhere. Its identity, with the pid. */
  procStart: string | null;
  /** False when the process could not be checked from here (another pid
   *  domain, or a sandbox that forbids the check) and the session is listed
   *  on the evidence of its messaging socket alone. */
  verified: boolean;
  /** When the status last changed (ms since epoch), or null. */
  statusUpdatedAt: number | null;
  /** Set when codex-collab started this session for a Codex `send`. */
  spawned: SpawnedSession | null;
}

/** A background session codex-collab started, as recorded per workspace. */
export interface SpawnedSession {
  /** The short id `claude --bg` printed; what `claude stop`/`rm` take. */
  id: string;
  pid: number;
  name: string;
  startedAt: string;
  /** Seconds of idleness after which the reaper stops it. */
  lingerSec: number;
  /** The session's identity when it registered: a later entry under the
   *  same pid that differs is another process, never ours to stop. */
  procStart?: string;
  sessionId?: string | null;
}

/** Default idle linger for a spawned session (seconds). Claude Code stops
 *  an unattached background session itself after about an hour; this is
 *  the shorter bound we enforce for sessions nobody asked for by name. */
export const DEFAULT_SPAWN_LINGER_SEC = 30 * 60;

/** A started session is stopped after this long whatever it is doing: a
 *  session that reports busy forever would otherwise keep itself, and its
 *  reaper, alive indefinitely. */
export const SPAWN_MAX_LIFETIME_SEC = 4 * 3600;

/** Registry entries older Claude Codes wrote carry no `kind`; treat any
 *  session that binds a socket as reachable regardless. */
function readEntry(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** How a process is probed. A seam for tests: Codex's sandbox forbids `ps`
 *  and hides the host's pids, neither of which a test can reproduce. */
let probes: ProcProbes = {};
export function setProcStartReaderForTests(fn: ((pid: number) => string) | null): void {
  probes = fn ? { ...probes, lstartOf: fn } : {};
}
export function setProcProbesForTests(p: ProcProbes | null): void {
  probes = p ?? {};
}

/** How far an entry can be trusted: `verified` — the process it names is
 *  alive AND is the one that registered (a recycled pid fails the start-time
 *  check, see `procIdentity`); `socket` — the process cannot be checked from
 *  here, and a messaging socket still in place is the evidence; `dead`.
 *
 *  Inside Codex's sandbox the process check is unavailable: up to 0.153.4
 *  `ps` and `kill -0` both fail with EPERM, and from 0.154 the sandbox is
 *  its own PID namespace, where every host pid answers ESRCH — which made
 *  every session look dead to a sandboxed `peers`. A socket still in place
 *  is the best evidence left — Claude Code removes it when the session
 *  exits. It is evidence enough to LIST a session and to try delivering to
 *  it; it is never enough to signal its pid. `send` runs outside the
 *  sandbox and gets the full check before it delivers. */
function entryLiveness(entry: Record<string, unknown>): "verified" | "socket" | "dead" {
  const identity = procIdentity(entry, probes);
  if (identity === "live") return "verified";
  if (identity === "dead") return "dead";
  const socket = entry.messagingSocketPath;
  return typeof socket === "string" && existsSync(socket) ? "socket" : "dead";
}

/** Live Claude Code sessions that bind a messaging socket. By default only
 *  those working in `cwd`'s workspace (same git root, so a session at the
 *  repo root and a Codex run in a subdirectory see each other); `all`
 *  lists every workspace. codex-collab's own registrations — brokers,
 *  thread peers, a `send` in flight — are never Claude sessions and are
 *  left out. */
export function listClaudeSessions(opts: { cwd: string; all?: boolean; stateDir?: string; name?: string }): ClaudeSession[] {
  const dir = sessionsDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const ours = opts.all ? null : resolveWorkspaceDir(opts.cwd);
  const spawned = opts.stateDir ? readSpawnedSessions(opts.stateDir) : [];
  const sessions: ClaudeSession[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const pid = Number(file.slice(0, -".json".length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const entry = readEntry(join(dir, file));
    if (!entry || entry.pid !== pid) continue;
    // Cheap filters before the liveness check, which shells out to ps.
    if (opts.name !== undefined && entry.name !== opts.name) continue;
    const socketPath = entry.messagingSocketPath;
    if (typeof socketPath !== "string" || socketPath.length === 0) continue;
    if (isCodexCollabSocket(socketPath)) continue;
    const cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    if (ours !== null) {
      // A cwd that no longer exists cannot be in this workspace.
      if (!cwd || !existsSync(cwd)) continue;
      if (resolveWorkspaceDir(cwd) !== ours) continue;
    }
    const liveness = entryLiveness(entry);
    if (liveness === "dead") continue;
    const status = entry.status === "idle" || entry.status === "busy" ? entry.status : "unknown";
    sessions.push({
      pid,
      name: typeof entry.name === "string" && entry.name ? entry.name : `claude (pid ${pid})`,
      status,
      kind: typeof entry.kind === "string" ? entry.kind : "interactive",
      cwd,
      socketPath,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
      procStart: typeof entry.procStart === "string" ? entry.procStart : null,
      verified: liveness === "verified",
      statusUpdatedAt: typeof entry.statusUpdatedAt === "number" ? entry.statusUpdatedAt : null,
      spawned: spawned.find((s) => s.pid === pid) ?? null,
    });
  }
  // Interactive sessions first, then by name: the one the user is looking
  // at is the likelier counterpart, and a stable order keeps the listing
  // and any prefix resolution predictable.
  sessions.sort((a, b) => Number(a.kind === "bg") - Number(b.kind === "bg") || a.name.localeCompare(b.name));
  return sessions;
}

/** Resolve a session by the name Codex gave: exact match first, then a
 *  unique case-insensitive prefix. `ambiguous` lists the candidates when
 *  a prefix matches several. */
export function resolveSession(
  sessions: ClaudeSession[],
  name: string,
): { session: ClaudeSession | null; ambiguous: ClaudeSession[] } {
  const exact = sessions.find((s) => s.name === name);
  if (exact) return { session: exact, ambiguous: [] };
  const needle = name.toLowerCase();
  const matches = sessions.filter((s) => s.name.toLowerCase().startsWith(needle));
  if (matches.length === 1) return { session: matches[0], ambiguous: [] };
  return { session: null, ambiguous: matches };
}

// ─── Spawned-session records ────────────────────────────────────────────────

export function spawnedSessionsFile(stateDir: string): string {
  return join(stateDir, "spawned-claude.json");
}

export function readSpawnedSessions(stateDir: string): SpawnedSession[] {
  try {
    const parsed = JSON.parse(readFileSync(spawnedSessionsFile(stateDir), "utf-8"));
    return Array.isArray(parsed)
      ? parsed.filter((s): s is SpawnedSession =>
          s && typeof s === "object" && typeof s.id === "string" && typeof s.pid === "number" && typeof s.name === "string")
      : [];
  } catch {
    return [];
  }
}

function writeSpawnedSessions(stateDir: string, sessions: SpawnedSession[]): void {
  const file = spawnedSessionsFile(stateDir);
  if (sessions.length === 0) {
    // Never create the state dir just to record nothing: a reaper outliving
    // its workspace's state must not bring it back.
    try { unlinkSync(file); } catch { /* absent */ }
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(sessions, null, 2) + "\n");
  // rename is atomic on POSIX; a reader never sees a half-written list.
  renameSync(tmp, file);
}

/** Read-modify-write under a lock: a `send` recording a fresh session
 *  while a reaper forgets an old one must not lose either write — a lost
 *  record leaves a session no reaper will ever stop. */
function withRecordsLock<T>(stateDir: string, fn: () => T): T {
  const release = acquireLockSync(join(stateDir, "spawned-claude.lock"), { maxAttempts: 200, staleThresholdMs: 10_000 });
  try {
    return fn();
  } finally {
    release();
  }
}

export function recordSpawnedSession(stateDir: string, session: SpawnedSession): void {
  mkdirSync(stateDir, { recursive: true });
  withRecordsLock(stateDir, () => {
    const rest = readSpawnedSessions(stateDir).filter((s) => s.pid !== session.pid && s.id !== session.id);
    writeSpawnedSessions(stateDir, [...rest, session]);
  });
}

export function forgetSpawnedSession(stateDir: string, id: string): void {
  // Nothing recorded, nothing to forget — and never create the state dir
  // (not even for the lock) on behalf of a workspace that has none.
  if (!existsSync(spawnedSessionsFile(stateDir))) return;
  withRecordsLock(stateDir, () => {
    writeSpawnedSessions(stateDir, readSpawnedSessions(stateDir).filter((s) => s.id !== id));
  });
}

// ─── Starting a session ─────────────────────────────────────────────────────

/** The name a session codex-collab starts for this workspace registers
 *  under: claude(<workspace>-<hash6>), the mirror of the broker's
 *  codex(<workspace>-<hash6>) front door. */
export function spawnedSessionName(cwd: string): string {
  // Same derivation as the broker's front door (peerNameFor): the readable
  // half names the workspace ROOT, and the hash is never truncated.
  const dir = basename(resolveWorkspaceDir(cwd))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = workspaceSuffix(cwd);
  const room = 40 - "claude()".length - suffix.length - 1;
  return `claude(${(dir || "workspace").slice(0, room)}-${suffix})`;
}

/** The first task a spawned session runs: what it is, who will write to
 *  it, and how to answer. It goes idle afterwards and receives messages
 *  as its later turns. Mechanics only — what to answer, and how much to
 *  look into before answering, is the session's own judgment. */
export function spawnedSessionBrief(wsRoot: string): string {
  return [
    `You are a Claude Code session started by codex-collab for the Codex sessions working in ${wsRoot}.`,
    "Codex sessions message you through codex-collab; each message says which Codex thread it comes from and whether that session is waiting for a reply.",
    "Answer by replying to the sender with SendMessage — the reply is what the Codex session receives.",
    "Read the workspace as needed. Do not change files unless a message asks you to.",
    // Whatever Claude Code's settings decide about where a background
    // session's edits land, the Codex session only knows what the reply says.
    "When you do change files, say in your reply where the changes are: the path, the branch, and the commit if you made one.",
    "You will be stopped after a while with no messages. Reply now with one line saying you are ready, then wait.",
  ].join(" ");
}

/** Variables that mark a process as a child of a Claude session. A `claude`
 *  started with them inherits the parent's identity and binds no socket of
 *  its own. Only these are dropped: the rest of the environment (the
 *  messaging feature flag among it) is the user's to keep. */
export const CLAUDE_CHILD_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

/** Variables Codex sets on the commands it runs. `send` runs as one of
 *  them, so they reach the `claude` it starts unless dropped: a session
 *  carrying CODEX_THREAD_ID would have every `codex-collab send` it ever
 *  runs sign as that Codex thread, and CODEX_SANDBOX would make those
 *  refuse. The session is a peer of the Codex thread, not its command. */
export const CODEX_COMMAND_MARKERS = [
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
] as const;

/** Environment for the `claude` we start (and its reaper): the caller's,
 *  minus both sets of markers. */
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of CLAUDE_CHILD_MARKERS) delete env[key];
  for (const key of CODEX_COMMAND_MARKERS) delete env[key];
  return env;
}

/** Parse the id from `claude --bg`'s announcement:
 *  "backgrounded · <id> · <name>". */
export function parseBackgroundId(output: string): string | null {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})\s*·/i.exec(output);
  return m ? m[1] : null;
}

/** The permission mode a started session runs in. Nobody is attached to it,
 *  so it must never wait on a prompt — and it exists for Codex to hand work
 *  to, which `dontAsk` (deny whatever would prompt: every edit, most
 *  commands) reduced to reading and answering. In `auto` Claude Code's
 *  classifier reviews each action in a person's place, so delegated work
 *  runs with a safety check and without a prompt. Where auto mode is
 *  unavailable to the session (a setting turns it off, or the model lacks
 *  it) Claude Code starts it in Manual instead: an action that needs
 *  approval then waits on a prompt nobody sees, and `send`'s timeout is
 *  what ends the wait. */
export const SPAWN_PERMISSION_MODE = "auto";

/** Settings a started session runs with, passed to that session alone
 *  (`claude --settings`) — the user's settings files are never touched.
 *
 *  Left to its default, Claude Code has a background session isolate its
 *  edits in a git worktree of its own. A session started for Codex is there
 *  to work WITH it, in the tree they share: edits parked on a branch
 *  somewhere else are work Codex cannot see or build on. So that isolation
 *  is off for it, and the two coordinate as any two sessions in one
 *  checkout do. */
export const SPAWN_SETTINGS = { worktree: { bgIsolation: "none" } } as const;

/** How long to wait for a started session to register a socket. Claude
 *  Code binds it during startup, well before the first turn ends. */
export const SPAWN_REGISTER_TIMEOUT_MS = 45_000;

export interface SpawnClaudeOptions {
  cwd: string;
  stateDir: string;
  lingerSec?: number;
  /** Test seam: the claude binary. */
  claudeBin?: string;
  /** Test seam: how the reaper is started. */
  startReaper?: (session: SpawnedSession, cwd: string) => void;
  registerTimeoutMs?: number;
}

/** Start a background Claude Code session for this workspace, wait for it
 *  to register, record it, and arm its reaper. Rejects with a message fit
 *  for Codex when the session cannot be started or never registers. */
export async function spawnClaudeSession(opts: SpawnClaudeOptions): Promise<ClaudeSession> {
  const wsRoot = resolveWorkspaceDir(opts.cwd);
  const name = spawnedSessionName(opts.cwd);
  const lingerSec = opts.lingerSec ?? DEFAULT_SPAWN_LINGER_SEC;
  const bin = opts.claudeBin ?? "claude";
  let announced: string;
  try {
    announced = execFileSync(
      bin,
      ["--bg", "-n", name, "--permission-mode", SPAWN_PERMISSION_MODE, "--settings", JSON.stringify(SPAWN_SETTINGS), spawnedSessionBrief(wsRoot)],
      { cwd: wsRoot, env: spawnEnv(), encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error("Could not start a Claude Code session: `claude` is not on PATH.");
    const detail = (err.stderr ?? err.message ?? "").toString().trim();
    throw new Error(`Could not start a Claude Code session: ${detail || "claude --bg failed"}`);
  }
  const id = parseBackgroundId(announced);
  if (!id) throw new Error(`Could not start a Claude Code session: unexpected output from claude --bg: ${announced.trim()}`);

  const deadline = Date.now() + (opts.registerTimeoutMs ?? SPAWN_REGISTER_TIMEOUT_MS);
  let session: ClaudeSession | undefined;
  while (Date.now() < deadline) {
    session = listClaudeSessions({ cwd: opts.cwd, all: true, name })[0];
    if (session) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!session) {
    // Not ours to leave running: nothing would ever reap it. Stop it (the
    // conversation stays resumable) and say what happened.
    try {
      execFileSync(bin, ["stop", id], { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch { /* it may never have come up */ }
    throw new Error(`Started Claude Code session ${id} (${name}), but it did not register a messaging socket within ${Math.round((opts.registerTimeoutMs ?? SPAWN_REGISTER_TIMEOUT_MS) / 1000)}s; it was stopped again — \`claude logs ${id}\` shows what it did.`);
  }
  // The identity is the registry entry's own, verbatim: the reaper compares
  // it against later entries, and a start time computed here could be in the
  // other representation (see procIdentity) — every entry would then read
  // as someone else's, and the session would be forgotten, never stopped.
  const record: SpawnedSession = { id, pid: session.pid, name, startedAt: new Date().toISOString(), lingerSec, procStart: session.procStart ?? undefined, sessionId: session.sessionId };
  recordSpawnedSession(opts.stateDir, record);
  (opts.startReaper ?? startReaper)(record, opts.cwd);
  return { ...session, spawned: record };
}

/** True when the registry still shows `session` — same pid, same identity —
 *  and its process is verifiably the one that registered. The only ground
 *  for signalling a pid: a session listed on socket evidence alone may sit
 *  in another pid domain, where that number names some other process. */
function isVerifiablyOurs(session: SpawnedSession): boolean {
  const entry = readEntry(join(sessionsDir(), `${session.pid}.json`));
  if (!entry || entry.pid !== session.pid) return false;
  if (session.procStart && entry.procStart !== session.procStart) return false;
  if (session.sessionId && entry.sessionId !== session.sessionId) return false;
  return procIdentity(entry, probes) === "live";
}

/** Stop a session we started: `claude stop` keeps its conversation
 *  resumable; a plain signal is the fallback when the CLI is unavailable —
 *  and only for a process verified to be that session. */
export function stopClaudeSession(session: SpawnedSession, claudeBin = "claude"): void {
  try {
    execFileSync(claudeBin, ["stop", session.id], { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return;
  } catch { /* fall through to the signal */ }
  if (!isVerifiablyOurs(session)) return;
  try {
    process.kill(session.pid, "SIGTERM");
  } catch { /* already gone */ }
}

// ─── Reaper ─────────────────────────────────────────────────────────────────

/** Start the detached process that stops `session` once it has idled for
 *  its linger. It runs this same binary with a private subcommand
 *  (`reap-claude`), so the installed CLI is all it needs; `--dir` names the
 *  workspace whose records it keeps. */
export function startReaper(session: SpawnedSession, cwd: string): void {
  const child = spawn(
    process.execPath,
    ["run", process.argv[1], "reap-claude", session.id, String(session.pid), String(session.lingerSec), "--dir", cwd],
    { detached: true, stdio: "ignore", env: spawnEnv() },
  );
  // Without a listener a failed spawn is an unhandled error event, which
  // would crash `send` after the session is already started and recorded.
  child.on("error", (e) => {
    process.stderr.write(`[codex] Warning: could not start the reaper for ${session.name}: ${e.message} — Claude Code stops it after about an hour unattached.\n`);
  });
  child.unref();
}

/** What the reaper decides from one look at the registry: keep waiting,
 *  stop the session, or give up because it is gone or no longer ours. */
export function reaperVerdict(
  entry: Record<string, unknown> | null,
  pid: number,
  lingerSec: number,
  now = Date.now(),
  identity: { procStart?: string; sessionId?: string | null } = {},
): "wait" | "stop" | "gone" {
  if (!entry || entry.pid !== pid) return "gone";
  // A session that registered later under a recycled pid is someone else's.
  if (identity.procStart && entry.procStart !== identity.procStart) return "gone";
  if (identity.sessionId && entry.sessionId !== identity.sessionId) return "gone";
  if (entryLiveness(entry) === "dead") return "gone";
  if (entry.status === "busy") return "wait";
  // Idle since its last status change; an entry that never reports one
  // is idle since it registered.
  const since = typeof entry.statusUpdatedAt === "number"
    ? entry.statusUpdatedAt
    : typeof entry.startedAt === "number" ? entry.startedAt : now;
  return now - since >= lingerSec * 1000 ? "stop" : "wait";
}

/** The reaper loop: poll the session's registry entry until it has idled
 *  for the linger, then stop it and forget it. Exits when the session is
 *  gone. `pollMs` is a test seam. */
export async function runReaper(
  session: SpawnedSession,
  stateDir: string,
  opts: { pollMs?: number; claudeBin?: string; maxRounds?: number } = {},
): Promise<"stopped" | "gone"> {
  const file = join(sessionsDir(), `${session.pid}.json`);
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_REAP_POLL_MS) || 30_000);
  const identity = { procStart: session.procStart, sessionId: session.sessionId };
  const born = Date.parse(session.startedAt);
  const retireAt = Number.isFinite(born) ? born + SPAWN_MAX_LIFETIME_SEC * 1000 : Infinity;
  for (let round = 0; opts.maxRounds === undefined || round < opts.maxRounds; round++) {
    let verdict = reaperVerdict(readEntry(file), session.pid, session.lingerSec, Date.now(), identity);
    if (verdict === "wait" && Date.now() >= retireAt) verdict = "stop";
    if (verdict === "gone") {
      forgetSpawnedSession(stateDir, session.id);
      return "gone";
    }
    if (verdict === "stop") {
      stopClaudeSession(session, opts.claudeBin);
      // Confirm: `claude stop` can fail quietly. A session still registered
      // under the same identity, and verifiably that process, gets a signal.
      await new Promise((r) => setTimeout(r, Math.min(pollMs, 5000)));
      if (isVerifiablyOurs(session)) {
        try { process.kill(session.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
      }
      forgetSpawnedSession(stateDir, session.id);
      return "stopped";
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "gone";
}

/** A fresh session id for our own transient registrations. */
export function transientSessionId(): string {
  return randomUUID();
}
