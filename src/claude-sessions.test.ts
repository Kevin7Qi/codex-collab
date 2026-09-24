// src/claude-sessions.test.ts — listing, spawning, and reaping Claude Code sessions
//
// The registry is a fake under CODEX_COLLAB_SESSIONS_DIR; "live" sessions
// are backed by a sleeping child of this test, so liveness and start-time
// checks run for real. Nothing here touches the user's registry or starts
// a real `claude`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { buildRegistryEntry, procIdentity, procStartOf, procStartTicksOf } from "./peer";
import { config, mailboxRoot } from "./config";
import { createTask, updateTask } from "./claude-tasks";
import {
  CLAUDE_CHILD_MARKERS,
  CLAUDE_EFFORTS,
  CLAUDE_MODEL_TIERS,
  CODEX_COMMAND_MARKERS,
  DEFAULT_SPAWN_EFFORT,
  DEFAULT_SPAWN_LINGER_SEC,
  describeModelChoice,
  isAutocompactWindow,
  isClaudeEffort,
  isModelName,
  isSpawnEffortSetting,
  forgetSpawnedSession,
  jobHasWorkInFlight,
  jobSessionId,
  listClaudeSessions,
  markSpawnedSessionStopped,
  parseBackgroundId,
  readSpawnedSessions,
  reaperVerdict,
  recordSpawnedSession,
  resolveSession,
  resumableSession,
  resumedSessionBrief,
  runReaper,
  sessionStatusNow,
  SPAWN_MAX_LIFETIME_SEC,
  spawnClaudeSession,
  spawnEffortFor,
  spawnEnv,
  spawnedSessionBrief,
  spawnedSessionName,
  stopSpawnedSession,
  setProcProbesForTests,
  setProcStartReaderForTests,
  WorkspaceNotTrustedError,
  type SpawnedSession,
} from "./claude-sessions";

// Sleepers, ps and sh fakes: Unix only, like the messaging this serves.
const onWindows = process.platform === "win32";
const describeUnix = onWindows ? describe.skip : describe;

let root: string;
let registry: string;
let wsA: string;
let wsB: string;
let sleeper: ChildProcess;
let sleeperStart: string;
const previousRegistry = process.env.CODEX_COLLAB_SESSIONS_DIR;
const previousJobs = process.env.CODEX_COLLAB_JOBS_DIR;
const previousRestartGrace = process.env.CODEX_COLLAB_RESTART_GRACE_MS;
let jobs: string;

beforeAll(async () => {
  if (onWindows) return;
  root = mkdtempSync(join(tmpdir(), "cc-sessions-"));
  registry = join(root, "sessions");
  jobs = join(root, "jobs");
  wsA = join(root, "ws-a");
  wsB = join(root, "ws-b");
  for (const d of [registry, jobs, wsA, join(wsA, "sub"), wsB]) mkdirSync(d, { recursive: true });
  // A workspace is a git checkout: its subdirectories resolve to its root.
  spawnSync("git", ["init", "-q", wsA]);
  process.env.CODEX_COLLAB_SESSIONS_DIR = registry;
  // Claude Code's job states, faked as the registry is: the reaper and the
  // spawn read them, and must never read the user's.
  process.env.CODEX_COLLAB_JOBS_DIR = jobs;
  // Claude Code's restart window, which a signalled session must stay gone
  // past: a moment, here, not half a minute.
  process.env.CODEX_COLLAB_RESTART_GRACE_MS = "300";
  // A live process that is not this one: listClaudeSessions skips our own pid
  // (that is where a `send` registers itself).
  sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 50));
  sleeperStart = procStartOf(sleeper.pid!);
});

