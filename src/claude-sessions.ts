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
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolveWorkspaceDir } from "./config";
import { isCodexCollabSocket, procIdentity, sessionsDir, workspaceSuffix, type ProcProbes } from "./peer";
import { outstandingTasksFor } from "./claude-tasks";
import { acquireLockSync } from "./lock";

/** A live Claude Code session as the registry describes it. */
export interface ClaudeSession {
  pid: number;
  name: string;
  /** What the session last reported: `idle`; `busy` for a turn in progress;
   *  `shell` for a turn that has ended leaving a command of its own still
   *  running (Claude Code writes `shell` in place of `idle` while one is);
   *  `waiting` when it has stopped at a prompt only a person can answer;
   *  `unknown` for entries that carry no status, or one we do not know. */
  status: "idle" | "busy" | "shell" | "waiting" | "unknown";
  /** Registry kind: interactive, bg, daemon… Background sessions
   *  (`claude --bg`) report `bg`. */
  kind: string;
  /** What the session runs under: `cli` for a terminal, `claude-vscode` for
   *  the VS Code extension's panel… An `interactive` session is not always
   *  one a person can see in a terminal, and this is what says where it is. */
  entrypoint: string | null;
  /** The tmux pane a terminal session lives in (`session:@window.%pane`). */
  tmux: string | null;
  cwd: string;
  socketPath: string;
  sessionId: string | null;
  /** The start time the session registered with, verbatim — clock ticks on
   *  Linux, `ps -o lstart=` elsewhere. Its identity, with the pid. */
  procStart: string | null;
  /** The background job a `bg` session runs as, where Claude Code says. */
  jobId?: string | null;
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
  /** The model and effort it was started with; absent means the user's
   *  Claude Code default. Fixed for the session's life. */
  model?: string;
  effort?: string;
  /** Set once the session has been stopped (or found gone). Claude Code
   *  keeps a stopped session's conversation, so the record is kept too: it
   *  is what lets the next `send` resume that conversation instead of
   *  starting from nothing. Its `pid` means nothing any more. */
  stoppedAt?: string;
}

/** How long a stopped session stays worth resuming (seconds), by default.
 *  Long enough for work that spans days; `config spawn-resume` changes it. */
export const DEFAULT_SPAWN_RESUME_SEC = 7 * 24 * 3600;

/** Default idle linger for a spawned session (seconds). Claude Code stops
 *  an unattached background session itself after about an hour; this is
 *  the shorter bound we enforce for sessions nobody asked for by name. */
export const DEFAULT_SPAWN_LINGER_SEC = 30 * 60;

/** How long a started session may live before the reaper stops it at the
 *  next quiet moment. It catches a session that never idles long enough for
 *  the linger — flipping between busy and idle for days would otherwise keep
 *  it, and its reaper, alive forever. It is never a deadline on work: a
 *  session that is busy, or that a task is still waiting on, is left alone
 *  however old it is. */
export const SPAWN_MAX_LIFETIME_SEC = 4 * 3600;

/** A registry entry, or null when there is none. Claude Code rewrites an
 *  entry in place on every change of status — truncate, then write — so a
 *  read can land between the two and find the file empty or half written.
 *  That is a moment, and it is read again; a file that is not there is an
 *  absence. Registry entries older Claude Codes wrote carry no `kind`; any
 *  session that binds a socket counts as reachable regardless. */
function readEntry(file: string): Record<string, unknown> | null {
  for (let attempt = 0; ; attempt++) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      if (attempt >= 3) return null;
      Bun.sleepSync(15);
    }
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
 *  thread peers, a task's receiver — are never Claude sessions and are
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
    const status = entry.status === "idle" || entry.status === "busy" || entry.status === "shell" || entry.status === "waiting" ? entry.status : "unknown";
    sessions.push({
      pid,
      name: typeof entry.name === "string" && entry.name ? entry.name : `claude (pid ${pid})`,
      status,
      kind: typeof entry.kind === "string" ? entry.kind : "interactive",
      entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : null,
      tmux: typeof entry.tmux === "string" && entry.tmux ? entry.tmux : null,
      cwd,
      socketPath,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
      procStart: typeof entry.procStart === "string" ? entry.procStart : null,
      jobId: typeof entry.jobId === "string" ? entry.jobId : null,
      verified: liveness === "verified",
      statusUpdatedAt: typeof entry.statusUpdatedAt === "number" ? entry.statusUpdatedAt : null,
      spawned: spawnedRecordFor(spawned, entryIdentity(entry, pid)),
    });
  }
  // Interactive sessions first, then by name: the one the user is looking
  // at is the likelier counterpart, and a stable order keeps the listing
  // and any prefix resolution predictable.
  sessions.sort((a, b) => Number(a.kind === "bg") - Number(b.kind === "bg") || a.name.localeCompare(b.name));
  return sessions;
}

