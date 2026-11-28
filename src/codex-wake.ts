// src/codex-wake.ts — start a turn on an idle Codex thread with what Claude sent it
//
// Opt-in (`config codex-wake on`). When a message reaches a Codex thread that
// is idle on Codex's shared app-server — the Codex app over SSH, a terminal
// `codex` attached to the daemon — the channel host starts a turn on it with
// the message, the way the peer side starts a turn with Claude's message:
// turn input in a `<codex_delegation>` envelope, which the Codex app shows as
// a message. A thread in the middle of a turn is left to the hooks.
//
// A thread the shared server does not hold loaded is resumed only when it is
// one of codex-collab's own — `run` has had a turn on it in a workspace — and
// then the way `run --resume` resumes it: through the workspace's broker, on
// a private app-server as well as the shared one, as a detached run that
// `follow`, `output` and `kill` reach. Any other thread is never resumed: it
// may be open in a server of its own (the Codex app on local files runs
// one), and resuming it would take its writer lock.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { releaseDelivery, threadStateDirs } from "./claude-channel";
import type { AppServerClient } from "./client";
import { config } from "./config";
import { hooksRunIn } from "./codex-hooks";
import { attachSupported, connectShared, controlSocketPath } from "./shared-server";
import { buildDelegation } from "./codex-session";
import { take, undelivered, type Taken } from "./channel-delivery";
import { isProcessAlive } from "./process";
import { getLatestRun, loadThreadIndex } from "./threads";

export type WakeOutcome = { woke: true; messages: number } | { woke: false; why: string };

type Client = Pick<AppServerClient, "request" | "close">;

/** The turn input for messages taken: one envelope, each message under its
 *  own opening line, since the Codex app shows one envelope as one message. */
export function wakeText(parts: string[], threadId: string): string {
  return buildDelegation(parts.join("\n\n"), threadId);
}

/** What a woken turn carries at most, in tokens as `estimateTokens` counts
 *  them. Turn input has no limit of its own, as a hook's context does; this
 *  only keeps one turn from taking in a whole backlog. */
export const WAKE_BUDGET_TOKENS = 24_000;

/** A thread of codex-collab's own: where it runs, and what `run` calls it. */
export type OwnThread = { dir: string; shortId: string; running: boolean };

/** The thread as the workspace codex-collab has run a turn on it in has
 *  it; null when none has. That need not be a workspace holding its mailbox:
 *  `send -d` puts the mailbox in the workspace it names. The index alone
 *  does not say so: `threads` lists there what Codex has for the folder,
 *  the user's own sessions among them. `running`: a run of ours is on it now. */
export function ownThread(threadId: string, root: string = join(config.dataDir, "workspaces")): OwnThread | null {
  let workspaces: string[];
  try { workspaces = readdirSync(root); } catch { return null; }
  for (const stateDir of workspaces.map((w) => join(root, w))) {
    let index: ReturnType<typeof loadThreadIndex>;
    try { index = loadThreadIndex(stateDir); } catch { continue; }
    for (const [shortId, entry] of Object.entries(index)) {
      if (entry.threadId !== threadId || !entry.cwd) continue;
      let run: ReturnType<typeof getLatestRun>;
      try { run = getLatestRun(stateDir, shortId); } catch { continue; }
      if (!run) continue;
      const running = run.status === "running" && typeof run.pid === "number" && isProcessAlive(run.pid);
      return { dir: entry.cwd, shortId, running };
    }
  }
  return null;
}

/** `run - --resume <shortId> --detach` in the thread's folder, the turn's
 *  input on stdin: it answers once the turn is running, or says why it is
 *  not (the thread is held elsewhere, a turn is on it, no Codex). */
