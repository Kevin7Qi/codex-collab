// src/commands/uninstall.ts — `codex-collab uninstall`: take off this machine
// everything codex-collab put on it. That is the hooks and the rule it gave
// Codex, both skills, the command, its state and mailboxes, and the processes
// it left running.
//
// Work in flight holds it up: a Codex turn that is running, or a Claude Code
// session codex-collab started that is busy, would lose its work. A task
// still waiting on a reply does not: it can wait for hours, and with
// codex-collab gone nothing would collect the reply anyway. Its wait is
// stopped with the rest, and the plan the user agrees to says so.
//
// Nothing is removed until every process is stopped, so a stop that fails
// leaves codex-collab installed and working. Removal goes from Codex's side
// to Claude's, and the command itself goes last.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { config, mailboxRoot } from "../config";
import { codexHooksPath, hooksAfterOurs, ourHooksPrint, removeCodexHooks } from "../codex-hooks";
import { codexRulesInstallPath, codexSkillInstallDir, removeCodexRules, skillInstallDir } from "../skill";
import { listRuns } from "../threads";
import { listTasks, settled } from "../claude-tasks";
import { jobHasWorkInFlight, locateSpawnedSession, markSpawnedSessionStopped, readSpawnedSessions, stopSpawnedSession } from "../claude-sessions";
import { readHostClaim, readHostState } from "../claude-channel";
import { isBrokerAlive, isBrokerBusyError, loadBrokerState } from "../broker";
import { connectToBroker } from "../broker-client";
import { isCodexCollabSocket, procIdentity, sessionsDir, type ProcIdentity } from "../peer";
import { isAlive } from "./peer";
import { insideCodexSandbox } from "./send";
import { die, requireConsent } from "./shared";

/** A run left "running" by a runner that died without a word, and recorded
 *  before runs named their runner, reads as work after this long no more. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000;

/** How a step went: done (null, or with a line of its own to say), or
 *  what went wrong. */
type Outcome = null | { said: string } | string;

interface Step {
  /** What it is, as the plan lists it. */
  what: string;
  run: () => Promise<Outcome> | Outcome;
  /** Nothing after it is removed when it fails: with codex-collab's hooks
   *  left in Codex, the command they run must stay. */
  critical?: boolean;
}

interface Plan {
  /** Work in flight, each with how to end it: while any is listed, nothing
   *  is done. */
  busy: string[];
  /** What must be put right first, each with why: while any is listed,
   *  nothing is done either. */
  blockers: string[];
  stops: Step[];
  removals: Step[];
  /** What stays, for the report. */
  stays: string[];
  /** Said once the command is gone, where that needs saying. */
  after: string[];
}

/** Every workspace's state folder. */
function workspaceStateDirs(): string[] {
  const root = join(config.dataDir, "workspaces");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.map((n) => join(root, n)).filter((d) => {
    try { return lstatSync(d).isDirectory(); } catch { return false; }
  });
}

/** Wait until `gone()` holds, for up to `ms`. */
async function waitUntil(gone: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await gone()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Whether a process is still the one a record names: the same process by
 *  its identity, running codex-collab's `sub` as far as its command line can
 *  be read. A record without a start time names only a pid, which the system
 *  may since have given to anything. */
function stillOurs(identity: Record<string, unknown>, sub: string): ProcIdentity {
  const id = procIdentity(identity);
  if (id !== "live") return id;
  const line = commandLineOf(identity.pid as number);
  return line === null || line.includes(sub) ? "live" : "dead";
}

/** Signal a process, once it is verifiably the one named, and see it gone.
 *  One that cannot be checked from here is never signalled: its pid may be
 *  another process's. */
function stopProcess(identity: Record<string, unknown>, sub: string, what: string): () => Promise<string | null> {
  return async () => {
    const now = stillOurs(identity, sub);
    if (now === "dead") return null;
    if (now !== "live") return `${what} can no longer be checked from here`;
    try { process.kill(identity.pid as number, "SIGTERM"); } catch { /* gone meanwhile */ }
    return (await waitUntil(() => stillOurs(identity, sub) === "dead", 10_000)) ? null : `${what} is still running`;
  };
}

/** A process's command line, or null when it is not running (or cannot be
 *  read). */
function commandLineOf(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").join(" ").trim() || null;
  } catch { /* no /proc: ask ps */ }
  const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf-8", timeout: 5000 });
  return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : null;
}