/** What identifies a registry entry's process and session. `kind` and
 *  `jobId` are Claude Code's: a background session's entry says `bg`, and
 *  names the job it runs as. */
export interface EntryIdentity {
  pid: number;
  sessionId: string | null;
  procStart: string | null;
  kind?: string | null;
  jobId?: string | null;
}

/** Which session codex-collab started, if any, a live registry entry is.
 *
 *  The same process is the same session: the pid AND its start time. A pid
 *  alone decides nothing — a record whose reaper died keeps a pid the machine
 *  may since have given to a session the user started.
 *
 *  The same background job is the same session under another process: Claude
 *  Code brings a job back as a new process — after an update, after a crash —
 *  under the job's id and its session id, with a new pid. A session id alone
 *  decides nothing either: `claude --resume <id>` in a terminal continues a
 *  conversation under its session id, and that is the user's session, which
 *  must never read as ours. So a match by session id holds only for an entry
 *  of kind `bg` that names this job (or names none, where an older Claude
 *  Code wrote no job id).
 *
 *  A stopped record's pid is history and never matches. The record comes
 *  back under the pid the session has now, which is the one any signal must
 *  check. */
export function spawnedRecordFor(records: SpawnedSession[], entry: EntryIdentity): SpawnedSession | null {
  const running = records.filter((r) => !r.stoppedAt);
  const sameJob = (r: SpawnedSession): boolean =>
    entry.kind === "bg" && (entry.jobId === undefined || entry.jobId === null || entry.jobId === r.id);
  const record = running.find((r) => r.pid === entry.pid && !!r.procStart && r.procStart === entry.procStart)
    ?? (entry.sessionId ? running.find((r) => r.sessionId === entry.sessionId && sameJob(r)) : undefined);
  if (!record) return null;
  return record.pid === entry.pid && record.procStart === (entry.procStart ?? undefined)
    ? record
    : { ...record, pid: entry.pid, procStart: entry.procStart ?? undefined };
}

/** Whether a reported status means the session has work in hand. Only `idle`
 *  and `waiting` (stopped at a prompt nobody will answer) are doing nothing:
 *  `busy` is a turn in progress, and `shell` is Claude Code's word for idle
 *  WITH a shell command of its own still running — the background command a
 *  turn left behind and will report on when it finishes. A status we do not
 *  know is not evidence of idleness either, so it counts as work: the cost of
 *  waiting on a session that had nothing to do is one process; the cost of
 *  stopping one that did is its work, and the reply nobody will ever get. */
export function statusHasWorkInHand(status: unknown): boolean {
  return typeof status === "string" && status !== "idle" && status !== "waiting";
}

/** What the registry says a session is doing right now, or null when its
 *  entry is gone. `send` watches this while it waits: a session nobody is
 *  attached to that reports `waiting` will wait forever. */
export function sessionStatusNow(pid: number): string | null {
  const entry = readEntry(join(sessionsDir(), `${pid}.json`));
  if (!entry || entry.pid !== pid) return null;
  return typeof entry.status === "string" ? entry.status : "unknown";
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
    // A session now running supersedes whatever was stopped before it: it
    // is either that conversation resumed or the one chosen in its place,
    // and a workspace has one started session to resume, not a history.
    const rest = readSpawnedSessions(stateDir).filter((s) => !s.stoppedAt && s.pid !== session.pid && s.id !== session.id);
    writeSpawnedSessions(stateDir, [...rest, session]);
  });
}

/** Keep a stopped session's record, marked as stopped, so its conversation
 *  can be resumed. Only the latest stopped session is kept. */
export function markSpawnedSessionStopped(stateDir: string, id: string, when: Date = new Date()): void {
  if (!existsSync(spawnedSessionsFile(stateDir))) return;
  withRecordsLock(stateDir, () => {
    const all = readSpawnedSessions(stateDir);
    const mine = all.find((s) => s.id === id);
    if (!mine) return;
    const running = all.filter((s) => !s.stoppedAt && s.id !== id);
    // Without a session id there is nothing to resume by.
    writeSpawnedSessions(stateDir, mine.sessionId ? [...running, { ...mine, stoppedAt: when.toISOString() }] : running);
  });
}

/** Move a running session's record to the process it runs as now: Claude
 *  Code brought it back under a new pid, and the record is what every later
 *  look and every signal goes by. */