afterAll(() => {
  if (onWindows) return;
  try { sleeper.kill(); } catch { /* gone */ }
  if (previousRegistry === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
  else process.env.CODEX_COLLAB_SESSIONS_DIR = previousRegistry;
  if (previousJobs === undefined) delete process.env.CODEX_COLLAB_JOBS_DIR;
  else process.env.CODEX_COLLAB_JOBS_DIR = previousJobs;
  if (previousRestartGrace === undefined) delete process.env.CODEX_COLLAB_RESTART_GRACE_MS;
  else process.env.CODEX_COLLAB_RESTART_GRACE_MS = previousRestartGrace;
  rmSync(root, { recursive: true, force: true });
});

function register(file: string, overrides: Record<string, unknown>): void {
  const entry = {
    ...buildRegistryEntry({
      pid: sleeper.pid!,
      cwd: wsA,
      name: "live-a",
      socketPath: "/tmp/cc-socks/1.sock",
      version: "2.1.261",
      procStart: sleeperStart,
      sessionId: "00000000-0000-4000-8000-000000000001",
    }),
    ...overrides,
  };
  writeFileSync(join(registry, file), JSON.stringify(entry));
}

function clearRegistry(): void {
  rmSync(registry, { recursive: true, force: true });
  mkdirSync(registry, { recursive: true });
}

describeUnix("listClaudeSessions", () => {
  test("lists a live session in the workspace, and hides it from another workspace", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, {});
    const inA = listClaudeSessions({ cwd: wsA });
    expect(inA.map((s) => s.name)).toEqual(["live-a"]);
    expect(inA[0].socketPath).toBe("/tmp/cc-socks/1.sock");
    expect(inA[0].status).toBe("idle");
    expect(listClaudeSessions({ cwd: wsB })).toEqual([]);
    expect(listClaudeSessions({ cwd: wsB, all: true }).map((s) => s.name)).toEqual(["live-a"]);
  });

  test("a subdirectory of the workspace sees the session at its root", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, {});
    expect(listClaudeSessions({ cwd: join(wsA, "sub") }).map((s) => s.name)).toEqual(["live-a"]);
  });

  test("where ps cannot run (Codex's sandbox), a session whose socket is still in place lists", () => {
    clearRegistry();
    const socket = join(root, "live.sock");
    writeFileSync(socket, "");
    register(`${sleeper.pid}.json`, { messagingSocketPath: socket });
    setProcStartReaderForTests(() => { throw new Error("Operation not permitted"); });
    try {
      expect(listClaudeSessions({ cwd: wsA }).map((s) => s.name)).toEqual(["live-a"]);
      // The session exited and took its socket with it.
      rmSync(socket);
      expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    } finally {
      setProcStartReaderForTests(null);
    }
  });

  test("a session Claude Code registered on Linux (start time in clock ticks) lists, and a recycled pid does not", () => {
    clearRegistry();
    // What Claude Code writes for its own sessions on Linux: field 22 of
    // /proc/<pid>/stat, not `ps -o lstart=`. Probed through the seam so the
    // case holds on a host with no /proc; `ps` must not even be consulted.
    setProcProbesForTests({
      ticksOf: (pid) => (pid === sleeper.pid ? "236353382" : null),
      lstartOf: () => { throw new Error("ps must not decide a ticks entry"); },
    });
    try {
      register(`${sleeper.pid}.json`, { procStart: "236353382" });
      const [s] = listClaudeSessions({ cwd: wsA });
      expect(s.name).toBe("live-a");
      expect(s.verified).toBe(true);
      expect(s.procStart).toBe("236353382");
      // Same pid, another start time: the pid was recycled.
      register(`${sleeper.pid}.json`, { procStart: "111" });
      expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    } finally {
      setProcProbesForTests(null);
    }
  });

  test("from another pid domain (Codex's sandbox from 0.154), a session lists on its socket, unverified", () => {
    clearRegistry();
    const socket = join(root, "foreign.sock");
    writeFileSync(socket, "");
    register(`${sleeper.pid}.json`, { messagingSocketPath: socket, pidDomain: "linux:m:pid:[4026531836]", procStart: "236353382" });
    // In another PID namespace every host pid answers ESRCH — which must
    // not be read as "the session is dead": the domain is checked first.
    setProcProbesForTests({
      ownDomain: () => "linux:m:pid:[4026533467]",
      signal: () => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); },
    });
    try {
      const [s] = listClaudeSessions({ cwd: wsA });
      expect(s.name).toBe("live-a");
      expect(s.verified).toBe(false);
      rmSync(socket);
      expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    } finally {
      setProcProbesForTests(null);
    }
  });

  test("entries that cannot be messaged are left out", () => {
    clearRegistry();
    // No socket: an older Claude Code, or a record of another kind.
    register(`${sleeper.pid}.json`, { messagingSocketPath: undefined });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    // codex-collab's own registrations (a broker, a thread peer, a task's receiver).
    register(`${sleeper.pid}.json`, { messagingSocketPath: join(config.dataDir, "workspaces", "x", "peer.sock") });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    register(`${sleeper.pid}.json`, { messagingSocketPath: join(mailboxRoot(), "task-abc12345.sock") });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    // A dead pid, a filename that does not match, a recycled pid.
    register("999999.json", { pid: 999999 });
    register(`${sleeper.pid}.json`, { pid: sleeper.pid! + 1 });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    register(`${sleeper.pid}.json`, { procStart: "Mon Jan  1 00:00:00 2001" });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    // Our own pid is where a send registers itself — never a peer.
    register(`${process.pid}.json`, { pid: process.pid, procStart: procStartOf(process.pid) });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
  });

  test("interactive sessions sort before background ones, then by name", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, { name: "zed", kind: "interactive" });
    // A second live process for a second entry.
    const other = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      const start = procStartOf(other.pid!);
      register(`${other.pid}.json`, { pid: other.pid, procStart: start, name: "alpha", kind: "bg" });
      const names = listClaudeSessions({ cwd: wsA }).map((s) => `${s.name}:${s.kind}`);
      expect(names).toEqual(["zed:interactive", "alpha:bg"]);
    } finally {
      other.kill();
    }
  });

  test("a session codex-collab started is marked from the workspace's records", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, { name: "claude(ws-a-abc123)", kind: "bg" });
    const stateDir = join(root, "state-spawned");
    recordSpawnedSession(stateDir, { id: "abc12345", pid: sleeper.pid!, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60, sessionId: "00000000-0000-4000-8000-000000000001" });
    const [s] = listClaudeSessions({ cwd: wsA, stateDir });
    expect(s.spawned?.id).toBe("abc12345");
    expect(listClaudeSessions({ cwd: wsA })[0].spawned).toBeNull();
  });

  test("a pid a started session once had, now the user's session, is not ours", () => {
    clearRegistry();
    // The user's own session, under a pid a started session had before its
    // reaper died: another start time, another session id.
    register(`${sleeper.pid}.json`, { name: "the-users-own" });
    const stateDir = join(root, "state-reused-pid");
    recordSpawnedSession(stateDir, {
      id: "abc12346", pid: sleeper.pid!, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60,
      procStart: "Mon Jan  1 00:00:00 2001", sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned).toBeNull();
    // The same pid AND the same start time is the same process.
    recordSpawnedSession(stateDir, {
      id: "abc12347", pid: sleeper.pid!, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60,
      procStart: sleeperStart, sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned?.id).toBe("abc12347");
  });

  test("a started session Claude Code brought back under a new pid is still ours, under that pid", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, { name: "claude(ws-a-abc123)", kind: "bg" });
    const stateDir = join(root, "state-respawned");
    // Recorded under the pid it had before Claude Code restarted it.
    recordSpawnedSession(stateDir, {
      id: "abc12348", pid: 4242, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60,
      procStart: "123", sessionId: "00000000-0000-4000-8000-000000000001",
    });
    const [s] = listClaudeSessions({ cwd: wsA, stateDir });
    expect(s.spawned).toEqual(expect.objectContaining({ id: "abc12348", pid: sleeper.pid, procStart: sleeperStart }));
    // Naming its job, it is the same job.
    register(`${sleeper.pid}.json`, { name: "claude(ws-a-abc123)", kind: "bg", jobId: "abc12348" });
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned?.id).toBe("abc12348");
    // Another job under the same session id is not it.
    register(`${sleeper.pid}.json`, { name: "claude(ws-a-abc123)", kind: "bg", jobId: "ffff0000" });
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned).toBeNull();
  });

  test("the user's own session continuing a started session's conversation is theirs", () => {
    clearRegistry();
    // `claude --resume <id>` in a terminal keeps the session id: same id,
    // an interactive session, the user's.
    register(`${sleeper.pid}.json`, { name: "the-users-own", kind: "interactive" });
    const stateDir = join(root, "state-user-resumed");
    recordSpawnedSession(stateDir, {
      id: "abc12349", pid: 4242, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60,
      procStart: "123", sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned).toBeNull();
  });
});

describeUnix("process identity", () => {
  test.skipIf(process.platform !== "linux")("procStartTicksOf counts fields from the last parenthesis, whatever the process is called", () => {
    const stat = join(root, "stat-fixture");
    // comm holds spaces AND parentheses; starttime (field 22) is 236353382.
    writeFileSync(stat, "4242 (tmux: server (1) x) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 236353382 8000000 300 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n");
    expect(procStartTicksOf(4242, stat)).toBe("236353382");
    writeFileSync(stat, "not a stat line");
    expect(procStartTicksOf(4242, stat)).toBeNull();
    expect(procStartTicksOf(4242, join(root, "no-such-stat"))).toBeNull();
    // The real thing, for this very process.
    expect(procStartTicksOf(process.pid)).toMatch(/^\d+$/);
  });

  test("procIdentity accepts either representation of the start time, and only an exact match", () => {
    const pid = sleeper.pid!;
    const alive = { signal: () => {} };
    const ticks = { ...alive, ticksOf: () => "236353382", lstartOf: () => "Sat Sep 19 10:38:10 2026" };
    expect(procIdentity({ pid, procStart: "236353382" }, ticks)).toBe("live");
    expect(procIdentity({ pid, procStart: "236353383" }, ticks)).toBe("dead");
    // codex-collab's own entries, and Claude Code's where there is no /proc.
    expect(procIdentity({ pid, procStart: "Sat Sep 19 10:38:10 2026" }, ticks)).toBe("live");
    expect(procIdentity({ pid, procStart: "Sat Sep 19 10:38:11 2026" }, ticks)).toBe("dead");
    // No /proc (macOS): a ticks-shaped string can only be compared to lstart.
    expect(procIdentity({ pid, procStart: "236353382" }, { ...alive, ticksOf: () => null, lstartOf: () => "Sat Sep 19 10:38:10 2026" })).toBe("dead");
    // No start time on record: the pid answering is all there is.
    expect(procIdentity({ pid }, alive)).toBe("live");
    expect(procIdentity({ pid: "7" }, alive)).toBe("dead");
  });

  test("procIdentity: a gone pid is dead; one nothing can read, or from another domain, is unverifiable", () => {
    const pid = sleeper.pid!;
    const esrch = () => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); };
    const eperm = () => { throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" }); };
    const noPs = () => { throw new Error("Operation not permitted"); };
    expect(procIdentity({ pid, procStart: "x" }, { signal: esrch })).toBe("dead");
    // Codex's sandbox up to 0.153.4: kill answers EPERM and ps cannot run.
    expect(procIdentity({ pid, procStart: "x" }, { signal: eperm, ticksOf: () => null, lstartOf: noPs })).toBe("unverifiable");
    // Another pid domain: ESRCH there says nothing, so it is never asked.
    const foreign = { ownDomain: () => "linux:m:pid:[2]", signal: esrch };
    expect(procIdentity({ pid, procStart: "1", pidDomain: "linux:m:pid:[1]" }, foreign)).toBe("unverifiable");
    expect(procIdentity({ pid, procStart: "1", pidDomain: "linux:other-machine:pid:[2]" }, foreign)).toBe("unverifiable");
    // The same domain, or a domain that cannot be told here: the usual checks.
    expect(procIdentity({ pid, procStart: "1", pidDomain: "linux:m:pid:[2]" }, { ...foreign, signal: () => {}, ticksOf: () => "1" })).toBe("live");
    expect(procIdentity({ pid, procStart: "1", pidDomain: "linux:m:pid:[1]" }, { ownDomain: () => null, signal: () => {}, ticksOf: () => "1" })).toBe("live");
  });
});