/** Whether `pid` is a codex-collab process: alive, and running the CLI as
 *  far as its command line can be read. A runner that crashed leaves its pid
 *  in its record, and the system may give that pid to anything. */
function runsCodexCollab(pid: number): boolean {
  if (!isAlive(pid)) return false;
  const line = commandLineOf(pid);
  return line === null || /codex-collab|cli\.ts/.test(line);
}

/** The reapers watching this workspace's started sessions. Each keeps a log
 *  named for its session and its pid while it runs (see reaperLog), and is
 *  taken for one only while that pid runs `reap-claude` for that session. */
function liveReapers(stateDir: string): Array<{ pid: number; id: string }> {
  let names: string[];
  try {
    names = readdirSync(join(stateDir, "reapers"));
  } catch {
    return [];
  }
  const found: Array<{ pid: number; id: string }> = [];
  for (const name of names) {
    const m = /^(.+)-(\d+)\.log$/.exec(name);
    if (!m) continue;
    const pid = Number(m[2]);
    const line = commandLineOf(pid);
    if (line && line.includes("reap-claude") && line.includes(m[1])) found.push({ pid, id: m[1] });
  }
  return found;
}

/** What runs in a workspace: the work that holds the uninstall up, and the
 *  processes it stops. The waits on replies go first, so that no session
 *  stopped under one reads to it as lost and has the thread told; then the
 *  reapers, which would otherwise write their records again after they are
 *  removed; the sessions they watch; the channel host, whose addresses all of
 *  those talk through; and the broker last. */