export function resumeOwn(own: OwnThread, text: string): Promise<{ ok: true } | { ok: false; why: string }> {
  return new Promise((done) => {
    let err = "";
    const proc = spawn(process.execPath, ["run", process.argv[1], "run", "-", "--resume", own.shortId, "--detach"], {
      cwd: own.dir,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    proc.stderr?.on("data", (d) => { err = (err + String(d)).slice(-2000); });
    proc.once("error", (e) => done({ ok: false, why: e.message }));
    proc.once("close", (code) => {
      if (code === 0) return done({ ok: true });
      if (/open for writing in another Codex process/.test(err)) return done({ ok: false, why: "it is open for writing in another Codex process" });
      const line = err.trim().split("\n").find((l) => l.trim() && !l.startsWith("[codex-collab]")) ?? `run exited with ${code}`;
      done({ ok: false, why: line.trim() });
    });
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(text);
  });
}

/** Start a turn on `threadId` with what reached it and Codex has not been
 *  handed, if Codex runs our hooks in the thread and the shared app-server
 *  holds it idle, or it is a thread of our own that no server holds. Says
 *  what it did, or why not. `onTaken` is told what it claimed before it asks
 *  for the turn, and told [] once that is settled either way: a caller that
 *  stops in between gives those claims back.
 *
 *  The hooks are what tell, in a thread, what Codex has already read: a
 *  command it runs inside its sandbox cannot mark what it printed, and the
 *  hook after the command does. Without them, a wake would hand over again
 *  replies Codex had printed for itself. `hooksRun` says whether they run
 *  (`hooksRunIn` unless given). */
export async function wakeThread(
  threadId: string,
  opts: {
    connect?: () => Promise<Client>;
    root?: string;
    onTaken?: (taken: Taken[]) => void;
    hooksRun?: boolean;
    /** The thread as ours (`ownThread` unless given), and how one is resumed
     *  (`resumeOwn`). */
    own?: (threadId: string) => OwnThread | null;
    resume?: typeof resumeOwn;
  } = {},
): Promise<WakeOutcome> {
  if (!(opts.hooksRun ?? hooksRunIn(threadId))) return { woke: false, why: "Codex does not run codex-collab's hooks in the thread (codex-hook)" };
  // No shared server, or one that does not hold the thread: ours to resume
  // if it is ours, and otherwise left, for the reason given.
  const unheld = async (why: string): Promise<WakeOutcome> => {
    const own = (opts.own ?? ((id) => ownThread(id, opts.root)))(threadId);
    if (!own) return { woke: false, why };
    if (own.running) return { woke: false, why: "in a turn" };
    const taken = take(undelivered(threadStateDirs(threadId, opts.root), threadId), threadId, Date.now(), WAKE_BUDGET_TOKENS);
    if (taken.length === 0) return { woke: false, why: "nothing to hand over" };
    opts.onTaken?.(taken);
    try {
      const started = await (opts.resume ?? resumeOwn)(own, wakeText(taken.map((t) => t.part), threadId));
      if (started.ok) return { woke: true, messages: taken.length };
      for (const t of taken) releaseDelivery(t.dir, threadId, t.message.id);
      return { woke: false, why: `the turn could not be started: ${started.why}` };
    } finally {
      opts.onTaken?.([]);
    }
  };
  let client: Client;
  try {
    if (opts.connect) {
      client = await opts.connect();
    } else {
      if (!attachSupported() || !existsSync(controlSocketPath())) return unheld("no shared app-server");
      client = await connectShared({ socketPath: controlSocketPath() });
    }
  } catch {
    return unheld("no shared app-server");
  }
  try {
    // The thread as this server holds it, without its turns: `idle`,
    // `active` (in a turn), or `notLoaded` — not held here.
    const read = await client.request<{ thread?: { status?: { type?: unknown } } }>("thread/read", { threadId, includeTurns: false });
    const status = read?.thread?.status?.type;
    if (status === "notLoaded") return await unheld("not held by the shared app-server");
    if (status === "active") return { woke: false, why: "in a turn" };
    // `systemError` is a thread whose last turn failed — a rate limit, a
    // server error — and which takes a turn as an idle one does.
    if (status !== "idle" && status !== "systemError") return { woke: false, why: `its state is ${String(status)}` };
    const taken = take(undelivered(threadStateDirs(threadId, opts.root), threadId), threadId, Date.now(), WAKE_BUDGET_TOKENS);
    if (taken.length === 0) return { woke: false, why: "nothing to hand over" };
    opts.onTaken?.(taken);
    try {
      // A bare resume, without the thread's turns, which on a long thread
      // run to more than a client takes in one answer: the server holds the
      // thread loaded, and its settings stay as its user left them — the
      // turn runs on them.
      await client.request("thread/resume", { threadId, excludeTurns: true });
      await client.request("turn/start", { threadId, input: [{ type: "text", text: wakeText(taken.map((t) => t.part), threadId) }] });
    } catch (e) {
      // Not handed over after all: the next hook, or wake, has them.
      for (const t of taken) releaseDelivery(t.dir, threadId, t.message.id);
      return { woke: false, why: `the turn could not be started: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      opts.onTaken?.([]);
    }
    return { woke: true, messages: taken.length };
  } catch (e) {
    return { woke: false, why: `the shared app-server could not be asked: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try { await client.close(); } catch { /* gone */ }
  }
}