describeUnix("resolveSession", () => {
  const sessions = ["Explore messaging", "explore-two", "claude(ws-a-abc123)"].map((name) => ({
    pid: 1, name, status: "idle" as const, kind: "interactive", cwd: "/", entrypoint: "cli", tmux: null, socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: null, spawned: null,
  }));
  test("exact name wins, a unique prefix resolves, an ambiguous one lists candidates", () => {
    expect(resolveSession(sessions, "explore-two").session?.name).toBe("explore-two");
    expect(resolveSession(sessions, "claude(").session?.name).toBe("claude(ws-a-abc123)");
    const r = resolveSession(sessions, "expl");
    expect(r.session).toBeNull();
    expect(r.ambiguous.map((s) => s.name)).toEqual(["Explore messaging", "explore-two"]);
    expect(resolveSession(sessions, "nobody")).toEqual({ session: null, ambiguous: [] });
  });
});

describeUnix("spawned-session records", () => {
  test("record, read, replace by pid, forget", () => {
    const stateDir = join(root, "state-records");
    const a: SpawnedSession = { id: "aaaaaaaa", pid: 11, name: "a", startedAt: "t", lingerSec: 1 };
    const b: SpawnedSession = { id: "bbbbbbbb", pid: 12, name: "b", startedAt: "t", lingerSec: 1 };
    recordSpawnedSession(stateDir, a);
    recordSpawnedSession(stateDir, b);
    expect(readSpawnedSessions(stateDir).map((s) => s.id)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    recordSpawnedSession(stateDir, { ...a, id: "aaaaaaa2" });
    expect(readSpawnedSessions(stateDir).map((s) => s.id)).toEqual(["bbbbbbbb", "aaaaaaa2"]);
    forgetSpawnedSession(stateDir, "bbbbbbbb");
    forgetSpawnedSession(stateDir, "aaaaaaa2");
    expect(readSpawnedSessions(stateDir)).toEqual([]);
    expect(existsSync(join(stateDir, "spawned-claude.json"))).toBe(false);
    // Forgetting never creates a state dir: a reaper outliving its
    // workspace's state must not bring it back.
    const missing = join(root, "state-never-made");
    forgetSpawnedSession(missing, "x");
    expect(existsSync(missing)).toBe(false);
  });
});

describeUnix("stopped sessions and resuming", () => {
  const rec = (id: string, extra: Partial<SpawnedSession> = {}): SpawnedSession =>
    ({ id, pid: 4242, name: "claude(ws-a-x)", startedAt: "t", lingerSec: 60, sessionId: `sess-${id}`, ...extra });

  test("a stopped session stays on record for a while, the latest only, and a running one supersedes it", () => {
    const stateDir = join(root, "state-stopped");
    const now = Date.parse("2026-09-19T12:00:00.000Z");
    recordSpawnedSession(stateDir, rec("aaaa1111"));
    expect(resumableSession(stateDir, 3600, now)).toBeNull(); // still running
    markSpawnedSessionStopped(stateDir, "aaaa1111", new Date(now - 30 * 60_000));
    expect(resumableSession(stateDir, 3600, now)?.id).toBe("aaaa1111");
    // Outside the window, or with resuming off, it is left alone.
    expect(resumableSession(stateDir, 600, now)).toBeNull();
    expect(resumableSession(stateDir, 0, now)).toBeNull();
    // A newer session, once stopped, replaces it: one to resume, not a history.
    recordSpawnedSession(stateDir, rec("bbbb2222", { pid: 4343 }));
    expect(readSpawnedSessions(stateDir).map((s) => s.id)).toEqual(["bbbb2222"]);
    markSpawnedSessionStopped(stateDir, "bbbb2222", new Date(now - 60_000));
    expect(resumableSession(stateDir, 3600, now)?.id).toBe("bbbb2222");
    // Nothing to resume by: the record goes.
    recordSpawnedSession(stateDir, rec("cccc3333", { pid: 4444, sessionId: null }));
    markSpawnedSessionStopped(stateDir, "cccc3333");
    expect(readSpawnedSessions(stateDir)).toEqual([]);
    // Unknown ids and a workspace with no records are no-ops.
    markSpawnedSessionStopped(stateDir, "nope");
    markSpawnedSessionStopped(join(root, "state-never"), "nope");
    expect(existsSync(join(root, "state-never"))).toBe(false);
  });

  test("a stopped record's pid never marks a live session as ours", () => {
    clearRegistry();
    register(`${sleeper.pid}.json`, { name: "someone-elses" });
    const stateDir = join(root, "state-stale-pid");
    // The pid a stopped session once had now belongs to another session.
    recordSpawnedSession(stateDir, rec("dddd4444", { pid: sleeper.pid!, procStart: sleeperStart }));
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned?.id).toBe("dddd4444");
    markSpawnedSessionStopped(stateDir, "dddd4444");
    expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned).toBeNull();
  });

  test("resuming continues the recorded conversation: `claude --bg --resume <session-id>`, a brief that says so, and the stopped record replaced", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-resume");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: true });
    const stateDir = join(root, "state-resume");
    recordSpawnedSession(stateDir, rec("eeee5555", { model: "sonnet", effort: "low" }));
    markSpawnedSessionStopped(stateDir, "eeee5555");
    try {
      const session = await spawnClaudeSession({
        cwd: wsA, stateDir, lingerSec: 60, claudeBin: fake.bin, startReaper: () => {},
        resume: resumableSession(stateDir, 3600)!, model: "sonnet", effort: "low",
      });
      const args = readFileSync(fake.argsLog, "utf-8").trimEnd().split("\n");
      expect(args.slice(0, 3)).toEqual(["--bg", "-n", spawnedSessionName(wsA)]);
      expect(args[args.indexOf("--resume") + 1]).toBe("sess-eeee5555");
      // A resumed session is a new process: mode, settings and the choice of
      // model are passed again, as for a new one.
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(args).toContain("--settings");
      expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
      expect(args[args.length - 1]).toBe(resumedSessionBrief());
      expect(args[args.length - 1]).toContain("your conversation so far is intact");
      // One record again: the running session, under its new job id.
      expect(readSpawnedSessions(stateDir)).toEqual([expect.objectContaining({ id: "deadbeef", pid: session.pid, model: "sonnet" })]);
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
    } finally {
      killSleeper(fake.pidFile);
    }
  });
});