async function surveyWorkspace(stateDir: string, plan: Plan): Promise<void> {
  const ws = basename(stateDir);
  const now = Date.now();
  for (const r of listRuns(stateDir)) {
    if (r.status !== "running") continue;
    if (typeof r.pid === "number" ? !runsCodexCollab(r.pid) : now - Date.parse(r.startedAt) > STALE_RUN_MS) continue;
    plan.busy.push(`a Codex turn on thread ${r.shortId} (workspace ${ws}): wait for it, or stop it with \`codex-collab kill ${r.shortId}\` in that workspace`);
  }
  const waits: Step[] = [];
  for (const listed of listTasks(stateDir)) {
    const t = settled(listed);
    if ((t.status !== "pending" && t.status !== "running") || !t.receiver) continue;
    const { pid, procStart, pidDomain } = t.receiver;
    const identity = { pid, ...(procStart ? { procStart } : {}), ...(pidDomain ? { pidDomain } : {}) };
    const seen = stillOurs(identity, "recv-task");
    if (seen === "dead") continue;
    if (seen !== "live") {
      plan.busy.push(`the process waiting on ${t.target.name}'s reply to task ${t.id} (workspace ${ws}, pid ${pid}) runs where this command cannot check it: stop it from there, or wait for the task to end`);
      continue;
    }
    waits.push({
      what: `the wait for ${t.target.name}'s reply to task ${t.id} (workspace ${ws}); a reply that comes later goes nowhere`,
      run: stopProcess(identity, "recv-task", `the process waiting on task ${t.id}`),
    });
  }
  const reapers: Step[] = liveReapers(stateDir).map(({ pid, id }) => ({
    what: `the reaper of session ${id} (workspace ${ws}, pid ${pid})`,
    run: async () => {
      const still = () => (commandLineOf(pid) ?? "").includes("reap-claude");
      if (!still()) return null;
      try { process.kill(pid, "SIGTERM"); } catch { /* gone meanwhile */ }
      return (await waitUntil(() => !still(), 10_000)) ? null : `the reaper of session ${id} is still running`;
    },
  }));
  // Only an idle session is stopped. One at a prompt has a turn it has not
  // finished, which the user may yet answer through Remote Control.
  const atWork = (entry: Record<string, unknown>, id: string) => entry.status !== "idle" || jobHasWorkInFlight(id);
  const sessions: Step[] = [];
  for (const s of readSpawnedSessions(stateDir)) {
    if (s.stoppedAt) continue;
    const entry = locateSpawnedSession(s);
    if (!entry) continue;
    if (atWork(entry, s.id)) {
      plan.busy.push(`${s.name}, a Claude Code session codex-collab started, is ${entry.status === "waiting" ? "at a prompt" : "working"} (workspace ${ws}): wait for it, or stop it with \`codex-collab peers stop ${s.name}\` in that workspace`);
      continue;
    }
    sessions.push({
      what: `${s.name}, the idle Claude Code session codex-collab started (workspace ${ws}); Claude Code keeps its conversation`,
      run: async () => {
        const now = locateSpawnedSession(s);
        if (!now) return null;
        if (atWork(now, s.id)) return `${s.name} took up work meanwhile`;
        const { gone } = await stopSpawnedSession(s);
        if (!gone) return `${s.name} is still running`;
        markSpawnedSessionStopped(stateDir, s.id);
        return null;
      },
    });
  }
  plan.stops.push(...waits, ...reapers, ...sessions);
  const hosts = new Map<number, Record<string, unknown>>();
  for (const h of [readHostState(stateDir), readHostClaim(stateDir)]) {
    if (!h || hosts.has(h.pid)) continue;
    hosts.set(h.pid, { pid: h.pid, ...(h.procStart ? { procStart: h.procStart } : {}), ...(h.pidDomain ? { pidDomain: h.pidDomain } : {}) });
  }
  for (const [pid, identity] of hosts) {
    const seen = stillOurs(identity, "channel-host");
    if (seen === "dead") continue;
    if (seen !== "live") {
      plan.busy.push(`the channel host for workspace ${ws} (pid ${pid}) runs where this command cannot check it: stop it from there`);
      continue;
    }
    plan.stops.push({ what: `the channel host for workspace ${ws} (pid ${pid})`, run: stopProcess(identity, "channel-host", `the channel host for workspace ${ws}`) });
  }
  const broker = loadBrokerState(stateDir);
  const endpoint = broker?.endpoint ?? null;
  if (endpoint && await isBrokerAlive(endpoint)) {
    plan.stops.push({
      what: `the broker for workspace ${ws}${broker?.pid ? ` (pid ${broker.pid})` : ""}`,
      run: async () => {
        try {
          const client = await connectToBroker({ endpoint });
          try {
            await client.request("broker/shutdown", { ifIdle: true });
          } finally {
            await client.close().catch(() => undefined);
          }
        } catch (e) {
          if (isBrokerBusyError(e)) return `a Codex turn started on the broker for workspace ${ws} just now`;
          // Gone between the look and now: nothing to stop.
        }
        // Its socket closes before it has finished going: see the process out
        // too, which writes its state as it goes.
        const pid = broker?.pid ?? null;
        const gone = async () => !(await isBrokerAlive(endpoint)) && (pid === null || !isAlive(pid));
        return (await waitUntil(gone, 10_000)) ? null : `the broker for workspace ${ws} is still running`;
      },
    });
  }
}

/** Whether a registry entry is one codex-collab's processes left behind
 *  when they were killed outright: a socket of ours, a process gone. */
function isStaleEntry(path: string): boolean {
  try {
    const entry = JSON.parse(readFileSync(path, "utf-8"));
    return isCodexCollabSocket(entry?.messagingSocketPath) && procIdentity(entry) === "dead";
  } catch {
    return false;
  }
}

/** The stale entries in Claude Code's session registry. */
function staleRegistryEntries(): string[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => join(sessionsDir(), f)).filter(isStaleEntry);
}

/** The mailboxes' root, under the temp folder, when there is one of ours. */
function mailboxes(): string | null {
  const root = mailboxRoot();
  try {
    const s = lstatSync(root);
    return s.isDirectory() && (typeof process.getuid !== "function" || s.uid === process.getuid()) ? root : null;
  } catch {
    return null;
  }
}

/** The folder a command link or shim is in. */
function binDir(): string {
  return join(homedir(), ".local", "bin");
}

/** Whether a command's target is the CLI an installer points it at: the
 *  skill's own `scripts/codex-collab`, or the `src/cli.ts` of a codex-collab
 *  checkout (`--dev`), here or since deleted. */
function isCliTarget(target: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/");
  if (norm(target) === norm(join(skillInstallDir(), "scripts", "codex-collab"))) return true;
  if (!norm(target).endsWith("/src/cli.ts")) return false;
  if (!existsSync(target)) return true;
  try {
    return JSON.parse(readFileSync(join(dirname(dirname(target)), "package.json"), "utf-8"))?.name === "codex-collab";
  } catch {
    return false;
  }
}