export function updateSpawnedSessionProcess(stateDir: string, id: string, pid: number, procStart: string | undefined): void {
  if (!existsSync(spawnedSessionsFile(stateDir))) return;
  withRecordsLock(stateDir, () => {
    const all = readSpawnedSessions(stateDir);
    if (!all.some((s) => s.id === id && !s.stoppedAt)) return;
    writeSpawnedSessions(stateDir, all.map((s) => s.id === id && !s.stoppedAt ? { ...s, pid, procStart } : s));
  });
}

/** The stopped session the next `send` should resume, if any: the one this
 *  workspace recorded, stopped no longer than `windowSec` ago. */
export function resumableSession(stateDir: string, windowSec: number, now: number = Date.now()): SpawnedSession | null {
  if (!(windowSec > 0)) return null;
  const stopped = readSpawnedSessions(stateDir)
    .filter((s) => s.stoppedAt && s.sessionId && now - Date.parse(s.stoppedAt) <= windowSec * 1000)
    .sort((a, b) => Date.parse(b.stoppedAt!) - Date.parse(a.stoppedAt!));
  return stopped[0] ?? null;
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
/** How a started session answers, in both briefs. The Codex session
 *  receives the reply and nothing else, so the reply carries the whole
 *  answer; what the session writes in its own transcript after sending it
 *  reaches nobody working with it, and is output the user pays for. Said
 *  again on resuming, since a long or compacted conversation may have lost
 *  the first brief. */
const REPLY_RULE = "The reply is all the Codex session receives, so put everything the answer needs in it; after sending it, end your turn with one short line at most, such as \"Replied.\"";

export function spawnedSessionBrief(wsRoot: string): string {
  return [
    `You are a Claude Code session started by codex-collab for the Codex sessions working in ${wsRoot}.`,
    "Codex sessions message you through codex-collab; each message says which Codex thread it comes from.",
    `Answer by replying to the sender with SendMessage. ${REPLY_RULE}`,
    "Read the workspace as needed. Do not change files unless a message asks you to.",
    // Whatever Claude Code's settings decide about where a background
    // session's edits land, the Codex session only knows what the reply says.
    "When you do change files, say in your reply where the changes are: the path, and the branch and commit where there is one.",
    "You will be stopped after a while with no messages. Reply now with one line saying you are ready, then wait.",
  ].join(" ");
}

/** The first thing a RESUMED session is told: it has the conversation
 *  already, brief included, so this only says what happened in between. */
export function resumedSessionBrief(): string {
  return [
    "You were stopped by codex-collab after a while with no messages, and have now been resumed; your conversation so far is intact.",
    `Codex sessions will message you as before, and you answer with SendMessage as before. ${REPLY_RULE}`,
    "The workspace may have changed while you were stopped — look again before relying on what you saw earlier.",
    "Reply now with one line saying you are ready, then wait.",
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
 *  "backgrounded · <id> · <name>". Claude Code colours the id when the
 *  environment asks for colour (FORCE_COLOR) even into a pipe, and the
 *  session is already running by then: the escape codes are dropped before
 *  the id is read, or it would run with no record and no reaper. */
export function parseBackgroundId(output: string): string | null {
  const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})\s*·/i.exec(plain);
  return m ? m[1] : null;
}

/** Where Claude Code keeps its background jobs' state (`<id>/state.json`). */
export function jobsDir(): string {
  // Override for tests: a fake job must never land among the user's.
  return process.env.CODEX_COLLAB_JOBS_DIR ?? join(homedir(), ".claude", "jobs");
}

function readJobState(jobId: string): Record<string, unknown> | null {
  if (!/^[0-9a-f]{6,}$/i.test(jobId)) return null;
  return readEntry(join(jobsDir(), jobId, "state.json"));
}

/** The session id a background job runs, from its own state file — what
 *  its registry entry carries once it registers — or null before the file
 *  says, or on a Claude Code that does not keep one. */
export function jobSessionId(jobId: string): string | null {
  const id = readJobState(jobId)?.sessionId;
  return typeof id === "string" && id ? id : null;
}

/** Whether Claude Code counts work in flight for a background job. Some
 *  of it leaves the registry saying `idle`: a monitor, a scheduled wakeup or
 *  cron, an MCP task. Claude Code keeps the count in the job's own state
 *  (`inFlight`). Anything counted there but monitors it can drain holds the
 *  session, and so does a session cron. That is a little more than Claude
 *  Code's own retirement waits for — it will retire a settled session with a
 *  shell command still running — and on purpose: a command left running is
 *  work, and stopping the session throws it away. No file, or an older
 *  Claude Code, is no evidence either way: the status and the tasks decide. */
export function jobHasWorkInFlight(jobId: string): boolean {
  const inFlight = readJobState(jobId)?.inFlight;
  if (!inFlight || typeof inFlight !== "object") return false;
  const f = inFlight as Record<string, unknown>;
  const count = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
  if (count(f.queued) > 0) return true;
  if (count(f.tasks) - count(f.drainableMonitors) > 0) return true;
  return Array.isArray(f.kinds) && f.kinds.includes("session_cron");
}

/** The permission mode a started session runs in. Nobody is attached to it,
 *  so it must never wait on a prompt — and it exists for Codex to hand work
 *  to, which `dontAsk` (deny whatever would prompt: every edit, most
 *  commands) reduced to reading and answering. In `auto` Claude Code's
 *  classifier reviews each action in a person's place, so delegated work
 *  runs with a safety check and without a prompt. Where auto mode is
 *  unavailable to the session (a setting turns it off, or the model lacks
 *  it) Claude Code starts it in Manual instead: an action that needs
 *  approval then waits on a prompt nobody sees. The receiver of the task
 *  that led there notices (`watchForBlocked`), stops the session, and
 *  records the task as `blocked`. */
export const SPAWN_PERMISSION_MODE = "auto";

/** Settings a started session runs with, passed to that session alone
 *  (`claude --settings`) — the user's settings files are never touched.
 *
 *  Left to its default, Claude Code has a background session isolate its
 *  edits in a git worktree of its own. A session started for Codex is there
 *  to work WITH it, in the tree they share: edits parked on a branch
 *  somewhere else are work Codex cannot see or build on. So that isolation
 *  is off for it, and the two coordinate as any two sessions in one
 *  checkout do.
 *
 *  Auto-compaction is on for it whatever the user's own setting says. A
 *  person who compacts by hand is there to do it; nobody is attached to
 *  this session, and it is meant to be resumed and to carry a long
 *  collaboration — left alone, its context would fill until a turn failed,
 *  and every resumed turn would pay to re-read all of it. Command-line
 *  settings outrank the user's settings files for the one session they are
 *  passed to, so the user's own sessions compact as they always have. */
export const SPAWN_SETTINGS = { worktree: { bgIsolation: "none" }, autoCompactEnabled: true } as const;

/** The models a started session can run on, as the aliases `claude --model`
 *  takes. An alias always means the latest model of its tier, so nothing
 *  here names a version; a full model name is accepted as well. Claude Code
 *  has no command that lists its models, which is why the list lives here —
 *  it is what `codex-collab models --claude` prints, so a Codex session can
 *  weigh cost against the task before it starts a session. Most capable
 *  first. */
export const CLAUDE_MODEL_TIERS: ReadonlyArray<{ alias: string; description: string }> = [
  { alias: "fable", description: "The most capable: hard design problems, deep debugging, long multi-step work" },
  { alias: "opus", description: "Balanced everyday model: routine coding, reviews, explanations" },
  { alias: "sonnet", description: "Fastest and cheapest: lookups, summaries, simple questions" },
];

/** The context a started session fills before it compacts itself
 *  (`claude --autocompact`). Claude Code's own default is `auto`, which
 *  follows the model's window — a million tokens on the models that have one.
 *  A session started for Codex is long-lived and resumed, and every turn pays
 *  for the context it carries, so it compacts at a window it can afford
 *  rather than at the largest one the model allows. `config spawn-autocompact`
 *  sets it; `auto` gives Claude Code's behaviour back. */
export const DEFAULT_SPAWN_AUTOCOMPACT = "500k";

/** What `claude --autocompact` takes: `auto`, or 100k–1M in tokens, which it
 *  accepts as a plain number, `500k`, or `500` as shorthand for 500k. */
export function isAutocompactWindow(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "auto") return true;
  const m = /^(\d+)k?$/i.exec(value.trim());
  if (!m) return false;
  const n = Number(m[1]);
  const tokens = /k$/i.test(value.trim()) || n <= 1000 ? n * 1000 : n;
  return tokens >= 100_000 && tokens <= 1_000_000;
}

