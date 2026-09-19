// src/commands/send.test.ts — `send` and `peers` against a fake Claude Code session
//
// The fake session is a unix socket served by this test process, registered
// (under this process's pid) in an isolated registry; the CLI runs as a
// subprocess against an isolated HOME, so its own transient registration
// and socket never touch the real ones. The reply leg is exercised for
// real: the fake connects back to the address the CLI advertised.

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope, buildRegistryEntry, parseEnvelope, procStartOf, workspaceSuffix } from "../peer";
import { spawnedSessionName } from "../claude-sessions";
import { codexThreadId, composeMessage, insideCodexSandbox, senderName, splitTarget } from "./send";
import { formatSessions, unverifiedNotice } from "./peers";

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
  reply: ((text: string) => string) | null;
  server: ReturnType<typeof Bun.listen>;
  entryPath: string;
  stop(): void;
}

let fakes: FakeSession[] = [];
let n = 0;

/** A fake Claude session: registered, listening, replying (unless told not
 *  to) by connecting back to the sender's advertised address. */
function startFake(name: string, opts: { reply?: ((text: string) => string) | null; cwd?: string; status?: string; kind?: string } = {}): FakeSession {
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
          if (fake.reply) {
            const answer = fake.reply(msg.text);
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
  return { ...env, HOME: TEST_HOME, CODEX_COLLAB_SESSIONS_DIR: REGISTRY, CODEX_COLLAB_NO_UPDATE_CHECK: "1", CODEX_COLLAB_REAP_POLL_MS: "500", CODEX_THREAD_ID: THREAD, ...extra };
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
function writeFakeClaude(binDir: string, socketPath: string): void {
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
    printf '{"pid":%s,"sessionId":"s","cwd":"%s","startedAt":%s,"procStart":"%s","version":"2.1.261","peerProtocol":1,"kind":"bg","entrypoint":"cli","messagingSocketPath":"%s","name":"%s","nameSource":"peer","status":"idle","updatedAt":%s,"statusUpdatedAt":%s}' \\
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

  test("senderName names the thread and the workspace", () => {
    expect(senderName(WS, THREAD)).toBe(`codex(01a0985a-${workspaceSuffix(WS)})`);
    expect(senderName(WS, null)).toBe(`codex(shell-${process.pid}-${workspaceSuffix(WS)})`);
  });

  test("composeMessage says who is asking and whether it waits", () => {
    const waiting = composeMessage("hello", { threadId: THREAD, wait: true, timeoutSec: 600 });
    expect(waiting.startsWith("hello\n\n")).toBe(true);
    expect(waiting).toContain(`Codex thread ${THREAD}`);
    expect(waiting).toContain("waits up to 10m");
    const note = composeMessage("fyi", { threadId: null, wait: false, timeoutSec: 600 });
    expect(note).toContain("a Codex session");
    expect(note).toContain("not waiting for a reply");
  });

  test("splitTarget: --to, a leading live name, or no target", () => {
    const sessions = [{ name: "alpha" }] as Parameters<typeof splitTarget>[2];
    expect(splitTarget(["hi", "there"], "beta", sessions)).toEqual({ targetName: "beta", message: "hi there" });
    expect(splitTarget(["alpha", "hi", "there"], null, sessions)).toEqual({ targetName: "alpha", message: "hi there" });
    // A live session's name alone is a forgotten message, not a message.
    expect(splitTarget(["alpha"], null, sessions)).toEqual({ targetName: "alpha", message: "" });
    expect(splitTarget(["beta"], null, sessions)).toEqual({ targetName: null, message: "beta" });
    expect(splitTarget(["hi", "alpha"], null, sessions)).toEqual({ targetName: null, message: "hi alpha" });
  });
});

describeUnix("peers", () => {
  test("formatSessions aligns columns and annotates spawned sessions", () => {
    const out = formatSessions([
      { pid: 1, name: "Explore", status: "idle", kind: "interactive", cwd: "/", socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: null, spawned: null },
      { pid: 2, name: "claude(ws-abc123)", status: "idle", kind: "bg", cwd: "/", socketPath: "/s", sessionId: null, procStart: null, verified: true, statusUpdatedAt: 1_000_000, spawned: { id: "x", pid: 2, name: "claude(ws-abc123)", startedAt: "t", lingerSec: 1800 } },
    ], 1_000_000 + 4 * 60_000);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^ {2}NAME +STATUS +KIND$/);
    expect(lines[1]).toMatch(/^ {2}Explore +idle +interactive$/);
    expect(lines[2]).toMatch(/^ {2}claude\(ws-abc123\) +idle +background +started by codex-collab · idle 4m 0s · stops after 30m 0s idle$/);
  });

  test("a session listed on its socket alone is marked on its row only where rows differ; when none could be checked, it is said once", () => {
    const row = (name: string, verified: boolean) =>
      ({ pid: 1, name, status: "idle" as const, kind: "interactive", cwd: "/", socketPath: "/s", sessionId: null, procStart: "236353382", verified, statusUpdatedAt: null, spawned: null });
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

  test("peers does not refuse under the sandbox marker", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const listed = await runCli(["peers"], { CODEX_SANDBOX: "seatbelt" });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("fake-claude");
  });
});

describeUnix("send", () => {
  test("delivers to the only live session, prints its reply, and cleans up its registration", async () => {
    const fake = startFake("fake-claude");
    registerFake(fake);
    const before = new Set(readdirSync(REGISTRY));
    const r = await runCli(["send", "hello", "there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sending to fake-claude — the only Claude Code session in this workspace.");
    expect(r.stdout).toContain("Sent to fake-claude. Waiting up to 10m");
    expect(r.stdout).toContain("REPLY FROM fake-claude");
    expect(r.stdout).toContain("  pong: hello there");
    // What the session received: the message, then who sent it.
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0].fromName).toBe(`codex(01a0985a-${workspaceSuffix(WS)})`);
    expect(fake.received[0].text).toContain(`Codex thread ${THREAD}`);
    expect(fake.received[0].text).toContain("waits up to 10m");
    // The transient registration and socket are gone with the command.
    expect(new Set(readdirSync(REGISTRY))).toEqual(before);
    expect(existsSync(fake.received[0].replyPath)).toBe(false);
  });

  test("no reply within the deadline fails open with a notice, exit 0", async () => {
    const fake = startFake("quiet-claude", { reply: null });
    registerFake(fake);
    const r = await runCli(["send", "anyone?", "--timeout", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("NO REPLY from quiet-claude within 1s");
    expect(r.stdout).toContain("Proceed on your own judgment");
  });

  test("a busy session is delivered to with a note that the message joins its turn", async () => {
    const fake = startFake("busy-claude");
    registerFake(fake, { status: "busy" });
    const r = await runCli(["send", "ping"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("It is busy — your message joins its current turn.");
    expect(r.stdout).toContain("REPLY FROM busy-claude");
  });

  test("--no-wait sends a one-way note and returns", async () => {
    const fake = startFake("fake-claude", { reply: null });
    registerFake(fake);
    const r = await runCli(["send", "heads-up", "--no-wait"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sent to fake-claude. Not waiting for a reply.");
    expect(r.stdout).not.toContain("REPLY");
    await waitFor(() => fake.received.length === 1);
    expect(fake.received[0].text).toContain("not waiting for a reply");
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
    // "other" speaks first; the real reply follows once the CLI has noted it.
    speak(other, replyPath, "not for you");
    await waitFor(() => live.stdout().includes("(A message from other-claude arrived meanwhile"));
    speak(target, replyPath, "real: question");
    const r = await live.done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(A message from other-claude arrived meanwhile; still waiting for target-claude.)");
    expect(r.stdout).toContain("REPLY FROM target-claude");
    expect(r.stdout).toContain("  real: question");
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
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(r.stdout).toContain(`NO REPLY from ${fake.name}: it has stopped at a prompt`);
      expect(r.stdout).toContain("This one runs on haiku, default effort.");
      expect(r.stdout).toContain("It has been stopped. Send again with a model that has auto mode");
      expect(readFileSync(join(binDir, "stop.log"), "utf-8")).toContain("stop cafe0001\n");
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
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("NO REPLY from asking-claude within 1s");
    expect(r.stdout).toContain("It is waiting at a prompt in its own terminal");
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

  test("an interrupted send removes its registration and its socket", async () => {
    const fake = startFake("quiet-claude", { reply: null });
    registerFake(fake);
    const live = runCliLive(["send", "hold on", "--timeout", "60"]);
    await waitFor(() => fake.received.length === 1);
    const ours = () => readdirSync(REGISTRY).filter((f) => {
      try { return String(JSON.parse(readFileSync(join(REGISTRY, f), "utf-8")).name).startsWith("codex(01a0985a"); } catch { return false; }
    });
    expect(ours()).toHaveLength(1);
    expect(existsSync(fake.received[0].replyPath)).toBe(true);
    live.child.kill("SIGINT");
    const r = await live.done;
    expect(r.code).toBe(130);
    expect(ours()).toHaveLength(0);
    expect(existsSync(fake.received[0].replyPath)).toBe(false);
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
});