/** Whether `path` is a command the installers made: on Unix a link to the
 *  CLI, on Windows a shim that runs it with bun. */
function isOurCommand(path: string): boolean {
  let s;
  try {
    s = lstatSync(path);
  } catch {
    return false;
  }
  if (s.isSymbolicLink()) {
    try { return isCliTarget(resolve(dirname(path), readlinkSync(path))); } catch { return false; }
  }
  if (process.platform !== "win32" || !s.isFile() || s.size > 4096) return false;
  try {
    const m = /\bbun "([^"]+)"/.exec(readFileSync(path, "utf-8"));
    return !!m && isCliTarget(m[1]);
  } catch {
    return false;
  }
}

function removeTree(path: string): string | null {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    return `could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`;
  }
  return existsSync(path) ? `could not remove ${path}` : null;
}

/** Remove what an installer put in `dir`, and then `dir` itself once it is
 *  empty: a folder named in an override may hold the user's own files. */
function removeInstalled(dir: string, entries: string[]): string | null {
  for (const entry of entries) {
    const failed = removeTree(join(dir, entry));
    if (failed) return failed;
  }
  for (const sub of [...new Set(entries.filter((e) => e.includes("/")).map((e) => e.slice(0, e.lastIndexOf("/")))), "."]) {
    try { rmdirSync(join(dir, sub)); } catch { /* not empty, or gone */ }
  }
  return null;
}