/** The effort levels `claude --effort` takes, lowest first. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORTS[number];

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (CLAUDE_EFFORTS as readonly string[]).includes(value);
}

/** The effort a started session runs at when neither `send --effort` nor
 *  `config spawn-effort` names one. Left to Claude Code, it would be the
 *  user's setting for their own sessions, or else the model's default, which
 *  differs from model to model — and neither shows in what `send` reports.
 *  Every model with effort levels has `high`. */
export const DEFAULT_SPAWN_EFFORT: ClaudeEffort = "high";

/** What `config spawn-effort` takes: one of Claude's levels, or `auto` to
 *  leave the effort to Claude Code. */
export function isSpawnEffortSetting(value: unknown): boolean {
  return value === "auto" || isClaudeEffort(value);
}

/** The effort a `spawn-effort` setting gives a started session: its level;
 *  none for `auto`, so Claude Code decides; ours when unset or unreadable. */
export function spawnEffortFor(setting: unknown): ClaudeEffort | undefined {
  if (setting === "auto") return undefined;
  return isClaudeEffort(setting) ? setting : DEFAULT_SPAWN_EFFORT;
}

/** A model name safe to hand to `claude --model`: an alias or a full name. */
export function isModelName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[^a-zA-Z0-9._\-\/:\[\]]/.test(value);
}

