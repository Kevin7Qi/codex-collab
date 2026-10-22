// src/codex-wake.ts — start a turn on an idle Codex thread with what Claude sent it
//
// Opt-in (`config codex-wake on`). When a message reaches a Codex thread that
// is idle on Codex's shared app-server — the Codex app over SSH, a terminal
// `codex` attached to the daemon — the channel host starts a turn on it with
// the message, the way the peer side starts a turn with Claude's message:
// turn input in a `<codex_delegation>` envelope, which the Codex app shows as
// a message. A thread in the middle of a turn is left to the hooks. A thread
// the shared server does not hold loaded is never resumed there: it may be
// open in a server of its own (the Codex app on local files runs one), and
// resuming it would take its writer lock.

import { existsSync } from "node:fs";
import { releaseDelivery, threadStateDirs } from "./claude-channel";
import type { AppServerClient } from "./client";
import { take, undelivered, type Taken } from "./commands/hook";
import { buildDelegation } from "./peer";
import { attachSupported, connectShared, controlSocketPath } from "./shared-server";

export type WakeOutcome = { woke: true; messages: number } | { woke: false; why: string };

type Client = Pick<AppServerClient, "request" | "close">;

/** The turn input for messages taken: one envelope, each message under its
 *  own opening line, since the Codex app shows one envelope as one message. */
export function wakeText(parts: string[]): string {
  return buildDelegation(parts.join("\n\n"));
}

/** What a woken turn carries at most, in tokens as `estimateTokens` counts
 *  them. Turn input has no limit of its own, as a hook's context does; this
 *  only keeps one turn from taking in a whole backlog. */
export const WAKE_BUDGET_TOKENS = 24_000;

/** Start a turn on `threadId` with what reached it and Codex has not been
 *  handed, if the shared app-server holds the thread and it is idle. Says
 *  what it did, or why not. `onTaken` is told what it claimed before it asks
 *  for the turn, and told [] once that is settled either way: a caller that
 *  stops in between gives those claims back. */
export async function wakeThread(
  threadId: string,
  opts: { connect?: () => Promise<Client>; root?: string; onTaken?: (taken: Taken[]) => void } = {},
): Promise<WakeOutcome> {
  let client: Client;
  try {
    if (opts.connect) {
      client = await opts.connect();
    } else {
      if (!attachSupported() || !existsSync(controlSocketPath())) return { woke: false, why: "no shared app-server" };
      client = await connectShared({ socketPath: controlSocketPath() });
    }
  } catch {
    return { woke: false, why: "no shared app-server" };
  }
  try {
    // The thread as this server holds it, without its turns: `idle`,
    // `active` (in a turn), or `notLoaded` — not held here.
    const read = await client.request<{ thread?: { status?: { type?: unknown } } }>("thread/read", { threadId, includeTurns: false });
    const status = read?.thread?.status?.type;
    if (status === "notLoaded") return { woke: false, why: "not held by the shared app-server" };
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
      await client.request("turn/start", { threadId, input: [{ type: "text", text: wakeText(taken.map((t) => t.part)) }] });
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