/** What is left in a folder after its installed files went, for the report. */
function leftIn(dir: string): string | null {
  try {
    return readdirSync(dir).length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** The step that removes an installed folder: what the installer put in it,
 *  then the folder, unless the user keeps files of their own there. */
function installedFolder(name: string, dir: string, entries: string[]): Step {
  return {
    what: `${name} ${dir}`,
    run: () => {
      // A folder the user linked in place: the link goes, and what it leads
      // to stays theirs.
      try {
        if (lstatSync(dir).isSymbolicLink()) {
          unlinkSync(dir);
          return { said: `Removed the link ${dir}; what it leads to stays.` };
        }
      } catch (e) {
        return `could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`;
      }
      const failed = removeInstalled(dir, entries);
      if (failed) return failed;
      const left = leftIn(dir);
      return left ? { said: `Removed ${name} from ${dir}; the folder stays, with files codex-collab did not put there.` } : null;
    },
  };
}

/** The checkout a dev install runs from, which stays. */
function devCheckout(): string | null {
  try {
    const cli = realpathSync(process.argv[1]);
    return cli.endsWith(`${sep}src${sep}cli.ts`) ? dirname(dirname(cli)) : null;
  } catch {
    return null;
  }
}

async function makePlan(): Promise<Plan> {
  const plan: Plan = { busy: [], blockers: [], stops: [], removals: [], stays: [], after: [] };
  for (const stateDir of workspaceStateDirs()) await surveyWorkspace(stateDir, plan);

  // A hooks file that cannot be read may hold hooks of ours, which would go
  // on running the command once it is gone: it is put right first.
  const hooksPath = codexHooksPath();
  const unreadable = hooksFileProblem(hooksPath);
  if (unreadable) plan.blockers.push(`${hooksPath} cannot be read (${unreadable}), so whether codex-collab's hooks are in it is unknown: put it right, then run this again`);
  else if (ourHooksPrint(hooksPath) !== null) {
    const moved = hooksAfterOurs(hooksPath);
    plan.removals.push({
      what: `codex-collab's hooks in ${hooksPath}; your own hooks there stay`
        + (moved.length > 0 ? `, and Codex asks you to trust again those that move up a place (${moved.join(", ")})` : ""),
      run: () => {
        try {
          removeCodexHooks(hooksPath);
          return null;
        } catch (e) {
          return `could not take the hooks out of ${hooksPath}: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
      critical: true,
    });
    plan.stays.push(`Codex's record of your trust in those hooks, in its config.toml, which applies to nothing once they are gone`);
  }
  const rule = codexRulesInstallPath();
  if (existsSync(rule)) {
    plan.removals.push({ what: `the Codex rule ${rule}`, run: () => { removeCodexRules(rule); return existsSync(rule) ? `could not remove ${rule}` : null; } });
  }
  // install.ps1 installs no Codex skill: one of that name on Windows is
  // someone else's.
  const codexSkill = codexSkillInstallDir();
  if (process.platform !== "win32" && existsSync(codexSkill)) plan.removals.push(installedFolder("the Codex skill", codexSkill, ["SKILL.md"]));

  const stale = staleRegistryEntries();
  if (stale.length > 0) {
    plan.removals.push({
      what: `${stale.length} ${stale.length === 1 ? "entry" : "entries"} codex-collab's processes left in Claude Code's session registry (${sessionsDir()})`,
      run: () => {
        // Looked at again: Claude Code may have written a live session's
        // entry under the same pid since.
        for (const path of stale) { if (isStaleEntry(path)) { try { unlinkSync(path); } catch { /* gone */ } } }
        return null;
      },
    });
  }
  const root = mailboxes();
  if (root) plan.removals.push({ what: `the mailboxes in ${root}`, run: () => removeTree(root) });
  plan.stays.push(`mailboxes under a temp folder other than ${dirname(mailboxRoot())}, where a session with a temp folder of its own (TMPDIR) put them`);
  if (existsSync(config.dataDir)) {
    // The user's own templates are theirs: named, so that they can be kept.
    let templates = 0;
    try { templates = readdirSync(join(config.dataDir, "templates")).filter((f) => f.endsWith(".md")).length; } catch { /* none */ }
    const yours = templates > 0 ? `, with your ${templates} prompt template${templates === 1 ? "" : "s"} in ${join(config.dataDir, "templates")}` : "";
    plan.removals.push({ what: `codex-collab's settings, thread records and logs in ${config.dataDir}${yours}`, run: () => removeTree(config.dataDir) });
    // Read as it is, unparsed or not: the uninstall must not depend on it.
    let spawnTrust: unknown;
    try { spawnTrust = JSON.parse(readFileSync(join(config.dataDir, "config.json"), "utf-8"))?.["spawn-trust"]; } catch { /* unreadable: none */ }
    if (spawnTrust === "codex") plan.stays.push("the folders `config spawn-trust codex` marked trusted in Claude Code");
  }

  // What the installers put there: a built bundle, or links into a checkout.
  const skill = skillInstallDir();
  if (existsSync(skill)) {
    plan.removals.push(installedFolder("the Claude Code skill", skill, ["SKILL.md", "LICENSE.txt", "scripts/codex-collab", "scripts/broker-server", "scripts/prompts"]));
  }
  const bin = binDir();
  const windows = process.platform === "win32";
  const commands = (windows ? ["codex-collab.cmd", "codex-collab"] : ["codex-collab"]).map((n) => join(bin, n)).filter(isOurCommand);
  if (commands.length > 0) {
    plan.removals.push({
      what: `${commands.length > 1 ? "the commands" : "the command"} ${commands.join(" and ")}`,
      run: () => {
        for (const path of commands) {
          try { unlinkSync(path); } catch (e) { return `could not remove ${path}: ${e instanceof Error ? e.message : String(e)}`; }
        }
        return null;
      },
    });
    if (windows && commands.some((p) => p.endsWith(".cmd"))) plan.after.push("If Windows now says the batch file cannot be found, that is the codex-collab command you ran, which is gone.");
  }
  // install.ps1 puts the folder on the user's PATH only when it is not
  // there already, and keeps no note of having done so: whose the entry is,
  // nothing here can tell.
  if (windows) plan.stays.push(`${bin} on your PATH, where install.ps1 put it unless it was there already: take it off if nothing else of yours is in it`);

  plan.stays.unshift("the threads in Codex, and the conversations in Claude Code, those of the sessions codex-collab started among them");
  const checkout = devCheckout();
  plan.stays.push(checkout ? `the checkout this install ran from, ${checkout}` : "the folder you installed from, if you kept one");
  return plan;
}

function list(steps: string[]): string {
  return steps.map((s) => `  - ${s}`).join("\n");
}

/** What is wrong with a hooks file that is there, or null when it reads as
 *  one (or is not there). */
function hooksFileProblem(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "it holds no JSON object";
    const hooks = (doc as { hooks?: unknown }).hooks;
    if (hooks !== undefined && (!hooks || typeof hooks !== "object" || Array.isArray(hooks))) return `its "hooks" is not an object`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Work in flight, or something to put right first: say what, and stop with
 *  nothing changed. */
function refuseIfBusy(plan: Plan): void {
  if (plan.blockers.length > 0) {
    console.error("codex-collab cannot be uninstalled yet:");
    console.error(list(plan.blockers));
    console.error("Nothing was changed.");
    process.exit(1);
  }
  if (plan.busy.length === 0) return;
  console.error("codex-collab is not uninstalled while work is in flight, which would be lost:");
  console.error(list(plan.busy));
  console.error("Nothing was changed. Run `codex-collab uninstall` again once it is done.");
  process.exit(1);
}

export async function handleUninstall(args: string[]): Promise<void> {
  // Only the bare flag agrees, and nothing else is taken: `--yes=false`
  // parses as --yes with a stray argument, and another command's option
  // (`--check`, `--dir`) means something this does not do.
  const other = args.filter((a) => a !== "--yes");
  if (other.length > 0) die(`uninstall takes no arguments other than --yes (got: ${other.join(" ")})`);
  const yes = args.includes("--yes");
  // Stopping sessions goes through Claude Code, and the files are outside
  // what the sandbox may write: inside it, this would stop nothing and
  // remove little.
  if (insideCodexSandbox()) {
    console.error("codex-collab uninstall cannot run inside the Codex sandbox: it stops processes and removes files the sandbox does not reach.");
    console.error("Rerun this command outside the sandbox (with escalated permissions).");
    process.exit(1);
  }
  const shown = await makePlan();
  refuseIfBusy(shown);
  if (shown.removals.length === 0 && shown.stops.length === 0) {
    console.log("Nothing of codex-collab's is left to remove.");
    return;
  }
  if (shown.stops.length > 0) console.log(`codex-collab uninstall stops:\n${list(shown.stops.map((s) => s.what))}\n`);
  if (shown.removals.length > 0) console.log(`It removes:\n${list(shown.removals.map((s) => s.what))}\n`);
  console.log(`These stay:\n${list(shown.stays)}\n`);
  requireConsent(yes, "Uninstall codex-collab?", "Run `codex-collab uninstall --yes` to uninstall.");

  // The plan may have gone stale while it was read: what runs now decides,
  // and what it would stop that was not shown is asked about again.
  const now = await makePlan();
  refuseIfBusy(now);
  const unseen = now.stops.filter((s) => !shown.stops.some((x) => x.what === s.what));
  if (unseen.length > 0) {
    console.error("Since the plan was shown, more has started that the uninstall would stop:");
    console.error(list(unseen.map((s) => s.what)));
    console.error("Nothing was changed. Run `codex-collab uninstall` again to see the plan as it is now.");
    process.exit(1);
  }
  for (const step of now.stops) {
    const out = await step.run();
    if (typeof out === "string") {
      console.error(`Could not stop everything: ${out}. Nothing was removed; codex-collab still works.`);
      console.error("Run `codex-collab uninstall` again once it is done.");
      process.exit(1);
    }
    console.log(out?.said ?? `Stopped ${step.what.split(";")[0]}.`);
  }
  // Anything of codex-collab's at work or running again by now was put to
  // use while it stopped: removing its files under it would lose that work.
  const last = await makePlan();
  refuseIfBusy({ ...last, busy: [] });
  if (last.busy.length > 0 || last.stops.length > 0) {
    console.error("codex-collab was put to use while it was being uninstalled:");
    console.error(list([...last.busy, ...last.stops.map((s) => s.what)]));
    console.error("Nothing was removed; what was stopped starts again when it is next needed. Run `codex-collab uninstall` again once that work is done.");
    process.exit(1);
  }
  const failures: string[] = [];
  for (const step of last.removals) {
    const out = await step.run();
    if (typeof out === "string" && step.critical) {
      console.error(`Could not remove everything: ${out}.`);
      console.error("Nothing else was removed, so codex-collab still works where Codex runs its hooks. Fix that, then run `codex-collab uninstall` again.");
      process.exit(1);
    }
    if (typeof out === "string") failures.push(out);
    else console.log(out?.said ?? `Removed ${step.what.split(";")[0]}.`);
  }
  if (failures.length > 0) {
    console.error(`\nNot everything could be removed:\n${list(failures)}`);
    process.exit(1);
  }
  console.log("\ncodex-collab is uninstalled.");
  for (const line of last.after) console.log(line);
}
