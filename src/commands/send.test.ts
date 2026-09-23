// src/commands/send.test.ts — `send` and `peers` against a fake Claude Code session
//
// The fake session is a unix socket served by this test process, registered
// (under this process's pid) in an isolated registry; the CLI runs as a
// subprocess against an isolated HOME, so its task records, and its
// receiver's transient registration and socket, never touch the real ones.
// The reply leg is exercised for real: the fake connects back to the address
// the receiver advertised.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildEnvelope, buildRegistryEntry, parseEnvelope, procStartOf, workspaceSuffix } from "../peer";
import { spawnedSessionName } from "../claude-sessions";
import { codexThreadId, composeMessage, insideCodexSandbox, senderName, splitTarget, watchForLost, watchForStalledTurn } from "./send";
import { formatSessions, unverifiedNotice, whereItLives } from "./peers";

const CLI = join(import.meta.dir, "..", "cli.ts");
const TEST_HOME = mkdtempSync(join(tmpdir(), "codex-collab-send-home-"));
const REGISTRY = join(TEST_HOME, "sessions");
const WS = join(TEST_HOME, "ws");
const THREAD = "01a0985a-445b-7ee2-85b5-52e2b36a6ba4";

// Unix sockets, sleep, ps and sh fakes: none of it exists on Windows, where
// Claude Code has no cross-session messaging for `send` to ride on anyway.
const describeUnix = process.platform === "win32" ? describe.skip : describe;
// Each case spawns the CLI; the reaper cases also wait out a linger.
setDefaultTimeout(30_000);

interface FakeSession {
  name: string;
  socketPath: string;
  received: Array<{ fromName: string; replyPath: string; text: string }>;
  reply: ((text: string) => string | null) | null;
  server: ReturnType<typeof Bun.listen>;
  entryPath: string;
  stop(): void;
}

let fakes: FakeSession[] = [];
let n = 0;

/** A fake Claude session: registered, listening, replying (unless told not
 *  to) by connecting back to the sender's advertised address. */
function startFake(name: string, opts: { reply?: ((text: string) => string | null) | null; cwd?: string; status?: string; kind?: string } = {}): FakeSession {
  const socketPath = join(tmpdir(), `cc-fake-${process.pid}-${++n}.sock`);
  try { unlinkSync(socketPath); } catch { /* none */ }
  const fake: FakeSession = {
    name,
    socketPath,
    received: [],
    reply: opts.reply === undefined ? (t) => `pong: ${t.split("\n")[0]}` : opts.reply,
    server: null as unknown as ReturnType<typeof Bun.listen>,
    entryPath: join(REGISTRY, `${process.pid}.json`),
    stop() {
      try { this.server.stop(true); } catch { /* stopped */ }
      try { unlinkSync(socketPath); } catch { /* gone */ }
      try { unlinkSync(this.entryPath); } catch { /* gone */ }
    },
  };
  let buffer = "";
  fake.server = Bun.listen({
    unix: socketPath,
    socket: {
      data(_sock, chunk) {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseEnvelope(line);
          if (!msg) continue;
          fake.received.push({ fromName: msg.fromName, replyPath: msg.replyPath, text: msg.text });
          const answer = fake.reply ? fake.reply(msg.text) : null;
          if (answer !== null) {
            const out = Bun.connect({
              unix: msg.replyPath,
              socket: {
                open(s) {
                  s.write(buildEnvelope({ text: answer, ourSocketPath: socketPath, ourName: name, mode: "prompting" }));
                  s.end();
                },
                data() {},
                error() {},
              },
            });
            void out;
          }
        }
      },
      open() {},
      error() {},
    },
  });
  fakes.push(fake);
  return fake;
}

/** Register `fake` under a live process of its own (a sleeper), so several
 *  fakes can coexist with filename === pid. */
function registerFake(fake: FakeSession, opts: { cwd?: string; status?: string; kind?: string } = {}): void {
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  sleepers.push(sleeper);
  const pid = sleeper.pid!;
  // ps needs a moment before it reports the child.
  const start = procStartOf(pid);
  fake.entryPath = join(REGISTRY, `${pid}.json`);
  writeFileSync(fake.entryPath, JSON.stringify({
    ...buildRegistryEntry({
      pid,
      cwd: opts.cwd ?? WS,
      name: fake.name,
      socketPath: fake.socketPath,
      version: "2.1.261",
      procStart: start,
      sessionId: "00000000-0000-4000-8000-0000000000aa",
    }),
    status: opts.status ?? "idle",
    kind: opts.kind ?? "interactive",
  }));
}

const sleepers: ReturnType<typeof spawn>[] = [];

/** The CLI's environment: isolated HOME and registry, no sandbox markers
 *  unless a test sets them, Codex's thread id as Codex would pass it. */
function cliEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.CODEX_SANDBOX;
  delete env.CODEX_SANDBOX_NETWORK_DISABLED;
  // Fast polls: a receiver left waiting by one test sees its session gone,
  // and ends, within a moment of that test's cleanup.
  // A session that had to be signalled must stay gone past Claude Code's
  // restart window before it counts as stopped: a moment, here, not half a
  // minute.
  return { ...env, HOME: TEST_HOME, CODEX_COLLAB_SESSIONS_DIR: REGISTRY, CODEX_COLLAB_NO_UPDATE_CHECK: "1", CODEX_COLLAB_REAP_POLL_MS: "500", CODEX_COLLAB_LOST_POLL_MS: "100", CODEX_COLLAB_TASK_POLL_MS: "50", CODEX_COLLAB_RESTART_GRACE_MS: "1500", CODEX_THREAD_ID: THREAD, ...extra };
}

/** Speak to a sender's advertised reply address as `fake`. */
function speak(fake: FakeSession, replyPath: string, text: string): void {
  const line = buildEnvelope({ text, ourSocketPath: fake.socketPath, ourName: fake.name, mode: "prompting" });
  Bun.connect({ unix: replyPath, socket: { open(s) { s.write(line); s.end(); }, data() {}, error() {} } });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor: condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface CliRun { stdout: string; stderr: string; code: number }

/** Start the CLI and keep watching it: `stdout()` is what it printed so far. */
function runCliLive(args: string[], env: Record<string, string> = {}, input?: string): { child: ReturnType<typeof spawn>; stdout: () => string; done: Promise<CliRun> } {
  const child = spawn("bun", ["run", CLI, ...args], {
    cwd: WS,
    env: cliEnv(env),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => { stdout += d.toString(); });
  child.stderr!.on("data", (d) => { stderr += d.toString(); });
  if (input !== undefined) child.stdin!.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const done = new Promise<CliRun>((resolve) => {
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? (signal ? 128 : -1) }); });
  });
  return { child, stdout: () => stdout, done };
}

function runCli(args: string[], env: Record<string, string> = {}, input?: string): Promise<CliRun> {
  return runCliLive(args, env, input).done;
}

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(TEST_HOME, ".codex-collab"), { recursive: true });
  writeFileSync(join(TEST_HOME, ".codex-collab", "config.json"), JSON.stringify(cfg));
}

function removeConfig(): void {
  rmSync(join(TEST_HOME, ".codex-collab", "config.json"), { force: true });
}

/** A fake `claude` on PATH. `--bg` logs itself, announces `cafe0001`, and
 *  registers a live entry (a sleeper it starts) whose socket is `socketPath`
 *  — a fake session this test serves. `stop <id>` only logs, so a reaper's
 *  confirming look finds the entry still live and signals the sleeper. */
function writeFakeClaude(binDir: string, socketPath: string, sessionId = "s"): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "claude"), `#!/bin/sh
case "$1" in
  --bg)
    echo bg >> "${binDir}/bg.log"
    for a in "$@"; do printf '%s\\n' "$a"; done > "${binDir}/args.log"
    echo "backgrounded · cafe0001 · $3"
    sleep 300 </dev/null >/dev/null 2>&1 &
    pid=$!
    echo "$pid" >> "${binDir}/sleepers"
    start=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^ *//;s/ *$//')
    now="$(date +%s)000"
    printf '{"pid":%s,"sessionId":"${sessionId}","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.261","peerProtocol":1,"kind":"bg","jobId":"cafe0001","entrypoint":"cli","messagingSocketPath":"%s","name":"%s","nameSource":"peer","status":"idle","updatedAt":%s,"statusUpdatedAt":%s}' \\
      "$pid" "$(pwd)" "$now" "$start" "${socketPath}" "$3" "$now" "$now" > "$CODEX_COLLAB_SESSIONS_DIR/$pid.json"
    ;;
  stop) echo "stop $2" >> "${binDir}/stop.log" ;;
esac
`, { mode: 0o755 });
}