/** How a session's model and effort read in a listing or a notice: what was
 *  asked for, and the user's Claude Code default for whatever was not. */
export function describeModelChoice(model?: string, effort?: string): string {
  if (!model && !effort) return "the user's Claude Code default model and effort";
  return `${model ?? "the user's Claude Code default model"}, ${effort ? `${effort} effort` : "the user's Claude Code default effort"}`;
}

/** How long to wait for a started session to register a socket. Claude
 *  Code binds it during startup, well before the first turn ends. */
export const SPAWN_REGISTER_TIMEOUT_MS = 45_000;

/** `claude --bg` refused the folder. From Claude Code 2.1.281 a background
 *  session starts only in a folder the user has trusted in Claude Code — the
 *  folder itself, or one above it, no higher than its git repository's root
 *  when it is in one — and the
 *  trust prompt is answered in a terminal, by the user. A resumed session is
 *  refused the same as a new one, so whoever catches this keeps a stopped
 *  session's record: its conversation is there once the folder is trusted. */
export class WorkspaceNotTrustedError extends Error {
  constructor(folder: string, said: string) {
    super(
      `Claude Code will not start a session in ${folder}, because the folder is not trusted. ` +
      "A background session runs only in a folder the user has trusted in Claude Code: the folder's settings, hooks and MCP servers then run under their account, and only they can agree to that, in a terminal. " +
      `Claude Code says: ${said}`,
    );
    this.name = "WorkspaceNotTrustedError";
  }
}

