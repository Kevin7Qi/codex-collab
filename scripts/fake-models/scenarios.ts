import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureConnection, isBrokerAlive, loadBrokerState, parseEndpoint } from "../../src/broker";
import { connectToBroker } from "../../src/broker-client";
import { readHostClaim } from "../../src/claude-channel";
import { procStartTicksOf, sessionsDir } from "../../src/claude-registry";
import { parseBackgroundId } from "../../src/claude-sessions";
import { connectDirect, type AppServerClient } from "../../src/client";
import { EXIT_CODES } from "../../src/commands/shared";
import { resolveStateDir } from "../../src/config";
import { readPeerState } from "../../src/peer";
import type { ThreadStartResponse, TurnCompletedParams } from "../../src/types";
import { toolCommand } from "./setup";

const cwd = process.cwd();
const home = homedir();
assert(process.env.COLLAB_FIXTURE_KEY === "fixture-invalid-key" && process.env.CODEX_HOME === join(home, ".codex") && cwd === join(home, "ws"),
  "Run via bun run test:fake-models, not directly");
const stateDir = resolveStateDir(cwd);
const cli = [process.execPath, join(import.meta.dir, "../../src/cli.ts")];
const model = "gpt-5.4";
const commandLog = join(home, "commands.log");
const modelLog = join(home, "model.jsonl");
const jobs = new Set<string>();
let claudeUsed = false;