function killFakeSleepers(binDir: string): void {
  try {
    for (const line of readFileSync(join(binDir, "sleepers"), "utf-8").split("\n")) {
      const pid = Number(line.trim());
      if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    }
  } catch { /* none started */ }
}

/** Spawn-path tests share one workspace, and a reaper an earlier test left
 *  behind (polling every 500ms) still writes to its records when it finds
 *  its session gone: it marks it stopped — which the next test's `send`
 *  would then resume. Let such a reaper finish, then start from no records. */
async function settleSpawnState(): Promise<void> {
  await new Promise((r) => setTimeout(r, 900));
  const root = join(TEST_HOME, ".codex-collab", "workspaces");
  try {
    for (const d of readdirSync(root)) rmSync(join(root, d, "spawned-claude.json"), { force: true });
  } catch { /* no state yet */ }
}

/** The id `send` announced for the task it recorded. */
function taskIdOf(stdout: string): string {
  const m = /as task ([0-9a-f]{8})\./.exec(stdout);
  if (!m) throw new Error(`no task id in: ${stdout}`);
  return m[1];
}

/** The CLI's task records, under the test HOME. */
function taskRecord(id: string): Record<string, unknown> | null {
  const root = join(TEST_HOME, ".codex-collab", "workspaces");
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, "tasks", `${id}.json`);
      if (existsSync(f)) return JSON.parse(readFileSync(f, "utf-8"));
    }
  } catch { /* no state yet */ }
  return null;
}

/** The CLI's spawned-session records, under the test HOME. */
function spawnedRecords(): unknown[] {
  const root = join(TEST_HOME, ".codex-collab", "workspaces");
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, "spawned-claude.json");
      if (existsSync(f)) return JSON.parse(readFileSync(f, "utf-8"));
    }
  } catch { /* no state yet */ }
  return [];
}

beforeAll(() => {
  mkdirSync(REGISTRY, { recursive: true });
  mkdirSync(WS, { recursive: true });
  spawnSync("git", ["init", "-q", WS]);
});