describeUnix("spawn helpers", () => {
  test("parseBackgroundId reads claude --bg's announcement", () => {
    expect(parseBackgroundId("Starting background service…\nbackgrounded · f1c306d5 · codex-probe\n  claude agents")).toBe("f1c306d5");
    expect(parseBackgroundId("something else")).toBeNull();
    // With FORCE_COLOR set Claude Code colours the id even into a pipe, and
    // the session is running by then: unread, it would have no record.
    expect(parseBackgroundId("backgrounded · \x1b[36mf1c306d5\x1b[39m · codex-probe")).toBe("f1c306d5");
  });

  test("what a job's state file says: its session, and the work Claude Code counts in flight", () => {
    const jobs = join(root, "jobs-helpers");
    const previous = process.env.CODEX_COLLAB_JOBS_DIR;
    process.env.CODEX_COLLAB_JOBS_DIR = jobs;
    const job = (id: string, state: unknown) => {
      mkdirSync(join(jobs, id), { recursive: true });
      writeFileSync(join(jobs, id, "state.json"), JSON.stringify(state));
    };
    try {
      job("aaaa0001", { sessionId: "aaaa0001-0000-4000-8000-000000000000", inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 } });
      expect(jobSessionId("aaaa0001")).toBe("aaaa0001-0000-4000-8000-000000000000");
      expect(jobHasWorkInFlight("aaaa0001")).toBe(false);
      // A monitor or an MCP task leaves the registry saying idle; this is
      // where it shows.
      job("aaaa0002", { inFlight: { tasks: 1, queued: 0, kinds: ["monitor_mcp"], drainableMonitors: 0 } });
      expect(jobHasWorkInFlight("aaaa0002")).toBe(true);
      // Monitors Claude Code would drain on retiring the session do not hold it.
      job("aaaa0003", { inFlight: { tasks: 1, queued: 0, kinds: ["monitor_mcp"], drainableMonitors: 1 } });
      expect(jobHasWorkInFlight("aaaa0003")).toBe(false);
      job("aaaa0004", { inFlight: { tasks: 0, queued: 1, kinds: [] } });
      expect(jobHasWorkInFlight("aaaa0004")).toBe(true);
      // A session cron (a /loop, a scheduled wakeup) holds it with nothing running.
      job("aaaa0005", { inFlight: { tasks: 0, queued: 0, kinds: ["session_cron"] } });
      expect(jobHasWorkInFlight("aaaa0005")).toBe(true);
      // No file, no field, or a shape we do not know: no evidence either way.
      expect(jobHasWorkInFlight("aaaa0006")).toBe(false);
      job("aaaa0007", { state: "idle" });
      expect(jobHasWorkInFlight("aaaa0007")).toBe(false);
      expect(jobSessionId("aaaa0007")).toBeNull();
      expect(jobHasWorkInFlight("../../etc")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_COLLAB_JOBS_DIR;
      else process.env.CODEX_COLLAB_JOBS_DIR = previous;
    }
  });

  test("a model is a name `claude --model` can take, an effort one of Claude's levels, and a choice reads plainly", () => {
    for (const ok of ["haiku", "claude-opus-5", "claude-opus-5[1m]", "us.anthropic.claude-sonnet-5:0"]) expect(isModelName(ok)).toBe(true);
    for (const bad of ["", "rm -rf /", "opus;ls", "$(x)", 5, undefined]) expect(isModelName(bad)).toBe(false);
    expect(CLAUDE_EFFORTS.every(isClaudeEffort)).toBe(true);
    // Codex's levels that Claude has no name for.
    for (const bad of ["none", "minimal", "ultra", "", undefined]) expect(isClaudeEffort(bad)).toBe(false);
    expect(describeModelChoice()).toBe("the user's Claude Code default model and effort");
    expect(describeModelChoice("opus", "high")).toBe("opus, high effort");
    expect(describeModelChoice("haiku")).toBe("haiku, the user's Claude Code default effort");
    expect(describeModelChoice(undefined, "low")).toBe("the user's Claude Code default model, low effort");
    // `config spawn-effort`: unset is ours, `auto` is Claude Code's, and a
    // value that is no level (hand-edited) is ours as well.
    expect(DEFAULT_SPAWN_EFFORT).toBe("high");
    expect(spawnEffortFor(undefined)).toBe("high");
    expect(spawnEffortFor("xhigh")).toBe("xhigh");
    expect(spawnEffortFor("auto")).toBeUndefined();
    expect(spawnEffortFor("ultra")).toBe("high");
    for (const ok of [...CLAUDE_EFFORTS, "auto"]) expect(isSpawnEffortSetting(ok)).toBe(true);
    for (const bad of ["ultra", "", 3, undefined]) expect(isSpawnEffortSetting(bad)).toBe(false);
    // Most capable first, by alias: nothing here names a version.
    expect(CLAUDE_MODEL_TIERS.map((t) => t.alias)).toEqual(["fable", "opus", "sonnet"]);
  });

  test("the compaction window a started session takes is what Claude Code accepts", () => {
    // `claude --autocompact` takes auto, or 100k-1M as a number, `500k`, or
    // `500` as shorthand; anything else it refuses at the command line, which
    // would fail the spawn rather than start a session on the wrong window.
    for (const ok of ["auto", "500k", "500", "100k", "1000k", "200000", "1000000"]) expect(isAutocompactWindow(ok)).toBe(true);
    for (const bad of ["5000", "99k", "2000k", "2000000", "", "lots", "500kb", "-500k", 500000, null]) expect(isAutocompactWindow(bad)).toBe(false);
  });

  test("spawnedSessionName mirrors the front door's shape", () => {
    expect(spawnedSessionName(wsA)).toMatch(/^claude\(ws-a-[0-9a-f]{6}\)$/);
    expect(spawnedSessionName(join(wsA, "sub"))).toBe(spawnedSessionName(wsA));
  });

  test("spawnEnv drops the Claude child markers and Codex's command markers, nothing else", () => {
    const env = spawnEnv({
      PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_HARBOR_KITE: "1", CLAUDE_CODE_SESSION_ID: "x",
      CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_THREAD_ID: "0199-abc", CODEX_SESSION_ID: "0199-abc", CODEX_CI: "1", CODEX_HOME: "/h/.codex",
    });
    for (const k of CLAUDE_CHILD_MARKERS) expect(env[k]).toBeUndefined();
    for (const k of CODEX_COMMAND_MARKERS) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDE_CODE_HARBOR_KITE).toBe("1");
    // Where Codex keeps its config is the user's setting, not a marker.
    expect(env.CODEX_HOME).toBe("/h/.codex");
  });

  test("the brief names the workspace and asks for a reply by SendMessage", () => {
    const brief = spawnedSessionBrief("/work/repo");
    expect(brief).toContain("/work/repo");
    expect(brief).toContain("SendMessage");
  });
});

/** A fake `claude` on PATH: `--bg` announces an id and registers a live
 *  entry (backed by a sleeper it starts); `stop <id>` records the call.
 *  `onStop` runs after the record — what a real stop would do to the session,
 *  such as removing its entry. `jobSessionId` is written to the job's state
 *  file, as Claude Code writes the session a job runs. */
