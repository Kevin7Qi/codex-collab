// src/claude-sessions.test.ts — listing, spawning, and reaping Claude Code sessions
//
// The registry is a fake under CODEX_COLLAB_SESSIONS_DIR; "live" sessions
// are backed by a sleeping child of this test, so liveness and start-time
// checks run for real. Nothing here touches the user's registry or starts
// a real `claude`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { buildRegistryEntry, procStartOf } from "./peer";
import { config, mailboxRoot } from "./config";
import {
  CLAUDE_CHILD_MARKERS,
  CODEX_COMMAND_MARKERS,
  DEFAULT_SPAWN_LINGER_SEC,
  forgetSpawnedSession,
  listClaudeSessions,
  parseBackgroundId,
  readSpawnedSessions,
  reaperVerdict,
  recordSpawnedSession,
  resolveSession,
  runReaper,
  spawnClaudeSession,
  spawnEnv,
  spawnedSessionBrief,
  spawnedSessionName,
  setProcStartReaderForTests,
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

beforeAll(async () => {
  if (onWindows) return;
  root = mkdtempSync(join(tmpdir(), "cc-sessions-"));
  registry = join(root, "sessions");
  wsA = join(root, "ws-a");
  wsB = join(root, "ws-b");
  for (const d of [registry, wsA, join(wsA, "sub"), wsB]) mkdirSync(d, { recursive: true });
  // A workspace is a git checkout: its subdirectories resolve to its root.
  spawnSync("git", ["init", "-q", wsA]);
  process.env.CODEX_COLLAB_SESSIONS_DIR = registry;
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

  test("entries that cannot be messaged are left out", () => {
    clearRegistry();
    // No socket: an older Claude Code, or a record of another kind.
    register(`${sleeper.pid}.json`, { messagingSocketPath: undefined });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    // codex-collab's own registrations (a broker, a thread peer, a send).
    register(`${sleeper.pid}.json`, { messagingSocketPath: join(config.dataDir, "workspaces", "x", "peer.sock") });
    expect(listClaudeSessions({ cwd: wsA })).toEqual([]);
    register(`${sleeper.pid}.json`, { messagingSocketPath: join(mailboxRoot(), "send-123.sock") });
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
    recordSpawnedSession(stateDir, { id: "abc12345", pid: sleeper.pid!, name: "claude(ws-a-abc123)", startedAt: "2026-09-13T00:00:00.000Z", lingerSec: 60 });
    const [s] = listClaudeSessions({ cwd: wsA, stateDir });
    expect(s.spawned?.id).toBe("abc12345");
    expect(listClaudeSessions({ cwd: wsA })[0].spawned).toBeNull();
  });
});

describeUnix("resolveSession", () => {
  const sessions = ["Explore messaging", "explore-two", "claude(ws-a-abc123)"].map((name) => ({
    pid: 1, name, status: "idle" as const, kind: "interactive", cwd: "/", socketPath: "/s", sessionId: null, statusUpdatedAt: null, spawned: null,
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

describeUnix("spawn helpers", () => {
  test("parseBackgroundId reads claude --bg's announcement", () => {
    expect(parseBackgroundId("Starting background service…\nbackgrounded · f1c306d5 · codex-probe\n  claude agents")).toBe("f1c306d5");
    expect(parseBackgroundId("something else")).toBeNull();
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
 *  entry (backed by a sleeper it starts); `stop <id>` records the call. */
function installFakeClaude(dir: string, opts: { register: boolean }): { bin: string; stopLog: string; pidFile: string } {
  const stopLog = join(dir, "stop.log");
  const pidFile = join(dir, "sleeper.pid");
  const bin = join(dir, "claude");
  const registerBlock = opts.register
    ? `
    sleep 300 </dev/null >/dev/null 2>&1 &
    pid=$!
    echo "$pid" > "${pidFile}"
    start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^ *//;s/ *$//')
    printf '{"pid":%s,"sessionId":"s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.261","peerProtocol":1,"kind":"bg","entrypoint":"cli","messagingSocketPath":"/tmp/cc-socks/%s.sock","name":"%s","nameSource":"peer","status":"idle","updatedAt":%s,"statusUpdatedAt":%s}' \\
      "$pid" "$cwd" "$(date +%s)000" "$start" "$pid" "$name" "$(date +%s)000" "$(date +%s)000" > "$CODEX_COLLAB_SESSIONS_DIR/$pid.json"`
    : "";
  writeFileSync(bin, `#!/bin/sh
case "$1" in
  --bg)
    name="$3"
    cwd="$(pwd)"
    echo "Starting background service…"
    echo "backgrounded · deadbeef · $name"${registerBlock}
    ;;
  stop)
    echo "stop $2" >> "${stopLog}"
    ;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, stopLog, pidFile };
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
    register(`${own.pid}.json`, { pid: own.pid, procStart: ownStart, statusUpdatedAt: Date.now() - 5000 });
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: fake.bin, maxRounds: 3 })).toBe("stopped");
    expect(readFileSync(fake.stopLog, "utf-8")).toBe("stop deadbeef\n");
    expect(readSpawnedSessions(stateDir)).toEqual([]);
    await exited;
  });

  test("runReaper waits while the session is busy, and exits once it is gone", async () => {
    clearRegistry();
    const stateDir = join(root, "state-reap-busy");
    const session: SpawnedSession = { id: "deadbeef", pid: sleeper.pid!, name: "claude(ws-a-x)", startedAt: "t", lingerSec: 1 };
    recordSpawnedSession(stateDir, session);
    register(`${sleeper.pid}.json`, { status: "busy", statusUpdatedAt: Date.now() - 5000 });
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 2 })).toBe("gone");
    // Still recorded: the rounds ran out with it busy, nothing was stopped.
    expect(readSpawnedSessions(stateDir)).toHaveLength(1);
    clearRegistry();
    expect(await runReaper(session, stateDir, { pollMs: 10, claudeBin: "/nonexistent", maxRounds: 2 })).toBe("gone");
    expect(readSpawnedSessions(stateDir)).toEqual([]);
  });

  test("the default linger is half an hour", () => {
    expect(DEFAULT_SPAWN_LINGER_SEC).toBe(1800);
  });
});