afterEach(() => {
  for (const f of fakes) f.stop();
  fakes = [];
  for (const s of sleepers) { try { s.kill(); } catch { /* gone */ } }
  sleepers.length = 0;
  for (const f of readdirSync(REGISTRY)) unlinkSync(join(REGISTRY, f));
});

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describeUnix("send helpers", () => {
  test("insideCodexSandbox reads Codex's markers", () => {
    expect(insideCodexSandbox({})).toBe(false);
    expect(insideCodexSandbox({ CODEX_SANDBOX: "seatbelt" })).toBe(true);
    // Codex keeps this one set on commands it runs outside the sandbox.
    expect(insideCodexSandbox({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe(false);
  });

  test("codexThreadId accepts Codex's thread id and nothing odd", () => {
    expect(codexThreadId({ CODEX_THREAD_ID: THREAD })).toBe(THREAD);
    expect(codexThreadId({ CODEX_THREAD_ID: "not a thread" })).toBeNull();
    expect(codexThreadId({})).toBeNull();
  });

  test("senderName names the thread, the workspace and the task — one address per task", () => {
    expect(senderName(WS, THREAD, "abc12345")).toBe(`codex(01a0985a-${workspaceSuffix(WS)}-abc12345)`);
    expect(senderName(WS, null, "abc12345")).toBe(`codex(shell-${workspaceSuffix(WS)}-abc12345)`);
    // Short enough to show whole wherever Claude Code lists its peers.
    expect(senderName(WS, THREAD, "abc12345").length).toBeLessThanOrEqual(40);
  });

  test("composeMessage says who is asking and where the reply goes, and names no deadline", () => {
    const sent = composeMessage("hello", { threadId: THREAD });
    expect(sent).toBe(`hello\n\n(From Codex thread ${THREAD}. Reply to this peer when you are done; your reply is kept for it.)`);
    expect(composeMessage("fyi", { threadId: null })).toContain("(From a Codex session. Reply to this peer");
    // Nothing for a careful model to fit its work into.
    expect(sent).not.toMatch(/\d+\s*(s|m|h|sec|min)\b|waits? up to|deadline|timeout/i);
  });

  test("splitTarget: --to, else the first of two or more whether live or not, else no target", () => {
    const sessions = [{ name: "alpha" }] as Parameters<typeof splitTarget>[2];
    expect(splitTarget(["hi", "there"], "beta", sessions)).toEqual({ targetName: "beta", message: "hi there" });
    expect(splitTarget(["alpha", "hi", "there"], null, sessions)).toEqual({ targetName: "alpha", message: "hi there" });
    // A name that is not live stays a name. Folded into the message, it
    // would send that message to whoever else is live.
    expect(splitTarget(["gone-claude", "review this"], null, sessions)).toEqual({ targetName: "gone-claude", message: "review this" });
    expect(splitTarget(["gone-claude", "-"], null, sessions)).toEqual({ targetName: "gone-claude", message: "-" });
    // A live session's name alone is a forgotten message, not a message.
    expect(splitTarget(["alpha"], null, sessions)).toEqual({ targetName: "alpha", message: "" });
    expect(splitTarget(["beta"], null, sessions)).toEqual({ targetName: null, message: "beta" });
  });
});

describeUnix("peers", () => {
  test("formatSessions aligns columns and annotates spawned sessions", () => {
    const out = formatSessions([
      { pid: 1, name: "Explore", status: "idle", kind: "interactive", cwd: "/", entrypoint: "cli", tmux: null, socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: null, spawned: null },
      { pid: 2, name: "claude(ws-abc123)", status: "idle", kind: "bg", cwd: "/", entrypoint: "cli", tmux: null, socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: 1_000_000, spawned: { id: "x", pid: 2, name: "claude(ws-abc123)", startedAt: "t", lingerSec: 1800 } },
    ], 1_000_000 + 4 * 60_000);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^ {2}NAME +STATUS +KIND$/);
    expect(lines[1]).toMatch(/^ {2}Explore +idle +interactive$/);
    expect(lines[2]).toMatch(/^ {2}claude\(ws-abc123\) +idle +background +started by codex-collab · idle 4m 0s · stops after 30m 0s idle$/);
  });

  test("a session says where it lives: the VS Code panel and a tmux pane are as interactive as a terminal, and harder to find", () => {
    const row = (name: string, entrypoint: string | null, tmux: string | null) =>
      ({ pid: 1, name, status: "idle" as const, kind: "interactive", entrypoint, tmux, cwd: "/", socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: null, spawned: null });
    expect(whereItLives({ entrypoint: "claude-vscode", tmux: null })).toBe("in VS Code");
    expect(whereItLives({ entrypoint: "cli", tmux: "work:@2.%2" })).toBe("tmux work:@2.%2");
    expect(whereItLives({ entrypoint: "cli", tmux: null })).toBeNull();
    expect(whereItLives({ entrypoint: null, tmux: null })).toBeNull();
    expect(whereItLives({ entrypoint: "sdk-ts", tmux: null })).toBe("via sdk-ts");
    const lines = formatSessions([row("thesis-83", "claude-vscode", null), row("narrative", "cli", "work:@2.%2"), row("plain", "cli", null)]).split("\n");
    expect(lines[1]).toMatch(/^ {2}thesis-83 +idle +interactive +in VS Code$/);
    expect(lines[2]).toMatch(/^ {2}narrative +idle +interactive +tmux work:@2\.%2$/);
    expect(lines[3]).toMatch(/^ {2}plain +idle +interactive$/);
  });

  test("a session listed on its socket alone is marked on its row only where rows differ; when none could be checked, it is said once", () => {
    const row = (name: string, verified: boolean) =>
      ({ pid: 1, name, status: "idle" as const, kind: "interactive", cwd: "/", entrypoint: "cli", tmux: null, socketPath: "/s", sessionId: null, procStart: "236353382", verified, statusUpdatedAt: null, spawned: null });
    // Mixed: the mark tells the rows apart, and no general notice is due.
    const mixed = [row("Explore", true), row("Remote", false)];
    const lines = formatSessions(mixed).split("\n");
    expect(lines[1]).toMatch(/^ {2}Explore +idle +interactive$/);
    expect(lines[2]).toMatch(/^ {2}Remote +idle +interactive +unverified: its process cannot be checked from here$/);
    expect(unverifiedNotice(mixed)).toBeNull();
    // From inside Codex's sandbox nothing can be checked: a mark on every
    // row would say nothing, so the rows stay clean and one line explains.
    const sandboxed = [row("Explore", false), row("Other", false)];
    expect(formatSessions(sandboxed)).not.toContain("unverified");
    expect(unverifiedNotice(sandboxed)).toMatch(/^Seen from inside a sandbox: .*`codex-collab send` checks again, outside the sandbox, before it delivers\.$/);
    expect(unverifiedNotice([row("Explore", true)])).toBeNull();
    expect(unverifiedNotice([])).toBeNull();
  });

  test("lists the live session in the workspace, and says when there is none", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const listed = await runCli(["peers"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("fake-claude");
    expect(listed.stdout).toContain("interactive");
    const asJson = await runCli(["peers", "--json"]);
    expect(JSON.parse(asJson.stdout)[0]).toEqual(expect.objectContaining({ name: "fake-claude", status: "idle", kind: "interactive" }));
    fake.stop();
    const none = await runCli(["peers"]);
    expect(none.stdout).toContain("No Claude Code session is live in this workspace");
    expect(none.stdout).toContain("starts one in the background");
  });

  test("peers stop ends a session codex-collab started, and refuses one it did not", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-peers-stop");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 600 });
    try {
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      // Nothing live yet, so this starts the session it will later stop.
      expect((await runCli(["send", "hello"], env)).code).toBe(0);
      const mine = startFake("the-users-own", { reply: () => "ok" });
      registerFake(mine);
      // A session the user is working in is theirs to close, whatever Codex
      // makes of it.
      const refused = await runCli(["peers", "stop", "the-users-own"], env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("was not started by codex-collab, so it is not ours to stop");
      // Its process, not its registry entry: the entry is this test's to write,
      // so it would survive a signal and prove nothing.
      const minePid = Number(basename(mine.entryPath, ".json"));
      expect(() => process.kill(minePid, 0)).not.toThrow();
      // Ours: stopped the way it was started, and left resumable.
      const stopped = await runCli(["peers", "stop", spawnedSessionName(WS)], env);
      expect(stopped.stderr + stopped.stdout).toContain("Stopped");
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`Stopped ${spawnedSessionName(WS)}. Its conversation is kept:`);
      expect(readFileSync(join(binDir, "stop.log"), "utf-8")).toContain("stop cafe0001");
      expect(spawnedRecords()).toContainEqual(expect.objectContaining({ id: "cafe0001", stoppedAt: expect.any(String) }));
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("peers stop refuses inside the sandbox, and names the tasks a stopped session leaves unanswered", async () => {
    const refused = await runCli(["peers", "stop", "anyone"], { CODEX_SANDBOX: "seatbelt" });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("cannot run inside the Codex sandbox");

    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-peers-stop-waiting");
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 600 });
    try {
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      const id = taskIdOf((await runCli(["send", "a long job", "--no-wait"], env)).stdout);
      const stopped = await runCli(["peers", "stop", spawnedSessionName(WS)], env);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`1 task was still waiting on it (${id}) — it ends with no reply.`);
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("peers stop knows a session it started by its process when the session id has changed", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-peers-stop-by-pid");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 600 });
    try {
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      expect((await runCli(["send", "hello"], env)).code).toBe(0);
      // A new session id, as /clear gives one: the pid and its start time
      // still say it is the process started here.
      for (const f of readdirSync(REGISTRY)) {
        const file = join(REGISTRY, f);
        const entry = JSON.parse(readFileSync(file, "utf-8"));
        if (entry.name === fake.name) writeFileSync(file, JSON.stringify({ ...entry, sessionId: "5e55e55e-0000-4000-8000-000000000000" }));
      }
      const stopped = await runCli(["peers", "stop", spawnedSessionName(WS)], env);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`Stopped ${spawnedSessionName(WS)}.`);
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test.skipIf(process.platform !== "linux")("peers stop that did not take says so, and leaves the record as it was", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-peers-stop-fails");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 600 });
    try {
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      expect((await runCli(["send", "hello"], env)).code).toBe(0);
      // Seen from another pid domain its process cannot be checked, so no
      // signal follows a `claude stop` that did nothing.
      for (const f of readdirSync(REGISTRY)) {
        const file = join(REGISTRY, f);
        const entry = JSON.parse(readFileSync(file, "utf-8"));
        if (entry.name === fake.name) writeFileSync(file, JSON.stringify({ ...entry, pidDomain: "linux:elsewhere:pid:[1]" }));
      }
      const r = await runCli(["peers", "stop", spawnedSessionName(WS)], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("is still running: `claude stop` did not take");
      // Codex ran it: the one cause a sandbox would explain is named.
      expect(r.stderr).toContain("If Codex ran this command in its sandbox");
      const [record] = spawnedRecords() as Array<{ id: string; stoppedAt?: string }>;
      expect(record.id).toBe("cafe0001");
      expect(record.stoppedAt).toBeUndefined();
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("peers does not refuse under the sandbox marker", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const listed = await runCli(["peers"], { CODEX_SANDBOX: "seatbelt" });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("fake-claude");
  });
});

describeUnix("a turn that ended on an error", () => {
  const sid = "55555555-5555-4555-8555-555555555555";
  const projects = join(TEST_HOME, "projects-watch");
  const transcript = (lines: string[]) => writeFileSync(join(projects, "-ws", `${sid}.jsonl`), lines.join("\n") + "\n");
  const apiError = (at: string) => JSON.stringify({ type: "assistant", timestamp: at, isApiErrorMessage: true, apiErrorStatus: 500, error: "server_error" });
  const said = (at: string) => JSON.stringify({ type: "assistant", timestamp: at });
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const saved = { projects: process.env.CODEX_COLLAB_PROJECTS_DIR, sessions: process.env.CODEX_COLLAB_SESSIONS_DIR };

  beforeAll(() => {
    mkdirSync(join(projects, "-ws"), { recursive: true });
    process.env.CODEX_COLLAB_PROJECTS_DIR = projects;
    // The watcher runs in this process, so it reads the fake registry only
    // when this process is pointed at it too.
    process.env.CODEX_COLLAB_SESSIONS_DIR = REGISTRY;
  });
  afterAll(() => {
    for (const [k, v] of [["CODEX_COLLAB_PROJECTS_DIR", saved.projects], ["CODEX_COLLAB_SESSIONS_DIR", saved.sessions]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** A live registry entry for a sleeper, at whatever status. */
  const live = (status: string) => {
    const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
    sleepers.push(sleeper);
    const pid = sleeper.pid!;
    writeFileSync(join(REGISTRY, `${pid}.json`), JSON.stringify({
      ...buildRegistryEntry({ pid, cwd: WS, name: "watched", socketPath: "/tmp/x.sock", version: "2.1.261", procStart: procStartOf(pid), sessionId: sid }),
      status,
    }));
    return { pid, socketPath: "/tmp/x.sock", sessionId: sid, procStart: procStartOf(pid), spawned: null, name: "watched" };
  };
  const looksFor = (target: Parameters<typeof watchForStalledTurn>[0], since: string, ms = 400) =>
    new Promise<boolean>((resolve) => {
      const w = watchForStalledTurn(target, since, { pollMs: 20, looks: 3 });
      void w.stalled.then(() => resolve(true));
      setTimeout(() => { w.stop(); resolve(false); }, ms);
    });

  test("the error must be the last thing said, and later than the delivery", async () => {
    transcript([said(past), apiError(future)]);
    expect(await looksFor(live("idle"), past)).toBe(true);
    // Delivered after that error: it belongs to something earlier.
    expect(await looksFor(live("idle"), new Date(Date.now() + 120_000).toISOString(), 200)).toBe(false);
    // It carried on after the error.
    transcript([apiError(future), said(future)]);
    expect(await looksFor(live("idle"), past, 200)).toBe(false);
  });

  test("only an idle session has settled: a prompt and an unreadable entry are not evidence", async () => {
    transcript([said(past), apiError(future)]);
    // `waiting` is a person about to act, not a turn that died.
    expect(await looksFor(live("waiting"), past, 200)).toBe(false);
    expect(await looksFor(live("busy"), past, 200)).toBe(false);
    expect(await looksFor(live("shell"), past, 200)).toBe(false);
    // No registry entry at all says nothing either.
    expect(await looksFor({ pid: 999_999, socketPath: "/tmp/x.sock", sessionId: sid, procStart: null, spawned: null, name: "gone" }, past, 200)).toBe(false);
  });
});

describeUnix("send", () => {
  test("delivers to the only live session, prints its reply, and cleans up its registration", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const before = new Set(readdirSync(REGISTRY));
    const r = await runCli(["send", "hello there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sending to fake-claude — the only Claude Code session in this workspace.");
    expect(r.stdout).toMatch(/Sent to fake-claude as task [0-9a-f]{8}\. Waiting up to 10m/);
    const id = taskIdOf(r.stdout);
    // The outcome leads with a line a caller can match without reading prose.
    expect(r.stdout).toContain(`\ntask: ${id}  status: replied\nREPLY FROM fake-claude`);
    expect(r.stdout).toContain("  pong: hello there");
    // What the session received: the message, then who sent it — and no
    // word of how long the sender will wait.
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0].fromName).toBe(`codex(01a0985a-${workspaceSuffix(WS)}-${id})`);
    expect(fake.received[0].text).toContain(`Codex thread ${THREAD}`);
    expect(fake.received[0].text).not.toContain("waits up to");
    // The transient registration and socket are gone by the time the reply
    // is reported, and the record keeps what was said.
    expect(new Set(readdirSync(REGISTRY))).toEqual(before);
    expect(existsSync(fake.received[0].replyPath)).toBe(false);
    expect(taskRecord(id)).toEqual(expect.objectContaining({ status: "replied", threadId: THREAD, reply: { text: "pong: hello there", fromName: "fake-claude" } }));
  });

  test("a reply that comes after send stopped waiting is kept: exit 3 says the task goes on, and task wait / result / status collect it", async () => {
    const fake = startFake("slow-claude", { reply: null });
    registerFake(fake);
    const r = await runCli(["send", "take your time", "--timeout", "1"]);
    // Not a success, and not a failure: the task is still being waited on.
    expect(r.code).toBe(3);
    const id = taskIdOf(r.stdout);
    expect(r.stdout).toContain(`task: ${id}  status: running`);
    expect(r.stdout).toContain("no reply from slow-claude within 1s");
    // Codex reads this output as context and has the commands from its skill:
    // a line of syntax under every send is cost with nothing in it. Piped —
    // which is how Codex runs it — the report is the status line and what
    // happened, and nothing else.
    expect(r.stdout).not.toContain("codex-collab task wait");
    expect(r.stdout).not.toContain("bypassPermissions");
    expect(r.stdout.trimEnd().split("\n").filter((l) => l.trim())).toHaveLength(4);
    // Asking before the reply is there: still running, same code.
    const early = await runCli(["task", "result", id]);
    expect(early.code).toBe(3);
    expect(early.stdout).toContain(`task: ${id}  status: running`);
    const status = await runCli(["task", "status", id]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`task: ${id}  status: running`);
    expect(status.stdout).toMatch(/to +slow-claude/);
    expect(status.stdout).toMatch(/session +idle/);
    expect(status.stdout).toMatch(/message +take your time/);
    // The session answers long after `send` has gone: the receiver is still
    // at the address it was given.
    const waiting = runCli(["task", "wait", id.slice(0, 4), "--timeout", "20"]);
    await new Promise((res) => setTimeout(res, 300));
    speak(fake, fake.received[0].replyPath, "done, at last");
    const waited = await waiting;
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain(`task: ${id}  status: replied\nREPLY FROM slow-claude`);
    expect(waited.stdout).toContain("  done, at last");
    const result = await runCli(["task", "result", id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  done, at last");
    expect(existsSync(fake.received[0].replyPath)).toBe(false);
    const listed = await runCli(["tasks"]);
    expect(listed.stdout).toMatch(new RegExp(`${id} +replied +slow-claude .* take your time`));
    expect(JSON.parse((await runCli(["task", "status", id, "--json"])).stdout)).toEqual(expect.objectContaining({ id, status: "replied" }));
  });

  test("a busy session is delivered to with a note that the message joins its turn", async () => {
    const fake = startFake("busy-claude");
    registerFake(fake, { status: "busy" });
    const r = await runCli(["send", "ping"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("It is busy — your message joins its current turn.");
    expect(r.stdout).toContain("REPLY FROM busy-claude");
  });

  test("--no-wait returns once the message is delivered, with the task id its reply is collected under", async () => {
    const fake = startFake("fake-claude", { reply: null });
    registerFake(fake);
    const r = await runCli(["send", "long job", "--no-wait"]);
    expect(r.code).toBe(0);
    const id = taskIdOf(r.stdout);
    expect(r.stdout).toContain(`Sent to fake-claude as task ${id}. Not waiting; its reply is kept.`);
    expect(r.stdout).not.toContain("REPLY");
    expect(r.stdout).not.toContain("codex-collab task");
    // Delivered before `send` said so — not merely queued.
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0].text.startsWith("long job\n\n(From Codex thread")).toBe(true);
    speak(fake, fake.received[0].replyPath, "job done");
    const waited = await runCli(["task", "wait", id]);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain("  job done");
  });

  test("each task has an address of its own: a late word sent to a finished task cannot become another task's reply", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    expect((await runCli(["send", "one"])).stdout).toContain("  pong: one");
    fake.reply = null;
    const second = await runCli(["send", "two", "--no-wait"]);
    const id = taskIdOf(second.stdout);
    const [first, later] = fake.received;
    expect(later.fromName).not.toBe(first.fromName);
    expect(later.replyPath).not.toBe(first.replyPath);
    // The session thinks of something to add to its first answer. Nobody is
    // at that address any more — and the task now waiting is left waiting.
    const line = buildEnvelope({ text: "one more thing about one", ourSocketPath: fake.socketPath, ourName: fake.name, mode: "prompting" });
    const refused = await Bun.connect({ unix: first.replyPath, socket: { open(sock) { sock.write(line); sock.end(); }, data() {}, error() {} } }).then(() => false, () => true);
    expect(refused).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(taskRecord(id)).toEqual(expect.objectContaining({ status: "running" }));
    speak(fake, later.replyPath, "answer to two");
    const waited = await runCli(["task", "wait", id]);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain("  answer to two");
    expect(waited.stdout).not.toContain("one more thing");
  });

  test("names: a leading positional that is a live session, or --to, or a unique prefix", async () => {
    const a = startFake("alpha-claude");
    const b = startFake("beta-claude");
    registerFake(a);
    registerFake(b);
    const byPositional = await runCli(["send", "beta-claude", "to", "beta"]);
    expect(byPositional.code).toBe(0);
    expect(byPositional.stdout).toContain("REPLY FROM beta-claude");
    expect(b.received[0].text.startsWith("to beta\n")).toBe(true);
    const byPrefix = await runCli(["send", "--to", "alph", "to alpha"]);
    expect(byPrefix.code).toBe(0);
    expect(a.received[0].text.startsWith("to alpha\n")).toBe(true);
    const ambiguous = await runCli(["send", "--to", "claude", "x"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("No live Claude Code session named \"claude\"");
    const nobody = await runCli(["send", "--to", "gamma", "x"]);
    expect(nobody.code).toBe(1);
    expect(nobody.stderr).toContain("Live here: alpha-claude, beta-claude");
  });

  test("several live sessions and no name is refused with the list", async () => {
    registerFake(startFake("alpha-claude"));
    registerFake(startFake("beta-claude"));
    const r = await runCli(["send", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Several Claude Code sessions are live in this workspace — name one:");
    expect(r.stderr).toContain('codex-collab send "alpha-claude" "…"');
    expect(r.stderr).toContain('codex-collab send "beta-claude" "…"');
  });

  test("a session in another workspace is not a candidate", async () => {
    const elsewhere = join(TEST_HOME, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    registerFake(startFake("far-claude"), { cwd: elsewhere });
    const r = await runCli(["send", "x", "--no-spawn"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No Claude Code session is live in this workspace (--no-spawn)");
  });

  test("inside the Codex sandbox it refuses up front and says how to rerun", async () => {
    registerFake(startFake("fake-claude"));
    const r = await runCli(["send", "x"], { CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot run inside the Codex sandbox");
    expect(r.stderr).toContain("escalated permissions");
  });

  test("spawning off is reported, and an empty message is an error", async () => {
    writeConfig({ spawn: "off" });
    try {
      const off = await runCli(["send", "x"]);
      expect(off.code).toBe(1);
      expect(off.stderr).toContain("starting one is off");
    } finally {
      removeConfig();
    }
    const empty = await runCli(["send"]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("No message provided");
  });

  test("a message from a different sender is noted, not taken as the reply", async () => {
    const other = startFake("other-claude", { reply: null });
    registerFake(other);
    const target = startFake("target-claude", { reply: null });
    registerFake(target);
    const live = runCliLive(["send", "--to", "target", "question"]);
    await waitFor(() => target.received.length === 1);
    const replyPath = target.received[0].replyPath;
    // "other" speaks first; the task goes on waiting for the session it asked.
    speak(other, replyPath, "not for you");
    await new Promise((res) => setTimeout(res, 300));
    expect(taskRecord(taskIdOf(live.stdout()))).toEqual(expect.objectContaining({ status: "running" }));
    speak(target, replyPath, "real: question");
    const r = await live.done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("REPLY FROM target-claude");
    expect(r.stdout).toContain("  real: question");
    expect(r.stdout).not.toContain("not for you");
  });

  test("with no session live, one is started, messaged, and stopped again once idle", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-spawn");
    const fake = startFake(spawnedSessionName(WS), { reply: (t) => `spawned says: ${t.split("\n")[0]}` });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 2 });
    try {
      const r = await runCli(["send", "are you there?"], { PATH: `${binDir}:${process.env.PATH}` });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("No Claude Code session is live in this workspace — starting one in the background…");
      expect(r.stdout).toContain(`Started ${fake.name} (a background Claude Code session on the user's Claude Code default model and effort; it stops after 2s idle).`);
      expect(r.stdout).toContain(`REPLY FROM ${fake.name}`);
      expect(r.stdout).toContain("  spawned says: are you there?");
      expect(readFileSync(join(binDir, "bg.log"), "utf-8")).toBe("bg\n");
      // Nothing chosen, nothing passed: the session is left on the user's
      // own Claude Code default rather than on one picked for them.
      const args = readFileSync(join(binDir, "args.log"), "utf-8").trimEnd().split("\n");
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--effort");
      // The detached reaper stops it once it has idled for the linger —
      // through `claude stop`, then a signal when that did not take — and
      // keeps its record, as stopped: the conversation is still Claude Code's.
      await waitFor(() => existsSync(join(binDir, "stop.log")), 15_000);
      expect(readFileSync(join(binDir, "stop.log"), "utf-8")).toBe("stop cafe0001\n");
      await waitFor(() => (spawnedRecords() as Array<{ stoppedAt?: string }>).some((r) => r.stoppedAt), 15_000);
      const sleeperPid = Number(readFileSync(join(binDir, "sleepers"), "utf-8").trim());
      await waitFor(() => { try { process.kill(sleeperPid, 0); return false; } catch { return true; } }, 15_000);
      // Nobody is live now, and `peers` says what the next `send` will do.
      for (const f of readdirSync(REGISTRY)) unlinkSync(join(REGISTRY, f));
      const listed = await runCli(["peers"]);
      expect(listed.stdout).toContain(`resumes ${fake.name}, stopped`);
      expect(listed.stdout).toContain("with its conversation so far (`--fresh` starts a new session instead)");
      // The next send picks the conversation up again instead of starting over.
      const again = await runCli(["send", "still there?"], { PATH: `${binDir}:${process.env.PATH}` });
      expect(again.code).toBe(0);
      expect(again.stdout).toMatch(new RegExp(`No Claude Code session is live in this workspace — resuming ${fake.name.replace(/[()]/g, "\\$&")}, stopped \\S+ ago, with its conversation so far…`));
      expect(again.stdout).toContain(`Resumed ${fake.name} (its conversation so far is intact; on the user's Claude Code default model and effort;`);
      expect(again.stdout).toContain("  spawned says: still there?");
      const resumeArgs = readFileSync(join(binDir, "args.log"), "utf-8").trimEnd().split("\n");
      expect(resumeArgs[resumeArgs.indexOf("--resume") + 1]).toBe("s");
      expect(readFileSync(join(binDir, "bg.log"), "utf-8")).toBe("bg\nbg\n");
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("the model and effort Codex chooses reach the session it starts, ahead of the configured default", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-spawn-choice");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    // The user's default for started sessions; the flags outrank it.
    writeConfig({ linger: 60, "spawn-model": "haiku", "spawn-effort": "low" });
    try {
      const r = await runCli(["send", "design question", "--model", "opus", "--effort", "high"], { PATH: `${binDir}:${process.env.PATH}` });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Started ${fake.name} (a background Claude Code session on opus, high effort; it stops after`);
      const args = readFileSync(join(binDir, "args.log"), "utf-8").trimEnd().split("\n");
      expect(args[args.indexOf("--model") + 1]).toBe("opus");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
      expect(spawnedRecords()).toContainEqual(expect.objectContaining({ model: "opus", effort: "high" }));
      // The session is live now, and what it runs on is fixed: `peers` shows
      // it, and a different choice on a later send is reported, not dropped.
      const listed = await runCli(["peers"]);
      expect(listed.stdout).toContain("started by codex-collab · opus, high effort");
      const again = await runCli(["send", "quick lookup", "-m", "haiku", "-r", "low"], { PATH: `${binDir}:${process.env.PATH}` });
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(`${fake.name} is already running on opus, high effort: --model and --effort apply only when \`send\` starts a session, so yours did not apply.`);
      expect(readFileSync(join(binDir, "bg.log"), "utf-8")).toBe("bg\n");
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("with no flags, a started session runs on the configured spawn-model and spawn-effort", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-spawn-config");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 60, "spawn-model": "haiku", "spawn-effort": "low" });
    try {
      const r = await runCli(["send", "quick lookup"], { PATH: `${binDir}:${process.env.PATH}` });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("a background Claude Code session on haiku, low effort;");
      const args = readFileSync(join(binDir, "args.log"), "utf-8").trimEnd().split("\n");
      expect(args[args.indexOf("--model") + 1]).toBe("haiku");
      expect(args[args.indexOf("--effort") + 1]).toBe("low");
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a choice of model cannot change the user's own session, and send says so; an effort Claude has no level for is refused", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const r = await runCli(["send", "hello", "--model", "haiku"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fake-claude is the user's own session and runs on what they chose: --model and --effort apply only to a session `send` starts, so yours did not apply.");
    expect(r.stdout).toContain("REPLY FROM fake-claude");
    // `ultra` is a Codex reasoning level; `claude --effort` has none by that name.
    const bad = await runCli(["send", "hello", "--effort", "ultra"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Invalid effort for a Claude Code session: ultra");
    expect(bad.stderr).toContain("low, medium, high, xhigh, max");
    expect(fake.received).toHaveLength(1);
  });

  test("a stopped session is left alone with --fresh, with resuming off, and once it is older than the window", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-spawn-fresh");
    const fake = startFake(spawnedSessionName(WS), { reply: () => "ok" });
    writeFakeClaude(binDir, fake.socketPath);
    const env = { PATH: `${binDir}:${process.env.PATH}` };
    const argsOf = () => readFileSync(join(binDir, "args.log"), "utf-8").trimEnd().split("\n");
    /** End the running fake session and leave its record stopped at `when`. */
    const stopAt = async (when: Date) => {
      killFakeSleepers(binDir);
      for (const f of readdirSync(REGISTRY)) unlinkSync(join(REGISTRY, f));
      await new Promise((r) => setTimeout(r, 900)); // its reaper sees it gone
      const root = join(TEST_HOME, ".codex-collab", "workspaces");
      for (const d of readdirSync(root)) {
        const f = join(root, d, "spawned-claude.json");
        if (!existsSync(f)) continue;
        const records = JSON.parse(readFileSync(f, "utf-8")) as Array<Record<string, unknown>>;
        writeFileSync(f, JSON.stringify(records.map((r) => ({ ...r, stoppedAt: when.toISOString() }))));
      }
    };
    writeConfig({ linger: 60 });
    try {
      expect((await runCli(["send", "one"], env)).stdout).toContain(`Started ${fake.name}`);
      // Codex wants a clean start: the stopped conversation is not resumed.
      await stopAt(new Date());
      const fresh = await runCli(["send", "two", "--fresh"], env);
      expect(fresh.stdout).toContain("starting one in the background…");
      expect(fresh.stdout).toContain(`Started ${fake.name}`);
      expect(argsOf()).not.toContain("--resume");
      // The user turned resuming off.
      await stopAt(new Date());
      writeConfig({ linger: 60, "spawn-resume": "off" });
      expect((await runCli(["send", "three"], env)).stdout).toContain(`Started ${fake.name}`);
      expect(argsOf()).not.toContain("--resume");
      // Stopped longer ago than the window allows.
      await stopAt(new Date(Date.now() - 2 * 3600_000));
      writeConfig({ linger: 60, "spawn-resume": 3600 });
      expect((await runCli(["send", "four"], env)).stdout).toContain(`Started ${fake.name}`);
      expect(argsOf()).not.toContain("--resume");
      // Within the window it is resumed — and a model Codex names now applies,
      // since a resumed session is a new process.
      await stopAt(new Date(Date.now() - 600_000));
      const resumed = await runCli(["send", "five", "--model", "haiku"], env);
      expect(resumed.stdout).toContain(`Resumed ${fake.name} (its conversation so far is intact; on haiku, default effort;`);
      expect(resumed.stdout).not.toContain("did not apply");
      expect(argsOf()[argsOf().indexOf("--resume") + 1]).toBe("s");
      expect(argsOf()[argsOf().indexOf("--model") + 1]).toBe("haiku");
      // With nothing chosen, a resumed session runs on the configured
      // default, as a new one would — not on what it was chosen for last time.
      await stopAt(new Date(Date.now() - 600_000));
      writeConfig({ linger: 60, "spawn-model": "sonnet" });
      const byDefault = await runCli(["send", "six"], env);
      expect(byDefault.stdout).toContain(`Resumed ${fake.name} (its conversation so far is intact; on sonnet, default effort;`);
      expect(argsOf()[argsOf().indexOf("--model") + 1]).toBe("sonnet");
      await stopAt(new Date(Date.now() - 600_000));
      writeConfig({ linger: 60 });
      const unset = await runCli(["send", "seven"], env);
      expect(unset.stdout).toContain(`Resumed ${fake.name} (its conversation so far is intact; on the user's Claude Code default model and effort;`);
      expect(argsOf()).not.toContain("--model");
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a started session that stops at a prompt is noticed, stopped and left resumable — not waited on until the timeout", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-spawn-blocked");
    // Never replies: it is, as far as the registry says, sitting at a prompt.
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 60 });
    try {
      const started = Date.now();
      const live = runCliLive(["send", "edit the file", "--model", "haiku", "--timeout", "60"], { PATH: `${binDir}:${process.env.PATH}`, CODEX_COLLAB_BLOCKED_POLL_MS: "50" });
      await waitFor(() => fake.received.length === 1, 15_000);
      // What Claude Code reports for a session asking a question nobody is
      // attached to answer — as it does where auto mode is unavailable.
      for (const f of readdirSync(REGISTRY)) {
        const file = join(REGISTRY, f);
        const entry = JSON.parse(readFileSync(file, "utf-8"));
        if (entry.name === fake.name) writeFileSync(file, JSON.stringify({ ...entry, status: "waiting" }));
      }
      const r = await live.done;
      expect(r.code).toBe(5);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(r.stdout).toMatch(/task: [0-9a-f]{8}  status: blocked/);
      expect(r.stdout).toContain(`${fake.name} stopped at a prompt with nobody attached; it ran on haiku, default effort`);
      expect(r.stdout).toContain("session: stopped by codex-collab, conversation kept");
      expect(readFileSync(join(binDir, "stop.log"), "utf-8")).toContain("stop cafe0001\n");
      // The fake `claude stop` does nothing, as a session wedged at a prompt
      // may: the session is signalled all the same before it is called stopped.
      const sleeperPid = Number(readFileSync(join(binDir, "sleepers"), "utf-8").trim());
      await waitFor(() => { try { process.kill(sleeperPid, 0); return false; } catch { return true; } });
      // Stopped, so resumable: the next send carries the conversation on.
      expect(spawnedRecords()).toContainEqual(expect.objectContaining({ id: "cafe0001", model: "haiku", stoppedAt: expect.any(String) }));
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a user's own session that is at a prompt is reported as such when the wait runs out, and is never stopped", async () => {
    const fake = startFake("asking-claude", { reply: null });
    registerFake(fake, { status: "waiting" });
    const r = await runCli(["send", "hello", "--timeout", "1"], { CODEX_COLLAB_BLOCKED_POLL_MS: "50" });
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("no reply from asking-claude within 1s");
    expect(r.stdout).toContain("session: asking-claude is at a prompt in its own terminal");
    expect(r.stdout).not.toContain("It has been stopped");
    // Still registered: the user's session is theirs.
    expect(existsSync(fake.entryPath)).toBe(true);
  });

  test("two sends racing with no session live start one session between them", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-race");
    // Replies are held until both messages are in, so both sends are live
    // at once — the case in which one Codex thread needs two addresses.
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 2 });
    try {
      const env = { PATH: `${binDir}:${process.env.PATH}` };
      const a = runCli(["send", "first"], env);
      const b = runCli(["send", "second"], env);
      await waitFor(() => fake.received.length === 2, 15_000);
      expect(new Set(fake.received.map((m) => m.replyPath)).size).toBe(2);
      expect(new Set(fake.received.map((m) => m.fromName)).size).toBe(2);
      for (const m of fake.received) speak(fake, m.replyPath, `ok: ${m.text.split("\n")[0]}`);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.code).toBe(0);
      expect(rb.code).toBe(0);
      expect(readFileSync(join(binDir, "bg.log"), "utf-8")).toBe("bg\n");
      expect(ra.stdout + rb.stdout).toContain("  ok: first");
      expect(ra.stdout + rb.stdout).toContain("  ok: second");
      // One session, so one record — kept, as stopped, once the reaper is done.
      await waitFor(() => (spawnedRecords() as Array<{ stoppedAt?: string }>).some((r) => r.stoppedAt), 15_000);
      expect(spawnedRecords()).toHaveLength(1);
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("an interrupted send leaves its task being waited on: the reply is still collected, and the registration goes with it", async () => {
    const fake = startFake("quiet-claude", { reply: null });
    registerFake(fake);
    const live = runCliLive(["send", "hold on", "--timeout", "60"]);
    await waitFor(() => fake.received.length === 1 && /as task/.test(live.stdout()));
    const id = taskIdOf(live.stdout());
    const ours = () => readdirSync(REGISTRY).filter((f) => {
      try { return String(JSON.parse(readFileSync(join(REGISTRY, f), "utf-8")).name).startsWith("codex(01a0985a"); } catch { return false; }
    });
    expect(ours()).toHaveLength(1);
    live.child.kill("SIGINT");
    expect((await live.done).code).toBe(130);
    // The message was delivered and Claude is working on it: interrupting the
    // command that asked cannot take that back, so the answer is kept.
    expect(ours()).toHaveLength(1);
    speak(fake, fake.received[0].replyPath, "still here");
    const result = await runCli(["task", "wait", id]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  still here");
    expect(ours()).toHaveLength(0);
    expect(existsSync(fake.received[0].replyPath)).toBe(false);
  });

  test("a session that goes away before it replies ends the task as lost, and a receiver that is killed as failed", async () => {
    const fake = startFake("leaving-claude", { reply: null });
    registerFake(fake);
    const sent = await runCli(["send", "are you staying?", "--no-wait"]);
    const id = taskIdOf(sent.stdout);
    // The session exits: Claude Code removes its entry and its socket.
    fake.stop();
    const lost = await runCli(["task", "wait", id, "--timeout", "20"]);
    expect(lost.code).toBe(1);
    expect(lost.stdout).toContain(`task: ${id}  status: lost`);
    expect(lost.stdout).toContain("leaving-claude ended before it replied");
    // A tool says what happened; what to do about it is the reader's.
    expect(lost.stdout).not.toMatch(/send again|carry on|--fresh/);

    const other = startFake("staying-claude", { reply: null });
    registerFake(other);
    const again = await runCli(["send", "and you?", "--no-wait"]);
    const killedId = taskIdOf(again.stdout);
    const receiver = (taskRecord(killedId)!.receiver as { pid: number }).pid;
    process.kill(receiver, "SIGKILL");
    await waitFor(() => { try { process.kill(receiver, 0); return false; } catch { return true; } });
    // Nothing wrote a verdict; whoever asks works it out from the record.
    expect(taskRecord(killedId)).toEqual(expect.objectContaining({ status: "running" }));
    const failed = await runCli(["task", "wait", killedId, "--timeout", "20"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(`task: ${killedId}  status: failed`);
    expect(failed.stdout).toContain("the process collecting the reply is gone");
    // Killed outright, it removed nothing: its registration and its socket
    // are still there — until the next receiver, or `clean`, comes by.
    const leftover = other.received[0].replyPath;
    expect(existsSync(join(REGISTRY, `${receiver}.json`))).toBe(true);
    expect(existsSync(leftover)).toBe(true);
    other.reply = () => "here";
    expect((await runCli(["send", "--to", "staying-claude", "still there?"])).stdout).toContain("  here");
    expect(existsSync(join(REGISTRY, `${receiver}.json`))).toBe(false);
    expect(existsSync(leftover)).toBe(false);
  });

  test("a session is lost only once its registration has stayed gone: one unreadable moment is no evidence", async () => {
    const fake = startFake("rewriting-claude", { reply: null });
    registerFake(fake);
    const entry = JSON.parse(readFileSync(fake.entryPath, "utf-8"));
    const saved = process.env.CODEX_COLLAB_SESSIONS_DIR;
    process.env.CODEX_COLLAB_SESSIONS_DIR = REGISTRY;
    try {
      const target = { name: fake.name, pid: entry.pid, socketPath: fake.socketPath, sessionId: entry.sessionId, procStart: entry.procStart, spawned: null };
      let lost = false;
      const watch = watchForLost(target, { pollMs: 40, looks: 3 });
      void watch.lost.then(() => { lost = true; });
      // Claude Code rewrites its entry while it runs: gone for a look or two.
      unlinkSync(fake.entryPath);
      await new Promise((res) => setTimeout(res, 60));
      writeFileSync(fake.entryPath, JSON.stringify(entry));
      await new Promise((res) => setTimeout(res, 300));
      expect(lost).toBe(false);
      // Another session under the same pid is not the one that was asked.
      writeFileSync(fake.entryPath, JSON.stringify({ ...entry, sessionId: "11111111-0000-4000-8000-000000000000" }));
      await waitFor(() => lost, 3000);
      watch.stop();
    } finally {
      if (saved === undefined) delete process.env.CODEX_COLLAB_SESSIONS_DIR;
      else process.env.CODEX_COLLAB_SESSIONS_DIR = saved;
    }
  });

  test("a started session that goes away leaves the task lost, and every report says its conversation is kept", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-lost-spawn");
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 60 });
    try {
      const sent = await runCli(["send", "long job", "--no-wait"], { PATH: `${binDir}:${process.env.PATH}` });
      const id = taskIdOf(sent.stdout);
      // The session ends before it replies.
      killFakeSleepers(binDir);
      for (const f of readdirSync(REGISTRY)) unlinkSync(join(REGISTRY, f));
      const lost = await runCli(["task", "wait", id, "--timeout", "20"]);
      expect(lost.code).toBe(1);
      expect(lost.stdout).toContain(`task: ${id}  status: lost`);
      // `lost` is the reply, never the work: a Codex session that reads it as
      // unrecoverable starts over and throws the conversation away.
      expect(lost.stdout).toContain("session: started by codex-collab, conversation kept");
      expect((await runCli(["task", "status", id])).stdout).toContain("session   conversation kept");
      for (const out of [lost.stdout, (await runCli(["tasks"])).stdout]) {
        expect(out).not.toMatch(/send again|carry on/);
      }
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a task that ends with no reply says what the session's own transcript says went wrong", async () => {
    const projects = join(TEST_HOME, "projects-api-error");
    const sid = "00000000-0000-4000-8000-0000000000aa";  // what registerFake writes
    mkdirSync(join(projects, "-ws"), { recursive: true });
    const fake = startFake("erroring-claude", { reply: null });
    registerFake(fake);
    const sent = await runCli(["send", "please do this", "--no-wait"], { CODEX_COLLAB_PROJECTS_DIR: projects });
    const id = taskIdOf(sent.stdout);
    // Claude Code's word for a turn that died on an API error, written after
    // the message was delivered.
    writeFileSync(join(projects, "-ws", `${sid}.jsonl`), JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(),
      isApiErrorMessage: true, apiErrorStatus: 529, error: "server_error",
    }) + "\n");
    fake.stop();
    const lost = await runCli(["task", "wait", id, "--timeout", "20"], { CODEX_COLLAB_PROJECTS_DIR: projects });
    expect(lost.code).toBe(1);
    expect(lost.stdout).toContain(`task: ${id}  status: lost`);
    expect(lost.stdout).toMatch(/^error: 529 server_error at \S+$/m);
    // Recorded, so it survives the session and the command that asked.
    expect(taskRecord(id)).toEqual(expect.objectContaining({ status: "lost", error: expect.stringContaining("529 server_error") }));
    expect((await runCli(["task", "status", id], { CODEX_COLLAB_PROJECTS_DIR: projects })).stdout).toContain("529 server_error");
  });

  test("a user's own session whose turn died keeps the task and its address; the error is recorded", async () => {
    const projects = join(TEST_HOME, "projects-stalled");
    const sid = "00000000-0000-4000-8000-0000000000aa";
    mkdirSync(join(projects, "-ws"), { recursive: true });
    writeFileSync(join(projects, "-ws", `${sid}.jsonl`), JSON.stringify({
      type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(),
      isApiErrorMessage: true, apiErrorStatus: 529, error: "server_error",
    }) + "\n");
    const fake = startFake("dying-claude", { reply: null });
    registerFake(fake);
    const env = { CODEX_COLLAB_PROJECTS_DIR: projects, CODEX_COLLAB_STALL_POLL_MS: "40" };
    const r = await runCli(["send", "the whole job, in detail", "--timeout", "3"], env);
    // A person is in that session and can set the turn going again, so the
    // task is still open and its reply still has somewhere to land.
    expect(r.code).toBe(3);
    const id = taskIdOf(r.stdout);
    expect(fake.received).toHaveLength(1);
    await waitFor(() => !!(taskRecord(id) as { error?: string })?.error, 10_000);
    expect(taskRecord(id)).toEqual(expect.objectContaining({ status: "running", error: expect.stringContaining("529 server_error") }));
    expect((await runCli(["task", "status", id], env)).stdout).toContain("529 server_error");
    // And the reply, whenever the turn is picked up again, still arrives.
    speak(fake, fake.received[0].replyPath, "recovered later");
    const waited = await runCli(["task", "wait", id], env);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toContain("  recovered later");
    // The turn finished after all, so the note about it dying is not what
    // the next reader should be told.
    expect(taskRecord(id)).toEqual(expect.objectContaining({ status: "replied" }));
    expect(taskRecord(id)).not.toHaveProperty("error");
    const after = await runCli(["task", "status", id], env);
    expect(after.stdout).not.toContain("529");
    expect(after.stdout).not.toContain("without replying");
  });

  test("a started session whose turn died ends the task as failed, and nothing is sent to it", async () => {
    await settleSpawnState();
    const projects = join(TEST_HOME, "projects-stalled-bg");
    const sid = "cafe0001-0000-4000-8000-00000000cafe";
    mkdirSync(join(projects, "-ws"), { recursive: true });
    const binDir = join(TEST_HOME, "bin-stalled-bg");
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath, sid);
    writeConfig({ linger: 600 });
    try {
      writeFileSync(join(projects, "-ws", `${sid}.jsonl`), JSON.stringify({
        type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(),
        isApiErrorMessage: true, apiErrorStatus: 529, error: "server_error",
      }) + "\n");
      const r = await runCli(["send", "the whole job", "--timeout", "25"], { PATH: `${binDir}:${process.env.PATH}`, CODEX_COLLAB_PROJECTS_DIR: projects, CODEX_COLLAB_STALL_POLL_MS: "40" });
      // Nobody is attached to set this one going again.
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/status: failed/);
      expect(r.stdout).toContain("ended its turn without replying: 529 server_error at ");
      expect(fake.received).toHaveLength(1);
      expect(r.stdout).not.toMatch(/send again|carry on|most likely/);
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a task still waiting says nothing of an error the session carried on from", async () => {
    const projects = join(TEST_HOME, "projects-carried-on");
    const sid = "00000000-0000-4000-8000-0000000000aa";
    mkdirSync(join(projects, "-ws"), { recursive: true });
    // Hit an error, then went on working: the turn did not end there, so it
    // says nothing about this task, which is still waiting on a reply.
    // Both after the message is delivered, so neither is filtered out by
    // time: what settles it is that the error is not the last thing said.
    writeFileSync(join(projects, "-ws", `${sid}.jsonl`), [
      JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(), isApiErrorMessage: true, apiErrorStatus: 529, error: "server_error" }),
      JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 2000).toISOString() }),
      "",
    ].join("\n"));
    const fake = startFake("working-claude", { reply: null });
    registerFake(fake, { status: "busy" });
    const env = { CODEX_COLLAB_PROJECTS_DIR: projects };
    const r = await runCli(["send", "a long job", "--timeout", "1"], env);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("no reply from working-claude within 1s");
    expect(r.stdout).not.toContain("529");
    expect((await runCli(["task", "status", taskIdOf(r.stdout)], env)).stdout).not.toContain("529");
  });

  test("a started session that hit an error and carried on is never reported as dead", async () => {
    await settleSpawnState();
    const projects = join(TEST_HOME, "projects-recovers");
    const sid = "cafe0002-0000-4000-8000-00000000cafe";
    mkdirSync(join(projects, "-ws"), { recursive: true });
    const binDir = join(TEST_HOME, "bin-recovers");
    // Replies, but only after the stall watcher has had many looks at it.
    const fake = startFake(spawnedSessionName(WS), { reply: null });
    writeFakeClaude(binDir, fake.socketPath, sid);
    writeConfig({ linger: 600 });
    try {
      // The error is in its transcript, and it is NOT the last thing said:
      // the session hit it and carried on. This is the case that must not be
      // called dead — the branch that would end a started session's task.
      writeFileSync(join(projects, "-ws", `${sid}.jsonl`), [
        JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 500).toISOString(), isApiErrorMessage: true, apiErrorStatus: 500, error: "server_error" }),
        JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 600).toISOString() }),
        "",
      ].join("\n"));
      const env = { PATH: `${binDir}:${process.env.PATH}`, CODEX_COLLAB_PROJECTS_DIR: projects, CODEX_COLLAB_STALL_POLL_MS: "20" };
      const live = runCliLive(["send", "a long job", "--timeout", "25"], env);
      await waitFor(() => fake.received.length === 1, 15_000);
      // Long past the watcher's twenty looks at 20ms, and still nothing.
      await new Promise((res) => setTimeout(res, 2000));
      speak(fake, fake.received[0].replyPath, "slow but here");
      const r = await live.done;
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("  slow but here");
      expect(r.stdout).not.toContain("failed");
      expect(taskRecord(taskIdOf(r.stdout))).toEqual(expect.objectContaining({ status: "replied" }));
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });

  test("a message that cannot be delivered fails the send, with the reason, and an unknown task id is an error", async () => {
    const fake = startFake("deaf-claude", { reply: null });
    registerFake(fake);
    // Registered and alive, but nothing listens at its socket any more.
    fake.server.stop(true);
    try { unlinkSync(fake.socketPath); } catch { /* gone */ }
    writeFileSync(fake.socketPath, "");
    const r = await runCli(["send", "--to", "deaf-claude", "hello?"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Could not reach deaf-claude");
    expect(r.stderr).toContain("`codex-collab peers` shows who is live");
    expect(r.stdout).not.toContain("Sent to");
    unlinkSync(fake.socketPath);

    const none = await runCli(["task", "status", "ffffffff"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('No task "ffffffff" in this workspace');
    const bare = await runCli(["task", "wait"]);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("No task id given");
  });

  test("`send <peer> -` reads the message from stdin", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const r = await runCli(["send", "fake-claude", "-"], {}, "from stdin\nline two\n");
    expect(r.code).toBe(0);
    expect(fake.received[0].text.startsWith("from stdin\nline two\n\n(From Codex thread")).toBe(true);
  });

  test("a --to prefix that matches several sessions lists them", async () => {
    registerFake(startFake("alpha-claude"));
    registerFake(startFake("alpha-two"));
    const r = await runCli(["send", "--to", "alpha", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"alpha" matches several sessions: alpha-claude, alpha-two');
  });

  test("a session name with no message is an error, not a message", async () => {
    const fake = startFake("alpha-claude");
    registerFake(fake);
    const r = await runCli(["send", "alpha-claude"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No message provided");
    expect(fake.received).toHaveLength(0);
  });

  test("a command Codex runs outside its sandbox is not refused, though Codex still marks the network off", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const r = await runCli(["send", "hi"], { CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("REPLY FROM fake-claude");
  });

  test("a named session that is not live: the one started here is resumed, any other name is refused, and nobody else is sent it", async () => {
    await settleSpawnState();
    const binDir = join(TEST_HOME, "bin-named-resume");
    const fake = startFake(spawnedSessionName(WS), { reply: (t) => `resumed says: ${t.split("\n")[0]}` });
    writeFakeClaude(binDir, fake.socketPath);
    writeConfig({ linger: 600 });
    const env = { PATH: `${binDir}:${process.env.PATH}` };
    try {
      expect((await runCli(["send", "one"], env)).stdout).toContain(`Started ${fake.name}`);
      // The session goes (its reaper records it stopped), and the user has a
      // session of their own open in the workspace.
      killFakeSleepers(binDir);
      for (const f of readdirSync(REGISTRY)) unlinkSync(join(REGISTRY, f));
      await waitFor(() => (spawnedRecords() as Array<{ stoppedAt?: string }>).some((r) => r.stoppedAt), 15_000);
      const users = startFake("the-users-own", { reply: () => "not me" });
      registerFake(users);
      const named = await runCli(["send", fake.name, "review this"], env);
      expect(named.code).toBe(0);
      expect(named.stdout).toContain(`${fake.name} is not live — resuming ${fake.name}`);
      expect(named.stdout).toContain("  resumed says: review this");
      expect(readFileSync(join(binDir, "args.log"), "utf-8").split("\n")).toContain("--resume");
      // A name that is nobody's is refused however the message comes.
      const nobody = await runCli(["send", "gone-claude", "review this"], env);
      expect(nobody.code).toBe(1);
      expect(nobody.stderr).toContain('No live Claude Code session named "gone-claude"');
      const piped = await runCli(["send", "gone-claude", "-"], env, "review this\n");
      expect(piped.code).toBe(1);
      expect(piped.stderr).toContain('No live Claude Code session named "gone-claude"');
      expect(users.received).toHaveLength(0);
    } finally {
      removeConfig();
      killFakeSleepers(binDir);
    }
  });
});