function installFakeClaude(dir: string, opts: { register: boolean; ticks?: boolean; onStop?: string; jobSessionId?: string; refuseAutocompact?: string; refuse?: string }): { bin: string; stopLog: string; pidFile: string; argsLog: string } {
  const stopLog = join(dir, "stop.log");
  const pidFile = join(dir, "sleeper.pid");
  // One argument per line, as `--bg` received them.
  const argsLog = join(dir, "args.log");
  const bin = join(dir, "claude");
  // `ticks`: the start time as Claude Code records it on Linux — field 22
  // of /proc/<pid>/stat, counted from the last ")" as the reader does.
  const startLine = opts.ticks
    ? `start=$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f20)`
    : `start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^ *//;s/ *$//')`;
  const registerBlock = opts.register
    ? `
    sleep 300 </dev/null >/dev/null 2>&1 &
    pid=$!
    echo "$pid" > "${pidFile}"
    ${startLine}
    printf '{"pid":%s,"sessionId":"s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.261","peerProtocol":1,"kind":"bg","entrypoint":"cli","messagingSocketPath":"/tmp/cc-socks/%s.sock","name":"%s","nameSource":"peer","status":"idle","updatedAt":%s,"statusUpdatedAt":%s}' \\
      "$pid" "$cwd" "$(date +%s)000" "$start" "$pid" "$name" "$(date +%s)000" "$(date +%s)000" > "$CODEX_COLLAB_SESSIONS_DIR/$pid.json"`
    : "";
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  --bg)
    name="$3"
    cwd="$(pwd)"
    for a in "$@"; do printf '%s\\n' "$a"; done > "${argsLog}"${opts.refuseAutocompact ? `
    for a in "$@"; do if [ "$a" = "--autocompact" ]; then echo '${opts.refuseAutocompact}' >&2; exit 1; fi; done` : ""}${opts.refuse ? `
    printf '%s\\n' '${opts.refuse}' >&2; exit 1` : ""}
    echo "Starting background service…"
    echo "backgrounded · deadbeef · $name"${opts.jobSessionId ? `
    mkdir -p "$CODEX_COLLAB_JOBS_DIR/deadbeef"
    printf '{"sessionId":"%s"}' "${opts.jobSessionId}" > "$CODEX_COLLAB_JOBS_DIR/deadbeef/state.json"` : ""}${registerBlock}
    ;;
  stop)
    echo "stop $2" >> "${stopLog}"
    ${opts.onStop ?? ""}
    ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, stopLog, pidFile, argsLog };
}

function killSleeper(pidFile: string): void {
  try { process.kill(Number(readFileSync(pidFile, "utf-8").trim()), "SIGTERM"); } catch { /* gone */ }
}

describeUnix("spawnClaudeSession", () => {
  test("starts the session, waits for its registration, records it, arms the reaper", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-ok");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: true });
    const stateDir = join(root, "state-spawn-ok");
    const reaped: Array<{ session: SpawnedSession; cwd: string }> = [];
    try {
      const session = await spawnClaudeSession({
        cwd: wsA, stateDir, lingerSec: 42, claudeBin: fake.bin,
        startReaper: (s, cwd) => reaped.push({ session: s, cwd }),
      });
      expect(session.name).toBe(spawnedSessionName(wsA));
      expect(session.kind).toBe("bg");
      expect(session.spawned).toEqual(expect.objectContaining({ id: "deadbeef", lingerSec: 42 }));
      expect(readSpawnedSessions(stateDir).map((s) => s.id)).toEqual(["deadbeef"]);
      expect(reaped).toHaveLength(1);
      expect(reaped[0].cwd).toBe(wsA);
      expect(reaped[0].session.id).toBe("deadbeef");
      // The workspace's listing now shows it as ours.
      expect(listClaudeSessions({ cwd: wsA, stateDir })[0].spawned?.id).toBe("deadbeef");
      // Started to do work: a mode that lets it act with nobody attached,
      // and — for this session alone — edits in the tree it shares with
      // Codex rather than parked in a worktree of its own, and compaction
      // that runs by itself, since nobody is there to run it by hand.
      const args = readFileSync(fake.argsLog, "utf-8").trimEnd().split("\n");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
      expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({ worktree: { bgIsolation: "none" }, autoCompactEnabled: true });
      // Compacts at a window it can afford rather than at the largest the
      // model allows: a long-lived session pays for its context every turn.
      expect(args[args.indexOf("--autocompact") + 1]).toBe("500k");
      // The name stays where `claude -n` reads it, and the brief comes last.
      expect(args.slice(0, 3)).toEqual(["--bg", "-n", spawnedSessionName(wsA)]);
      expect(args[args.length - 1]).toContain("started by codex-collab");
    } finally {
      killSleeper(fake.pidFile);
    }
  });

  test.skipIf(process.platform !== "linux")("a session that registers the way Claude Code does on Linux is found, and its recorded identity is the entry's own", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-ticks");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: true, ticks: true });
    const stateDir = join(root, "state-spawn-ticks");
    try {
      // Before the two representations were reconciled this timed out: the
      // entry's clock ticks never equalled `ps -o lstart=`.
      const session = await spawnClaudeSession({
        cwd: wsA, stateDir, lingerSec: 60, claudeBin: fake.bin, startReaper: () => {}, registerTimeoutMs: 5000,
      });
      expect(session.verified).toBe(true);
      const record = session.spawned!;
      expect(record.procStart).toMatch(/^\d+$/);
      // The reaper compares the record against the registry entry: recorded
      // in any other representation, every look would read "gone" and the
      // session would be forgotten without ever being stopped.
      const entry = JSON.parse(readFileSync(join(registry, `${session.pid}.json`), "utf-8"));
      expect(record.procStart).toBe(entry.procStart);
      expect(reaperVerdict(entry, session.pid, 3600, Date.now(), { procStart: record.procStart, sessionId: record.sessionId })).toBe("wait");
    } finally {
      killSleeper(fake.pidFile);
    }
  });

  test("a session that never registers is reported with how to look at it", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-silent");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: false });
    await expect(spawnClaudeSession({ cwd: wsA, stateDir: join(root, "state-spawn-silent"), claudeBin: fake.bin, registerTimeoutMs: 600, startReaper: () => {} }))
      .rejects.toThrow(/did not register.*claude logs deadbeef/s);
    // Nothing would ever reap it: it is stopped again right away.
    expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbeef\n");
  });

  test("the entry waited for is the new job's own session, whatever else wears its name", async () => {
    clearRegistry();
    // Another entry under the same name, listed ahead of the new one — a
    // session this workspace started earlier that Claude Code brought back.
    register(`${sleeper.pid}.json`, { name: spawnedSessionName(wsA), kind: "interactive", sessionId: "00000000-0000-4000-8000-00000000dead" });
    const dir = join(root, "fake-claude-job-session");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: true, jobSessionId: "s" });
    try {
      const session = await spawnClaudeSession({
        cwd: wsA, stateDir: join(root, "state-spawn-job"), lingerSec: 60, claudeBin: fake.bin, startReaper: () => {}, registerTimeoutMs: 5000,
      });
      expect(session.sessionId).toBe("s");
      expect(session.pid).not.toBe(sleeper.pid);
      expect(session.spawned?.sessionId).toBe("s");
    } finally {
      killSleeper(fake.pidFile);
    }
  });

  test("a Claude Code without --autocompact starts the session without it; another failure is not taken for that", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-old");
    mkdirSync(dir, { recursive: true });
    const old = installFakeClaude(dir, { register: true, refuseAutocompact: "error: unknown option '--autocompact'" });
    try {
      const session = await spawnClaudeSession({ cwd: wsA, stateDir: join(root, "state-spawn-old"), lingerSec: 60, claudeBin: old.bin, startReaper: () => {}, registerTimeoutMs: 5000 });
      expect(session.spawned?.id).toBe("deadbeef");
      expect(readFileSync(old.argsLog, "utf-8").split("\n")).not.toContain("--autocompact");
    } finally {
      killSleeper(old.pidFile);
    }
    // The settings on the same command line say autoCompactEnabled: an error
    // that echoes them is some other failure, and is reported as itself.
    clearRegistry();
    const dir2 = join(root, "fake-claude-bad-settings");
    mkdirSync(dir2, { recursive: true });
    const bad = installFakeClaude(dir2, { register: true, refuseAutocompact: "Invalid settings: autoCompactEnabled is not allowed here" });
    try {
      await expect(spawnClaudeSession({ cwd: wsA, stateDir: join(root, "state-spawn-bad"), lingerSec: 60, claudeBin: bad.bin, startReaper: () => {}, registerTimeoutMs: 5000 }))
        .rejects.toThrow(/Invalid settings: autoCompactEnabled/);
      expect(readFileSync(bad.argsLog, "utf-8").split("\n")).toContain("--autocompact");
    } finally {
      killSleeper(bad.pidFile);
    }
  });

  test("a folder Claude Code has not trusted is refused with the folder and the reason, and nothing is recorded", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-untrusted");
    mkdirSync(dir, { recursive: true });
    // What Claude Code 2.1.281 prints for `claude --bg` in such a folder.
    const said = `Workspace not trusted. Run \`claude\` in ${wsA} once and accept the trust prompt, then retry.`;
    const fake = installFakeClaude(dir, { register: false, refuse: said });
    const stateDir = join(root, "state-spawn-untrusted");
    const refused = spawnClaudeSession({ cwd: wsA, stateDir, lingerSec: 60, claudeBin: fake.bin, startReaper: () => {}, registerTimeoutMs: 5000 });
    await expect(refused).rejects.toBeInstanceOf(WorkspaceNotTrustedError);
    // Named as it is on disk — as Claude Code names it — which on macOS is
    // under /private: /var, where the temp folders are, links there.
    await expect(refused).rejects.toThrow(`Claude Code will not start a session in ${realpathSync(wsA)}, because the folder is not trusted.`);
    await expect(refused).rejects.toThrow("only they can agree to that, in a terminal");
    await expect(refused).rejects.toThrow(`Claude Code says: ${said}`);
    expect(readSpawnedSessions(stateDir)).toEqual([]);
  });

  test("a missing claude binary is a plain message, not a stack", async () => {
    await expect(spawnClaudeSession({ cwd: wsA, stateDir: join(root, "state-spawn-none"), claudeBin: join(root, "no-such-claude"), startReaper: () => {} }))
      .rejects.toThrow(/`claude` is not on PATH/);
  });
});