async function command(argv: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(argv, {
    cwd, env: { ...process.env, ...env }, stdin: "ignore",
    stdout: "pipe", stderr: "pipe", timeout: 40_000, killSignal: "SIGKILL",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  appendFileSync(commandLog, `$ ${argv.join(" ")}\nexit ${code}\n${stdout}${stderr}\n`);
  return { code, stdout, stderr, output: stdout + stderr };
}

async function ok(argv: string[], env?: Record<string, string>) {
  const result = await command(argv, env);
  assert.equal(result.code, 0, result.output);
  return result.output;
}

const run = (...args: string[]) => [...cli, "run", "--model", model, "--sandbox", "read-only", "--timeout", "20", ...args];
function claude(...args: string[]) {
  claudeUsed = true;
  return toolCommand("claude", ...args);
}

async function until<T>(look: () => T | undefined, label: string, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = look();
    if (value !== undefined) return value;
    await Bun.sleep(75);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForTurn(client: AppServerClient, threadId: string) {
  const { promise, resolve } = Promise.withResolvers<TurnCompletedParams["turn"]>();
  const off = client.on("turn/completed", params => {
    const event = params as TurnCompletedParams;
    if (event.threadId === threadId) resolve(event.turn);
  });
  return {
    async wait() {
      const { promise: timeout, reject } = Promise.withResolvers<never>();
      const timer = setTimeout(() => reject(new Error(`No turn completion for ${threadId}`)), 10_000);
      try { return await Promise.race([promise, timeout]); }
      finally { clearTimeout(timer); off(); }
    },
  };
}

const thread = (client: AppServerClient) => client.request<ThreadStartResponse>("thread/start", { cwd, model, sandbox: "read-only", approvalPolicy: "never" });
const turn = (client: AppServerClient, threadId: string, text: string) => client.request("turn/start", { threadId, input: [{ type: "text", text }] });
const logs = () => existsSync(modelLog) ? readFileSync(modelLog, "utf8") : "";

async function runScenario() {
  assert.match(await ok(run("--content-only", "FIXTURE_RUN")), /FIXTURE_RUN_OK/);
}

async function detach() {
  const started = await ok(run("--detach", "FIXTURE_DETACH"));
  const detached = started.match(/Detached: thread (\S+) running/);
  assert(detached, started);
  const output = await ok([...cli, "follow", detached[1]]);
  assert.match(output, /FIXTURE_DETACH_OK/);
  assert.match(output, /completed/);
}

async function broker() {
  const a = await ensureConnection(cwd, true);
  try {
    const endpoint = loadBrokerState(stateDir)?.endpoint;
    assert(a.isBrokered && endpoint, "Expected a running workspace broker, not a direct fallback");
    const b = await connectToBroker({ endpoint });
    try {
      const one = (await thread(a)).thread.id;
      const two = (await thread(b)).thread.id;
      assert.notEqual(one, two);
      const doneA = waitForTurn(a, one);
      const doneB = waitForTurn(b, two);
      let finishedOne = false;
      a.on("turn/completed", p => { if ((p as TurnCompletedParams).threadId === one) finishedOne = true; });
      await turn(a, one, "FIXTURE_BROKER_A");
      await assert.rejects(turn(b, one, "Unexpected same-thread turn"), (error: unknown) => (
        (error as { rpcCode?: number }).rpcCode === -32001
      ));
      await turn(b, two, "FIXTURE_BROKER_B");
      assert(!finishedOne, "Second thread was not started concurrently with the first");
      const completed = await Promise.all([doneA.wait(), doneB.wait()]);
      assert.deepEqual(completed.map(t => t.status), ["completed", "completed"]);
    } finally { await b.close(); }
  } finally { await a.close(); }
}

async function send() {
  const result = await ok(toolCommand("codex", "exec", "--json", "FIXTURE_SENDER"));
  const started = result.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(event => event.type === "thread.started");
  assert(started?.thread_id, "Codex did not start a sender thread");
  const env = { CODEX_THREAD_ID: started.thread_id };
  claudeUsed = true;
  const output = await ok([...cli, "send", "--new", "FIXTURE_SEND verify auto-spawn and mailbox", "--timeout", "20"], env);
  assert.match(output, /Starting a new session.*background/i);
  assert.match(output, /status: replied/);
  assert.match(output, /FIXTURE_MAILBOX_REPLY/);
  assert.match(await ok([...cli, "messages"], env), /FIXTURE_MAILBOX_REPLY/);
}

type PeerRecord = { cwd?: string; name?: string; pid?: number; procStart?: string };
function normalizeFixtureRegistry() {
  for (const name of readdirSync(sessionsDir()).filter(name => /^\d+\.json$/.test(name))) {
    const file = join(sessionsDir(), name);
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as PeerRecord;
      if (entry.cwd !== cwd || !entry.name?.startsWith("codex(") || !entry.pid || /^\d+$/.test(entry.procStart ?? "")) continue;
      const ticks = procStartTicksOf(entry.pid);
      if (ticks) writeFileSync(file, JSON.stringify({ ...entry, procStart: ticks }));
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function peer(useDefaultModel = false) {
  await ok([...cli, "peer", "up"]);
  const state = readPeerState(stateDir);
  assert(state, "Broker did not register a front-door peer");
  let listed = await ok(claude("agents", "--json"));
  let normalizer: ReturnType<typeof setInterval> | undefined;
  try {
    if (!listed.includes(state.name) && process.platform === "linux") {
      console.log("  Applying Linux start-tick compatibility workaround in the fixture registry");
      normalizeFixtureRegistry();
      normalizer = setInterval(normalizeFixtureRegistry, 75);
      listed = await ok(claude("agents", "--json"));
    }
    assert(listed.includes(state.name), "Claude agents did not list the workspace peer");
    assert((await ok(claude("-p", "FIXTURE_LIST"))).includes(state.name), "ListAgents did not return the workspace peer");
    const offset = logs().length;
    const marker = useDefaultModel ? "FIXTURE_PEER_DEFAULT" : "FIXTURE_PEER";
    const output = await ok(claude("--bg", "-n", useDefaultModel ? "fixture-peer-default" : "fixture-peer",
      "--permission-mode", "default", "--settings", '{"worktree":{"bgIsolation":"none"}}', `${marker} ${state.name}`));
    const id = parseBackgroundId(output);
    assert(id, output);
    jobs.add(id);
    const trace = await until(() => {
      const trace = logs().slice(offset);
      if (trace.includes("FIXTURE_CLAUDE_RECEIVED_CODEX_REPLY") && /"returned":.*FIXTURE_CONSULT_ANSWER/.test(trace)) return trace;
    }, "Claude → Codex → collab.consult → Claude", 25_000);
    assert.match(trace, /"name":"consult"|"type":"custom_tool_call".*tools\.collab__consult/);
  } finally {
    clearInterval(normalizer);
  }
}

async function failures() {
  const failed = await command(run("FIXTURE_ERROR"));
  assert.equal(failed.code, EXIT_CODES.failed, failed.output);
  assert.match(failed.output, /FIXTURE_MID_TURN_ERROR/);
  const timeout = await command(run("--timeout", "1", "FIXTURE_TIMEOUT"));
  assert.equal(timeout.code, EXIT_CODES.timeout, timeout.output);
  assert.match(timeout.output, /timed out/i);
}

async function held() {
  const owner = await connectDirect();
  try {
    const { thread: { id } } = await thread(owner);
    const done = waitForTurn(owner, id);
    await turn(owner, id, "FIXTURE_HELD");
    assert.equal((await done.wait()).status, "completed");
    const result = await command(run("--resume", id, "Unexpected resume"));
    assert.equal(result.code, EXIT_CODES.threadHeld, result.output);
    assert.match(result.output, /open for writing in another Codex process/);
  } finally { await owner.close(); }
}

async function cleanup() {
  try {
    if (claudeUsed) {
      for (const job of jobs) await command(claude("stop", job));
      await ok(claude("daemon", "stop", "--any"));
      const reapers = join(stateDir, "reapers");
      await until(() => readHostClaim(stateDir) || (existsSync(reapers) && readdirSync(reapers).some(file => file.endsWith(".log")))
        ? undefined : true, "fixture channel host and Claude reaper shutdown");
    }
  } finally {
    const endpoint = loadBrokerState(stateDir)?.endpoint;
    if (endpoint && await isBrokerAlive(endpoint)) {
      const client = await connectToBroker({ endpoint });
      try { await client.request("broker/shutdown"); }
      finally { await client.close(); }
      const target = parseEndpoint(endpoint);
      if (target.kind === "unix") {
        await until(() => existsSync(target.path) ? undefined : true, "broker shutdown");
      }
    }
  }
}

async function contract() {
  const file = join(import.meta.dir, "../../contracts/contracts.test.ts");
  const output = await ok([process.execPath, "test", file, "-t", "item/tool/call delivers plaintext"], { CODEX_COLLAB_CONTRACTS: "1" });
  assert.match(output, /1 pass/);
}

const scenarios: Record<string, () => Promise<void>> = {
  run: runScenario, detach, broker, send, peer, "peer-default": () => peer(true), failures, held, contract,
};
const selected = process.argv[2];
if (selected && !Object.hasOwn(scenarios, selected)) throw new Error(`Unknown scenario "${selected}"; choose ${Object.keys(scenarios).join(", ")}`);
let failed = false;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { interrupted = true; });
try {
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (interrupted || (selected && selected !== name)) continue;
    if (process.platform === "win32" && (name === "send" || name === "peer" || name === "peer-default")) {
      console.log(`SKIP ${name} (Claude cross-session messaging unavailable on Windows)`);
      continue;
    }
    try {
      await scenario();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${name}:`, error);
    }
  }
} finally { await cleanup(); }
process.exitCode = failed || interrupted ? 1 : 0;