export interface SpawnClaudeOptions {
  cwd: string;
  stateDir: string;
  lingerSec?: number;
  /** `claude --model` / `--effort` for the new session. Left out, the
   *  session runs on the user's Claude Code default. */
  model?: string;
  effort?: string;
  /** `claude --autocompact`; the default when left out. */
  autocompact?: string;
  /** A stopped session (see `resumableSession`) to continue instead of
   *  starting a new one: same conversation, new process. */
  resume?: SpawnedSession;
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
  // The model and effort are the caller's to choose, because the user pays
  // for them: a lookup has no need of the most capable model thinking hard.
  // Whatever is not chosen stays Claude Code's own default.
  const choice = [
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];
  const autocompact = opts.autocompact ?? DEFAULT_SPAWN_AUTOCOMPACT;
  // `auto` is Claude Code's own behaviour, and saying it is the same as not.
  const compaction = autocompact === "auto" ? [] : ["--autocompact", autocompact];
  // Resuming: `claude --bg --resume <session-id>` continues that conversation
  // in the background. Everything else is passed as for a new session — a
  // resumed session is a new process, and takes its mode, settings, model
  // and effort from this command line, not from the one it first ran with.
  const resume = opts.resume?.sessionId ? ["--resume", opts.resume.sessionId] : [];
  const brief = resume.length ? resumedSessionBrief() : spawnedSessionBrief(wsRoot);
  let announced: string;
  try {
    announced = execFileSync(
      bin,
      ["--bg", "-n", name, ...resume, "--permission-mode", SPAWN_PERMISSION_MODE, "--settings", JSON.stringify(SPAWN_SETTINGS), ...compaction, ...choice, brief],
      { cwd: wsRoot, env: spawnEnv(), encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error("Could not start a Claude Code session: `claude` is not on PATH.");
    const detail = (err.stderr ?? err.message ?? "").toString().trim();
    const untrusted = /^Workspace not trusted\b.*$/m.exec(detail);
    if (untrusted) throw new WorkspaceNotTrustedError(wsRoot, untrusted[0].trim());
    // A Claude Code without `--autocompact` refuses the whole command line.
    // Its own window is a worse fit than ours, and no session at all is worse
    // than either, so it starts without the flag and says so once.
    // Only the option's own complaint counts ("unknown option '--autocompact'",
    // "option '--autocompact <tokens>' argument … is invalid"): the settings
    // JSON on the same command line says autoCompactEnabled, and an error that
    // echoes it is some other failure.
    if (compaction.length > 0 && /option\W+--autocompact\b/i.test(detail)) {
      process.stderr.write("[codex] This Claude Code does not take --autocompact; starting the session on its own compaction window (`codex-collab config spawn-autocompact auto` settles it).\n");
      return spawnClaudeSession({ ...opts, autocompact: "auto" });
    }
    throw new Error(`Could not start a Claude Code session: ${detail || "claude --bg failed"}`);
  }
  const id = parseBackgroundId(announced);
  if (!id) throw new Error(`Could not start a Claude Code session: unexpected output from claude --bg: ${announced.trim()}`);

  // The job's own state file names the session it runs, and that is the
  // entry to wait for: another entry under the same name — a session this
  // workspace started earlier that Claude Code brought back — is not it.
  // Before the file says, or where it never does, the name is all there is.
  const deadline = Date.now() + (opts.registerTimeoutMs ?? SPAWN_REGISTER_TIMEOUT_MS);
  let session: ClaudeSession | undefined;
  while (Date.now() < deadline) {
    const sessionId = jobSessionId(id);
    session = listClaudeSessions({ cwd: opts.cwd, all: true, name }).find((s) => !sessionId || s.sessionId === sessionId);
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
  const record: SpawnedSession = { id, pid: session.pid, name, startedAt: new Date().toISOString(), lingerSec, procStart: session.procStart ?? undefined, sessionId: session.sessionId, model: opts.model, effort: opts.effort };
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
  // Every session codex-collab starts is a background one: whatever else an
  // entry is, it is somebody's to close, never ours to signal.
  if (typeof entry.kind === "string" && entry.kind !== "bg") return false;
  if (!spawnedRecordFor([session], entryIdentity(entry, session.pid))) return false;
  return procIdentity(entry, probes) === "live";
}

function entryIdentity(entry: Record<string, unknown>, pid: number): EntryIdentity {
  return {
    pid,
    sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
    procStart: typeof entry.procStart === "string" ? entry.procStart : null,
    kind: typeof entry.kind === "string" ? entry.kind : null,
    jobId: typeof entry.jobId === "string" ? entry.jobId : undefined,
  };
}

/** Stop a session we started: `claude stop` keeps its conversation
 *  resumable; a plain signal is the fallback when the CLI is unavailable —
 *  and only for a process verified to be that session. */
export function stopClaudeSession(session: SpawnedSession, claudeBin = "claude"): "asked" | "signalled" | "untouched" {
  try {
    execFileSync(claudeBin, ["stop", session.id], { encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return "asked";
  } catch { /* fall through to the signal */ }
  if (!isVerifiablyOurs(session)) return "untouched";
  try {
    process.kill(session.pid, "SIGTERM");
  } catch { /* already gone */ }
  return "signalled";
}

/** Stop a session we started and make sure of it. `claude stop` can fail
 *  quietly — a session sitting at a prompt is just the kind to ignore it — so
 *  after a moment a session still registered under the same identity, and
 *  verifiably that process, gets a signal. Says whether a signal was sent,
 *  which is what decides how long the session must stay gone (see
 *  stopSpawnedSession). */
export async function stopAndConfirm(session: SpawnedSession, opts: { claudeBin?: string; confirmAfterMs?: number } = {}): Promise<{ signalled: boolean }> {
  let signalled = stopClaudeSession(session, opts.claudeBin) === "signalled";
  const confirmAfterMs = opts.confirmAfterMs ?? Math.min(Number(process.env.CODEX_COLLAB_REAP_POLL_MS) || 5000, 5000);
  await new Promise((r) => setTimeout(r, confirmAfterMs));
  if (isVerifiablyOurs(session)) {
    try { process.kill(session.pid, "SIGTERM"); signalled = true; } catch { /* gone meanwhile */ }
  }
  return { signalled };
}

/** Stop a session we started, and see it gone: true once it is, false when
 *  it is still there. Whoever marks a session stopped goes through here
 *  first — a record marked stopped while its session lives makes that session
 *  read as the user's own, with nothing of ours watching it.
 *
 *  How long it is watched depends on how it went. `claude stop` retires the
 *  job, and Claude Code does not bring a retired job back: a few looks in a
 *  row settle it. A signal is another matter — Claude Code takes a
 *  background session that dies that way in the middle of a turn for a crash,
 *  and brings the job back ten seconds later — so a session that had to be
 *  signalled counts as gone only once it has stayed gone past that window. */
export async function stopSpawnedSession(
  session: SpawnedSession,
  opts: { claudeBin?: string; confirmAfterMs?: number; spacingMs?: number } = {},
): Promise<{ gone: boolean; signalled: boolean }> {
  const { signalled } = await stopAndConfirm(session, opts);
  const restartWindowMs = Number(process.env.CODEX_COLLAB_RESTART_GRACE_MS) || 30_000;
  const spacingMs = opts.spacingMs ?? 250;
  const gone = await spawnedSessionGone(session, {
    spacingMs,
    minAbsentMs: signalled ? restartWindowMs : 0,
    // Forty looks, and ten seconds at the usual spacing, to go once told to.
    withinMs: (signalled ? restartWindowMs : 0) + Math.min(10_000, spacingMs * 40),
  });
  return { gone, signalled };
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
  // A session that registered later under a recycled pid is someone else's:
  // the same session is the same session id, or the same process start.
  if (identity.procStart || identity.sessionId) {
    const same = (!!identity.sessionId && entry.sessionId === identity.sessionId)
      || (!!identity.procStart && entry.procStart === identity.procStart);
    if (!same) return "gone";
  }
  if (entryLiveness(entry) === "dead") return "gone";
  if (statusHasWorkInHand(entry.status)) return "wait";
  // Idle since its last status change; an entry that never reports one
  // is idle since it registered.
  const since = typeof entry.statusUpdatedAt === "number"
    ? entry.statusUpdatedAt
    : typeof entry.startedAt === "number" ? entry.startedAt : now;
  return now - since >= lingerSec * 1000 ? "stop" : "wait";
}

/** The registry entry of the session a record names, wherever it is now:
 *  under the pid it was recorded with, or — Claude Code having brought it
 *  back as a new process, after an update or a crash — under its session id
 *  at another pid. Null when it is nowhere, or only as a dead process. */
export function locateSpawnedSession(session: SpawnedSession): Record<string, unknown> | null {
  const recorded = readEntry(join(sessionsDir(), `${session.pid}.json`));
  if (recorded && recorded.pid === session.pid && spawnedRecordFor([session], entryIdentity(recorded, session.pid)) && entryLiveness(recorded) !== "dead") {
    return recorded;
  }
  return findRestartedSession({ pid: session.pid, sessionId: session.sessionId, jobId: session.id });
}

/** A background session Claude Code brought back as a new process — after an
 *  update, or after it died in the middle of a turn — found by what the
 *  restart keeps: its session id and its job. The live registry entry at a
 *  pid other than `pid`, or null. Only a `bg` entry can be it: a session a
 *  person resumes in a terminal carries the same session id, and is theirs
 *  (see spawnedRecordFor). */
export function findRestartedSession(s: { pid: number; sessionId: string | null | undefined; jobId?: string | null; socketPath?: string }): Record<string, unknown> | null {
  if (!s.sessionId) return null;
  const dir = sessionsDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const pid = Number(file.slice(0, -".json".length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === s.pid) continue;
    const entry = readEntry(join(dir, file));
    if (!entry || entry.pid !== pid || entry.sessionId !== s.sessionId || entry.kind !== "bg") continue;
    if (s.jobId && typeof entry.jobId === "string" && entry.jobId !== s.jobId) continue;
    if (s.socketPath !== undefined && entry.messagingSocketPath !== s.socketPath) continue;
    if (entryLiveness(entry) === "dead") continue;
    return entry;
  }
  return null;
}

/** How many looks in a row must find a session nowhere before it is taken as
 *  gone, once it has been told to stop. */
const STOPPED_GONE_LOOKS = 3;

/** How many looks in a row, `REAPER_RECHECK_MS` apart, must find a session
 *  nowhere before the reaper takes it as gone of its own accord. Claude Code
 *  restarts a background session it lost after ten seconds, and the new
 *  process takes a moment more to register: the looks span thirty seconds, so
 *  a session on its way back is seen before it is written off. */
const REAPER_GONE_LOOKS = 4;
const REAPER_RECHECK_MS = 10_000;

/** The reaper loop: follow the session until it has idled for the linger,
 *  then stop it, see it gone, and keep its record as stopped. Exits when the
 *  session is gone. `pollMs` is a test seam. */
export async function runReaper(
  recorded: SpawnedSession,
  stateDir: string,
  opts: { pollMs?: number; claudeBin?: string; maxRounds?: number } = {},
): Promise<"stopped" | "gone"> {
  let session = recorded;
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_REAP_POLL_MS) || 30_000);
  // A second look at a session that seemed gone comes sooner than the next
  // poll: gone is final for the reaper, and a moment's absence is not.
  const recheckMs = Math.min(pollMs, REAPER_RECHECK_MS);
  const born = Date.parse(session.startedAt);
  const retireAt = Number.isFinite(born) ? born + SPAWN_MAX_LIFETIME_SEC * 1000 : Infinity;
  let missing = 0;
  for (let round = 0; opts.maxRounds === undefined || round < opts.maxRounds; round++) {
    // Stopped by someone else (`peers stop`, a task that found it at a
    // prompt), or its record replaced by a session started or resumed since:
    // there is nothing left here for this reaper to watch, and a session that
    // now answers to the same id is another reaper's.
    const own = readSpawnedSessions(stateDir).find((r) => r.id === session.id);
    if (!own || own.stoppedAt) return "gone";
    const entry = locateSpawnedSession(session);
    if (entry && entry.pid !== session.pid) {
      // Brought back as a new process: the same session, its work and its
      // conversation — and still ours to watch, and to stop.
      session = { ...session, pid: entry.pid as number, procStart: typeof entry.procStart === "string" ? entry.procStart : undefined };
      updateSpawnedSessionProcess(stateDir, session.id, session.pid, session.procStart);
    }
    let verdict = reaperVerdict(entry, session.pid, session.lingerSec, Date.now(), { procStart: session.procStart, sessionId: session.sessionId });
    if (verdict === "gone") {
      if (++missing < REAPER_GONE_LOOKS) {
        await new Promise((r) => setTimeout(r, recheckMs));
        continue;
      }
      // Gone on its own — Claude Code stops an unattached session itself,
      // and a person may have. Its conversation is kept all the same, so the
      // record stays, as stopped: the next `send` can pick it up again.
      markSpawnedSessionStopped(stateDir, session.id);
      return "gone";
    }
    missing = 0;
    // A session a task is still waiting on is working, whatever the registry
    // says: Claude Code calls a session idle the moment it ends a turn, and a
    // turn that leaves a command running in the background and reports when
    // it finishes ends like any other. Stopping it there threw the work away
    // and left the task with no reply that could ever come. Work Claude Code
    // counts in flight — a monitor, a scheduled wakeup — holds it the same way.
    const owed = outstandingTasksFor(stateDir, session).length > 0;
    const inFlight = jobHasWorkInFlight(session.id);
    // Old enough to retire, and nothing to interrupt: a session in the middle
    // of a turn is working, and its age is no reason to stop it there.
    if (verdict === "wait" && Date.now() >= retireAt && !owed && !inFlight && !statusHasWorkInHand(entry?.status)) verdict = "stop";
    if (verdict === "stop" && (owed || inFlight)) verdict = "wait";
    if (verdict === "stop") {
      // Recorded as stopped only once it is: a record marked stopped while
      // its session runs makes that session read as the user's own, with
      // nothing of ours left watching it. A stop that did not take is tried
      // again at the next look.
      if ((await stopSpawnedSession(session, { claudeBin: opts.claudeBin, confirmAfterMs: Math.min(pollMs, 5000), spacingMs: Math.min(pollMs, 250) })).gone) {
        // `claude stop` keeps the conversation; keep the record that finds it.
        markSpawnedSessionStopped(stateDir, session.id);
        return "stopped";
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "gone";
}

/** Whether a session told to stop has gone within `withinMs`: nowhere on
 *  several looks in a row, and for at least `minAbsentMs`. It takes a moment
 *  to go, a torn read of its entry is not its absence, and a session Claude
 *  Code is about to bring back is only away. */
export async function spawnedSessionGone(
  session: SpawnedSession,
  opts: { withinMs?: number; spacingMs?: number; minAbsentMs?: number } = {},
): Promise<boolean> {
  const until = Date.now() + (opts.withinMs ?? 3000);
  const spacingMs = opts.spacingMs ?? 100;
  const minAbsentMs = opts.minAbsentMs ?? 0;
  let absent = 0;
  let absentSince: number | null = null;
  for (;;) {
    const now = Date.now();
    if (locateSpawnedSession(session)) {
      absent = 0;
      absentSince = null;
    } else {
      absent++;
      absentSince ??= now;
      if (absent >= STOPPED_GONE_LOOKS && now - absentSince >= minAbsentMs) return true;
    }
    if (now >= until) return false;
    await new Promise((r) => setTimeout(r, spacingMs));
  }
}

/** A fresh session id for our own transient registrations. */
export function transientSessionId(): string {
  return randomUUID();
}