describeUnix("reaper", () => {
  const idleEntry = (pid: number, extra: Record<string, unknown>) => ({
    pid, procStart: sleeperStart, status: "idle", ...extra,
  });

  test("reaperVerdict: gone, wait, stop", () => {
    const now = 1_000_000_000;
    const pid = sleeper.pid!;
    expect(reaperVerdict(null, pid, 60, now)).toBe("gone");
    expect(reaperVerdict({ pid: pid + 1 }, pid, 60, now)).toBe("gone");
    expect(reaperVerdict({ pid: 999999, procStart: "x" }, 999999, 60, now)).toBe("gone");
    expect(reaperVerdict(idleEntry(pid, { status: "busy", statusUpdatedAt: now - 10_000_000 }), pid, 60, now)).toBe("wait");
    // `shell`: Claude Code's word for idle with a command of its own still
    // running — the background command a turn left behind. Reading it as
    // idleness stopped sessions in the middle of their work.
    expect(reaperVerdict(idleEntry(pid, { status: "shell", statusUpdatedAt: now - 10_000_000 }), pid, 60, now)).toBe("wait");
    // A status from a Claude Code we do not know is not evidence of idleness.
    expect(reaperVerdict(idleEntry(pid, { status: "idle_background", statusUpdatedAt: now - 10_000_000 }), pid, 60, now)).toBe("wait");
    // At a prompt nobody will answer, it is doing nothing: that is reapable.
    expect(reaperVerdict(idleEntry(pid, { status: "waiting", statusUpdatedAt: now - 60_000 }), pid, 60, now)).toBe("stop");
    expect(reaperVerdict(idleEntry(pid, { statusUpdatedAt: now - 30_000 }), pid, 60, now)).toBe("wait");
    expect(reaperVerdict(idleEntry(pid, { statusUpdatedAt: now - 60_000 }), pid, 60, now)).toBe("stop");
    // No status timestamp: idle since it registered.
    expect(reaperVerdict(idleEntry(pid, { startedAt: now - 61_000 }), pid, 60, now)).toBe("stop");
    expect(reaperVerdict(idleEntry(pid, {}), pid, 60, now)).toBe("wait");
    // Another session registered under a recycled pid is not ours.
    expect(reaperVerdict(idleEntry(pid, { statusUpdatedAt: now - 60_000 }), pid, 60, now, { procStart: "Mon Jan  1 00:00:00 2001" })).toBe("gone");
    expect(reaperVerdict(idleEntry(pid, { statusUpdatedAt: now - 60_000, sessionId: "other" }), pid, 60, now, { sessionId: "mine" })).toBe("gone");
    expect(reaperVerdict(idleEntry(pid, { statusUpdatedAt: now - 60_000, sessionId: "mine" }), pid, 60, now, { procStart: sleeperStart, sessionId: "mine" })).toBe("stop");
  });

  test("runReaper stops an idle session through `claude stop` and forgets it", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-reap");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: false });
    const stateDir = join(root, "state-reap");
    // Its own process: the fake `claude stop` only logs, so the reaper's
    // confirming look finds it still registered and signals it.
    const own = spawn("sleep", ["300"], { stdio: "ignore" });
    const exited = new Promise((r) => own.on("exit", r));
    await new Promise((r) => setTimeout(r, 50));
    const ownStart = procStartOf(own.pid!);
    const session: SpawnedSession = {
      id: "deadbeef", pid: own.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: ownStart, sessionId: "00000000-0000-4000-8000-000000000001",
    };
    recordSpawnedSession(stateDir, session);
    register(`${own.pid}.json`, { pid: own.pid, procStart: ownStart, kind: "bg", statusUpdatedAt: Date.now() - 5000 });
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
    expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbeef\n");
    // Stopped, not forgotten: Claude Code keeps the conversation, and the
    // record is what lets the next `send` resume it.
    const [kept] = readSpawnedSessions(stateDir);
    expect(kept).toEqual(expect.objectContaining({ id: "deadbeef", sessionId: session.sessionId }));
    expect(Date.parse(kept.stoppedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(resumableSession(stateDir, 3600)?.id).toBe("deadbeef");
    await exited;
  });

  test("a session listed on its socket alone is stopped by id, never signalled", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-foreign");
    mkdirSync(dir, { recursive: true });
    const stateDir = join(root, "state-reap-foreign");
    // Stands in for whatever process owns this pid number in OUR domain: the
    // session itself lives in another one, where the number means something
    // else. It must survive the reaper.
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    // A real `claude stop` ends the session, and its entry goes with it.
    const fake = installFakeClaude(dir, { register: false, onStop: `rm -f '${join(registry, `${bystander.pid}.json`)}'` });
    const socket = join(root, "foreign-reap.sock");
    writeFileSync(socket, "");
    const session: SpawnedSession = {
      id: "deadbeef", pid: bystander.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: "236353382", sessionId: "00000000-0000-4000-8000-000000000001",
    };
    recordSpawnedSession(stateDir, session);
    register(`${bystander.pid}.json`, {
      pid: bystander.pid, procStart: "236353382", pidDomain: "linux:m:pid:[4026531836]",
      messagingSocketPath: socket, statusUpdatedAt: Date.now() - 5000,
    });
    setProcProbesForTests({ ownDomain: () => "linux:m:pid:[4026533467]" });
    try {
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
      // Asked to stop by id — the one handle that means the same everywhere —
      // and no signal for a pid it cannot verify.
      expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbeef\n");
      expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    } finally {
      setProcProbesForTests(null);
      bystander.kill();
    }
  });

  test("a stop that did not take is not recorded as one, and is tried again", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-stop-fails");
    mkdirSync(dir, { recursive: true });
    // `claude stop` that does nothing, for a session in another pid domain:
    // no signal can be sent, and the session stays.
    const fake = installFakeClaude(dir, { register: false });
    const stateDir = join(root, "state-reap-stop-fails");
    const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const socket = join(root, "stop-fails.sock");
    writeFileSync(socket, "");
    const session: SpawnedSession = {
      id: "deadbeef", pid: bystander.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: "236353382", sessionId: "00000000-0000-4000-8000-000000000001",
    };
    recordSpawnedSession(stateDir, session);
    register(`${bystander.pid}.json`, {
      pid: bystander.pid, procStart: "236353382", pidDomain: "linux:m:pid:[4026531836]",
      messagingSocketPath: socket, statusUpdatedAt: Date.now() - 5000,
    });
    setProcProbesForTests({ ownDomain: () => "linux:m:pid:[4026533467]" });
    try {
      await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 2 });
      // Marked stopped while it runs, it would read as the user's own session.
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
      expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbeef\nstop deadbeef\n");
    } finally {
      setProcProbesForTests(null);
      bystander.kill();
    }
  });

  test("a session Claude Code brought back under a new pid is followed, recorded under it, and stopped once idle", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-respawned");
    mkdirSync(dir, { recursive: true });
    const stateDir = join(root, "state-reap-respawned");
    const sid = "00000000-0000-4000-8000-000000000003";
    // The process it was recorded under has exited…
    const before = spawn("true", [], { stdio: "ignore" });
    await new Promise((r) => before.on("exit", r));
    // …and the same session runs on as another one.
    const now = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const nowStart = procStartOf(now.pid!);
    const fake = installFakeClaude(dir, { register: false, onStop: `rm -f '${join(registry, `${now.pid}.json`)}'` });
    const session: SpawnedSession = {
      id: "deadbee3", pid: before.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: "1", sessionId: sid,
    };
    recordSpawnedSession(stateDir, session);
    const entry = { pid: now.pid, procStart: nowStart, sessionId: sid, name: "claude(ws-a-x)", kind: "bg", jobId: "deadbee3" };
    try {
      register(`${now.pid}.json`, { ...entry, status: "busy", statusUpdatedAt: Date.now() });
      await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 });
      // Not taken for gone: still running, under the pid it has now.
      const [followed] = readSpawnedSessions(stateDir);
      expect(followed).toEqual(expect.objectContaining({ id: "deadbee3", pid: now.pid, procStart: nowStart }));
      expect(followed.stoppedAt).toBeUndefined();
      expect(existsSync(fake.stopLog)).toBe(false);
      // Idle past its linger, it is stopped like any other.
      register(`${now.pid}.json`, { ...entry, status: "idle", statusUpdatedAt: Date.now() - 5000 });
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
      expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbee3\n");
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeDefined();
    } finally {
      now.kill();
    }
  });

  test("the user's own session continuing the conversation is never followed, listed as ours, or signalled", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-user-resumed");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: false });
    const stateDir = join(root, "state-reap-user-resumed");
    const sid = "00000000-0000-4000-8000-000000000006";
    // The session codex-collab started was stopped outside codex-collab, and
    // the user picked its conversation up in a terminal: same session id.
    const before = spawn("true", [], { stdio: "ignore" });
    await new Promise((r) => before.on("exit", r));
    const users = spawn("sleep", ["300"], { stdio: "ignore" });
    const signalled = new Promise((r) => users.on("exit", () => r(true)));
    await new Promise((r) => setTimeout(r, 50));
    const session: SpawnedSession = {
      id: "deadbee6", pid: before.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: "1", sessionId: sid,
    };
    recordSpawnedSession(stateDir, session);
    register(`${users.pid}.json`, { pid: users.pid, procStart: procStartOf(users.pid!), sessionId: sid, name: "the-users-own", kind: "interactive", status: "idle", statusUpdatedAt: Date.now() - 600_000 });
    try {
      expect(listClaudeSessions({ cwd: wsA, stateDir }).find((s) => s.name === "the-users-own")?.spawned).toBeNull();
      // Ours is gone; theirs is left alone.
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 6 })).toBe("gone");
      expect(existsSync(fake.stopLog)).toBe(false);
      expect(await Promise.race([signalled, new Promise((r) => setTimeout(() => r(false), 200))])).toBe(false);
    } finally {
      users.kill();
    }
  });

  test("at its real poll, the reaper records a stop it made", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-real-poll");
    mkdirSync(dir, { recursive: true });
    const stateDir = join(root, "state-reap-real-poll");
    const own = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const ownStart = procStartOf(own.pid!);
    const fake = installFakeClaude(dir, { register: false, onStop: `rm -f '${join(registry, `${own.pid}.json`)}'` });
    const session: SpawnedSession = {
      id: "deadbee8", pid: own.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: ownStart, sessionId: "00000000-0000-4000-8000-000000000008",
    };
    recordSpawnedSession(stateDir, session);
    register(`${own.pid}.json`, { pid: own.pid, procStart: ownStart, sessionId: session.sessionId, kind: "bg", status: "idle", statusUpdatedAt: Date.now() - 600_000 });
    try {
      // Polling ten seconds apart, as the reaper does: stopped, and recorded
      // as stopped at once — the next `send` resumes it.
      expect(await runReaper(session, stateDir, { pollMs: 10_000, claudeBin: fake.bin, maxRounds: 1 })).toBe("stopped");
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeDefined();
    } finally {
      own.kill();
    }
  }, 30_000);

  test("a session that had to be signalled is not stopped if Claude Code brings it back", async () => {
    clearRegistry();
    const sid = "00000000-0000-4000-8000-000000000009";
    const first = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const firstStart = procStartOf(first.pid!);
    const session: SpawnedSession = {
      id: "deadbee9", pid: first.pid!, name: "claude(ws-a-x)", startedAt: new Date().toISOString(), lingerSec: 1,
      procStart: firstStart, sessionId: sid,
    };
    register(`${first.pid}.json`, { pid: first.pid, procStart: firstStart, sessionId: sid, kind: "bg", jobId: "deadbee9", status: "waiting" });
    let second: ChildProcess | null = null;
    try {
      // No `claude` to ask: a signal, which Claude Code takes for a crash —
      // and it brings the job back as a new process.
      const stopping = stopSpawnedSession(session, { claudeBin: "/nonexistent", confirmAfterMs: 20, spacingMs: 20 });
      await new Promise((r) => setTimeout(r, 150));
      second = spawn("sleep", ["300"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 50));
      register(`${second.pid}.json`, { pid: second.pid, procStart: procStartOf(second.pid!), sessionId: sid, kind: "bg", jobId: "deadbee9", status: "waiting" });
      expect(await stopping).toEqual({ gone: false, signalled: true });
    } finally {
      first.kill();
      second?.kill();
    }
  });

  test("a reaper whose record another has stopped or replaced leaves", async () => {
    clearRegistry();
    const stateDir = join(root, "state-reap-replaced");
    // Whatever answers to that session now: idle past the linger and past the
    // cap, so a reaper still at work would stop it — by signal, `claude` being
    // unavailable.
    const now = spawn("sleep", ["300"], { stdio: "ignore" });
    const signalled = new Promise((r) => now.on("exit", () => r(true)));
    await new Promise((r) => setTimeout(r, 50));
    const nowStart = procStartOf(now.pid!);
    const session: SpawnedSession = {
      id: "deadbee7", pid: now.pid!, name: "claude(ws-a-x)", startedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), lingerSec: 1,
      procStart: nowStart, sessionId: "00000000-0000-4000-8000-000000000007",
    };
    recordSpawnedSession(stateDir, session);
    register(`${now.pid}.json`, { pid: now.pid, procStart: nowStart, sessionId: session.sessionId, kind: "bg", status: "idle", statusUpdatedAt: Date.now() - 600_000 });
    try {
      // `peers stop`, or a task that found it at a prompt, stopped it.
      markSpawnedSessionStopped(stateDir, "deadbee7");
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 3 })).toBe("gone");
      expect(await Promise.race([signalled, new Promise((r) => setTimeout(() => r(false), 200))])).toBe(false);
    } finally {
      now.kill();
    }
  });

  test("work Claude Code counts in flight holds a session the registry calls idle, at its linger and at its cap", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-inflight");
    mkdirSync(dir, { recursive: true });
    const stateDir = join(root, "state-reap-inflight");
    const own = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const ownStart = procStartOf(own.pid!);
    const fake = installFakeClaude(dir, { register: false, onStop: `rm -f '${join(registry, `${own.pid}.json`)}'` });
    const session: SpawnedSession = {
      id: "deadbee4", pid: own.pid!, name: "claude(ws-a-x)", startedAt: new Date(Date.now() - (SPAWN_MAX_LIFETIME_SEC + 60) * 1000).toISOString(),
      lingerSec: 1, procStart: ownStart, sessionId: "00000000-0000-4000-8000-000000000004",
    };
    recordSpawnedSession(stateDir, session);
    register(`${own.pid}.json`, { pid: own.pid, procStart: ownStart, sessionId: session.sessionId, status: "idle", statusUpdatedAt: Date.now() - 600_000 });
    const inFlight = (state: Record<string, unknown>) => {
      mkdirSync(join(jobs, "deadbee4"), { recursive: true });
      writeFileSync(join(jobs, "deadbee4", "state.json"), JSON.stringify({ inFlight: state }));
    };
    try {
      // A monitor it set, which the registry does not show.
      inFlight({ tasks: 1, queued: 0, kinds: ["monitor_mcp"], drainableMonitors: 0 });
      await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 });
      expect(existsSync(fake.stopLog)).toBe(false);
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
      // Nothing in flight any more: reaped.
      inFlight({ tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 });
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
    } finally {
      own.kill();
    }
  });

  test("the lifetime cap stops a session its linger never reaches, and never one that is busy", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-cap");
    mkdirSync(dir, { recursive: true });
    const stateDir = join(root, "state-reap-cap");
    const own = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const ownStart = procStartOf(own.pid!);
    const fake = installFakeClaude(dir, { register: false, onStop: `rm -f '${join(registry, `${own.pid}.json`)}'` });
    // An hour's linger that was never reached, four hours after it started.
    const session: SpawnedSession = {
      id: "deadbee5", pid: own.pid!, name: "claude(ws-a-x)", startedAt: new Date(Date.now() - (SPAWN_MAX_LIFETIME_SEC + 60) * 1000).toISOString(),
      lingerSec: 3600, procStart: ownStart, sessionId: "00000000-0000-4000-8000-000000000005",
    };
    recordSpawnedSession(stateDir, session);
    const entry = { pid: own.pid, procStart: ownStart, sessionId: session.sessionId, statusUpdatedAt: Date.now() - 5000 };
    try {
      register(`${own.pid}.json`, { ...entry, status: "busy" });
      await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 });
      expect(existsSync(fake.stopLog)).toBe(false);
      register(`${own.pid}.json`, { ...entry, status: "idle" });
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
      expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbee5\n");
    } finally {
      own.kill();
    }
  });

  test("a session a task is still waiting on is never reaped for idling, nor at its lifetime cap", async () => {
    clearRegistry();
    const dir = join(root, "fake-claude-owed");
    mkdirSync(dir, { recursive: true });
    const fake = installFakeClaude(dir, { register: false });
    const stateDir = join(root, "state-owed");
    const own = spawn("sleep", ["300"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 50));
    const ownStart = procStartOf(own.pid!);
    const session: SpawnedSession = {
      id: "deadbee2", pid: own.pid!, name: "claude(ws-a-x)", startedAt: new Date(Date.now() - (SPAWN_MAX_LIFETIME_SEC + 60) * 1000).toISOString(),
      lingerSec: 1, procStart: ownStart, sessionId: "00000000-0000-4000-8000-000000000002",
    };
    recordSpawnedSession(stateDir, session);
    // Idle long past its linger, and started long past its lifetime cap: on
    // both counts the reaper would stop it.
    register(`${own.pid}.json`, { pid: own.pid, procStart: ownStart, sessionId: session.sessionId, kind: "bg", statusUpdatedAt: Date.now() - 600_000 });
    const target = { pid: own.pid!, socketPath: "/s", sessionId: session.sessionId!, procStart: ownStart, spawned: session, name: session.name };
    const task = createTask(stateDir, { cwd: wsA, threadId: null, message: "long job", target, maxWaitSec: 3600 });
    updateTask(stateDir, task.id, { status: "running", deliveredAt: new Date().toISOString(), receiver: { pid: process.pid, procStart: null, pidDomain: null } });
    try {
      // The session ended its turn — Claude Code calls that idle — with the
      // work still running and the reply still owed.
      // Three rounds of waiting, then the loop runs out: nothing was stopped,
      // nothing was signalled, and the record still reads as running.
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("gone");
      expect(existsSync(fake.stopLog)).toBe(false);
      try { process.kill(own.pid!, 0); } catch { throw new Error("the session was signalled"); }
      expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
      // Once the task is over, the same session is reaped as before.
      updateTask(stateDir, task.id, { status: "replied", finishedAt: new Date().toISOString() });
      expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
      expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbee2\n");
    } finally {
      try { process.kill(own.pid!, "SIGKILL"); } catch { /* gone */ }
      killSleeper(fake.pidFile);
    }
  });

  test("runReaper waits while the session is busy, and exits once it is gone — on several looks, not one", async () => {
    clearRegistry();
    const stateDir = join(root, "state-reap-busy");
    const session: SpawnedSession = {
      id: "deadbeef", pid: sleeper.pid!, name: "claude(ws-a-x)", startedAt: "t", lingerSec: 1,
      procStart: sleeperStart, sessionId: "00000000-0000-4000-8000-000000000001",
    };
    recordSpawnedSession(stateDir, session);
    register(`${sleeper.pid}.json`, { status: "busy", statusUpdatedAt: Date.now() - 5000 });
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 2 })).toBe("gone");
    // Still recorded: the rounds ran out with it busy, nothing was stopped.
    expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
    clearRegistry();
    // Claude Code rewrites an entry in place, and brings a lost background
    // session back after ten seconds: missing for a few looks is a moment,
    // and gone is final for the reaper.
    await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 3 });
    expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeUndefined();
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 4 })).toBe("gone");
    expect(readSpawnedSessions(stateDir)[0].stoppedAt).toBeDefined();
  });

  test("an entry caught half written reads as the entry", () => {
    clearRegistry();
    const file = join(registry, `${sleeper.pid}.json`);
    register(`${sleeper.pid}.json`, { status: "busy" });
    const whole = readFileSync(file, "utf-8");
    // Truncated, as Claude Code's rewrite leaves it for a moment, and written
    // back while the reader is still looking.
    writeFileSync(file, "");
    spawn("sh", ["-c", `printf '%s' '${whole.replace(/'/g, "'\\''")}' > '${file}'`], { stdio: "ignore" });
    expect(sessionStatusNow(sleeper.pid!)).toBe("busy");
  });

  test("the default linger is half an hour", () => {
    expect(DEFAULT_SPAWN_LINGER_SEC).toBe(1800);
  });
});
