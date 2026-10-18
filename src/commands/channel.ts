// src/commands/channel.ts — the channel host: the address of every Codex thread in a workspace
//
// `codex-collab channel-host --dir <workspace>` (private). Started detached
// by a task's receiver when the workspace has no host (`openChannel` in
// claude-channel.ts). For each Codex thread of the workspace with a Claude
// Code session to talk to, it holds the thread's address — a socket, and an
// entry in Claude Code's session registry — and stores whatever is sent
// there in the thread's mailbox. An address goes once no Claude session the
// thread has talked to is running; the host goes once it holds none.
//
// It leaves nothing behind. Every way out removes its sockets, entries and
// state file; the small processes that hold its entries read their stdin
// from it and end when it does, however it ends; and what a host killed
// outright left in the registry, the next one removes before it registers.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { mailboxRoot, resolveStateDir, resolveWorkspaceDir } from "../config";
import {
  askHost,
  channelName,
  channelSocketPath,
  channelsDir,
  claudeEntries,
  contactAt,
  contactRunning,
  hostControlPath,
  hostLogFile,
  hostStateFile,
  isContact,
  isThreadId,
  loadContacts,
  readHostState,
  addressIdleMs,
  lastActivityOf,
  recordActivity,
  recordSocketPath,
  recordedSocketPath,
  releaseDelivery,
  sameContact,
  saveContacts,
  threadSocketPath,
  sweepChannels,
  writeMessage,
  type Contact,
  type HostState,
} from "../claude-channel";
import { TASK_KEEP_MS } from "../claude-tasks";
import { transientSessionId } from "../claude-sessions";
import { buildRegistryEntry, ownPidDomain, parseEnvelope, procIdentity, procStartOf, procStartTicksOf, sessionsDir, sniffRegistryVersion } from "../peer";
import { verifyMailboxDir } from "../questions";
import { wakeThread } from "../codex-wake";
import type { Taken } from "./hook";
import { formatDuration, loadUserConfig, parseOptions } from "./shared";

/** How often the host looks whether the sessions its threads talk to still
 *  run. (The variable is a test seam.) */
const CHECK_MS = Number(process.env.CODEX_COLLAB_CHANNEL_CHECK_MS) || 30_000;

/** Looks in a row that must find a session nowhere before it counts as gone:
 *  Claude Code rewrites its entries while it runs, and one look that misses a
 *  session is no evidence. */
const MISSES = 2;

/** The longest message a sender may write to an address. */
const INBOUND_LIMIT = 1024 * 1024;

/** How often old messages are swept from the mailboxes. */
const SWEEP_MS = 3600_000;

/** How long after a message arrives the host waits before waking its thread
 *  (`config codex-wake on`): messages sent together go in one turn. (The
 *  variable is a test seam.) */
const WAKE_DELAY_MS = Number(process.env.CODEX_COLLAB_WAKE_DELAY_MS) || 2000;

interface Address {
  threadId: string;
  name: string;
  socketPath: string;
  server: Server;
  /** The process the registry entry is under, and the entry. */
  holder: ChildProcess | null;
  entryPath: string | null;
  contacts: Contact[];
  /** Looks in a row each contact was found nowhere. */
  misses: Map<string, number>;
  /** When the holder last had to be put back: a few times, then the address goes. */
  respawns: number[];
  /** The socket file this host made, by inode: only that one is removed. */
  socketIno: number | null;
  /** When something last passed through the address — a message to it, a
   *  send from its thread, a task's receiver asking for it — and when that
   *  was last written down. */
  lastActive: number;
  activityWritten: number;
}

/** How stale the written-down time of an address's last use may get: it
 *  only has to survive a host's restart, give or take. */
const ACTIVITY_WRITE_MS = 5 * 60_000;

function contactKey(c: Contact): string {
  return c.sessionId ?? `pid:${c.pid}:${c.procStart ?? ""}`;
}

export async function handleChannelHost(args: string[]): Promise<void> {
  const { options } = parseOptions(args);
  const wsRoot = resolveWorkspaceDir(options.dir);
  const stateDir = resolveStateDir(options.dir);
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

  // One host per workspace: one started while another was getting ready
  // leaves it the names.
  const prior = readHostState(stateDir);
  if (prior && prior.pid !== process.pid) {
    try {
      if ((await askHost(prior.control, { op: "ping" }, 2000)).ok === true) {
        log(`host ${prior.pid} already holds this workspace's addresses`);
        process.exit(0);
      }
    } catch { /* not answering: this host takes over */ }
  }
  try {
    // The temp root must be privately ours before a socket goes in it — the
    // check the ask mailbox and a task's receiver make, for the same reason.
    mkdirSync(mailboxRoot(), { recursive: true, mode: 0o700 });
    verifyMailboxDir(mailboxRoot());
    mkdirSync(channelsDir(stateDir), { recursive: true, mode: 0o700 });
  } catch (e) {
    log(`cannot start: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const addresses = new Map<string, Address>();
  const opening = new Map<string, Promise<Address>>();
  const controlPath = hostControlPath(wsRoot);
  let control: Server | null = null;
  let lastRequestAt = Date.now();
  let exiting = false;

  /** Remove a socket of this host's, and only that: a host that took over
   *  the path since has its own socket there. */
  const unlinkOwn = (path: string, ino: number | null) => {
    try { if (ino !== null && statSync(path).ino === ino) unlinkSync(path); } catch { /* gone */ }
  };
  let controlIno: number | null = null;
  /** Something passed through the address. */
  const touch = (a: Address) => {
    a.lastActive = Date.now();
    if (a.lastActive - a.activityWritten < ACTIVITY_WRITE_MS) return;
    a.activityWritten = a.lastActive;
    try { recordActivity(stateDir, a.threadId, a.lastActive); } catch { /* the next one */ }
  };
  const idleLimitMs = (): number | null => {
    try { return addressIdleMs(loadUserConfig()["address-idle"]); } catch { return addressIdleMs(undefined); }
  };
  const persist = (a: Address) => {
    try { saveContacts(stateDir, a.threadId, a.contacts); } catch (e) { log(`${a.name}: could not record its contacts: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const removeEntry = (a: Address) => {
    if (a.entryPath) { try { unlinkSync(a.entryPath); } catch { /* gone */ } }
    a.entryPath = null;
  };
  // ── Waking a thread that is idle on the shared app-server ──
  // Read at each message, so `config codex-wake` applies at once.
  const wakeOn = (): boolean => {
    try { return loadUserConfig()["codex-wake"] === "on"; } catch { return false; }
  };
  const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const waking = new Set<string>();
  // What a wake in progress has claimed: given back if the host stops before
  // the turn is asked for, or the claims would mark messages Codex never saw.
  const claimedByWake = new Map<string, Taken[]>();
  // The last reason a thread was not woken, so a wait is logged once.
  const notWoken = new Map<string, string>();
  // Only a message that arrives is a reason to wake: one that came while the
  // thread was in a turn is the hooks' to hand over, or what Codex collected
  // itself, and waking for it later would hand Codex what it may have seen.
  const scheduleWake = (threadId: string) => {
    if (exiting || wakeTimers.has(threadId) || waking.has(threadId) || !wakeOn()) return;
    wakeTimers.set(threadId, setTimeout(() => {
      wakeTimers.delete(threadId);
      if (exiting) return;
      waking.add(threadId);
      const onTaken = (taken: Taken[]) => {
        if (taken.length > 0) claimedByWake.set(threadId, taken);
        else claimedByWake.delete(threadId);
      };
      void wakeThread(threadId, { onTaken }).then((outcome) => {
        if (outcome.woke) {
          notWoken.delete(threadId);
          log(`woke Codex thread ${threadId} with ${outcome.messages === 1 ? "a message" : `${outcome.messages} messages`}`);
        } else if (outcome.why !== "nothing to hand over" && notWoken.get(threadId) !== outcome.why) {
          notWoken.set(threadId, outcome.why);
          log(`did not wake Codex thread ${threadId}: ${outcome.why}`);
        }
      }, (e) => log(`could not wake Codex thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => waking.delete(threadId));
    }, WAKE_DELAY_MS));
  };

  const closeAddress = (a: Address, why: string) => {
    const timer = wakeTimers.get(a.threadId);
    if (timer) { clearTimeout(timer); wakeTimers.delete(a.threadId); }
    notWoken.delete(a.threadId);
    if (addresses.get(a.threadId) === a) addresses.delete(a.threadId);
    // When it was last in use, for the host that opens it next: its idle
    // time goes on from there.
    try { recordActivity(stateDir, a.threadId, a.lastActive); } catch { /* the next host starts afresh */ }
    try { a.server.close(); } catch { /* closed */ }
    unlinkOwn(a.socketPath, a.socketIno);
    removeEntry(a);
    const holder = a.holder;
    a.holder = null;
    try { holder?.kill(); } catch { /* gone */ }
    log(`closed ${a.name}: ${why}`);
  };
  // Synchronous, and run on every exit: SIGINT and SIGTERM reach the CLI's
  // handlers, which exit; SIGHUP and a crash are sent there below.
  process.on("exit", () => {
    exiting = true;
    for (const [threadId, taken] of claimedByWake) {
      for (const t of taken) releaseDelivery(t.dir, threadId, t.message.id);
    }
    for (const a of [...addresses.values()]) closeAddress(a, "the host is stopping");
    try { control?.close(); } catch { /* closed */ }
    unlinkOwn(controlPath, controlIno);
    if (readHostState(stateDir)?.pid === process.pid) { try { unlinkSync(hostStateFile(stateDir)); } catch { /* gone */ } }
  });
  process.on("SIGHUP", () => process.exit(129));
  const fatal = (e: unknown) => {
    log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);

  /** Entries a host killed outright left for this socket: their process is
   *  gone, and a name Claude Code lists twice reaches whichever it picks. */
  const sweepEntriesFor = (socketPath: string) => {
    let files: string[];
    try { files = readdirSync(sessionsDir()); } catch { return; }
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      const path = join(sessionsDir(), file);
      try {
        const e = JSON.parse(readFileSync(path, "utf-8"));
        if (e?.messagingSocketPath === socketPath && procIdentity(e) === "dead") unlinkSync(path);
      } catch { /* being written, or gone */ }
    }
  };

  /** Put the address in the registry, under a holder of its own. */
  const register = (a: Address): boolean => {
    if (exiting || addresses.get(a.threadId) !== a) return false;
    // A liveness token: an entry's file name, its pid and a live process must
    // agree, one entry per pid. Its stdin is a pipe from this process, so it
    // ends when this process does, however that happens.
    const holder = spawn("sh", ["-c", "read _ || true"], { stdio: ["pipe", "ignore", "ignore"] });
    holder.on("error", () => { /* reported by its exit */ });
    if (!holder.pid) return false;
    a.holder = holder;
    holder.once("exit", () => {
      if (a.holder !== holder) return; // let go on purpose
      a.holder = null;
      removeEntry(a);
      if (exiting || addresses.get(a.threadId) !== a) return;
      // Gone by itself — something killed it — and the entry with it: both
      // are put back, a few times at most.
      const now = Date.now();
      a.respawns = a.respawns.filter((t) => now - t < 60_000);
      if (a.respawns.length >= 3) {
        closeAddress(a, "the process holding its registry entry keeps exiting");
        return;
      }
      a.respawns.push(now);
      if (!register(a)) closeAddress(a, "it could not be registered again");
    });
    if (writeEntry(a, holder.pid)) return true;
    a.holder = null;
    try { holder.kill(); } catch { /* gone */ }
    return false;
  };

  /** Write the address's registry entry, under its holder's pid. */
  const writeEntry = (a: Address, pid: number): boolean => {
    const entryPath = join(sessionsDir(), `${pid}.json`);
    try {
      mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
      writeFileSync(entryPath, JSON.stringify(buildRegistryEntry({
        pid,
        cwd: wsRoot,
        name: a.name,
        socketPath: a.socketPath,
        version: sniffRegistryVersion(),
        // /proc first: `ps` may not list a process this new yet.
        procStart: procStartTicksOf(pid) ?? procStartOf(pid),
        sessionId: transientSessionId(),
      })), { mode: 0o644 });
      a.entryPath = entryPath;
      return true;
    } catch (e) {
      log(`${a.name}: could not register: ${e instanceof Error ? e.message : String(e)}`);
      try { unlinkSync(entryPath); } catch { /* not written */ }
      return false;
    }
  };

  /** An entry somebody else removed is written again: without it, Claude
   *  cannot find the address. */
  const keepEntry = (a: Address) => {
    if (!a.holder?.pid || (a.entryPath && existsSync(a.entryPath))) return;
    log(`${a.name}: its registry entry was gone; writing it again`);
    if (!writeEntry(a, a.holder.pid)) closeAddress(a, "it could not be registered again");
  };

  const addContact = (a: Address, c: Contact) => {
    const i = a.contacts.findIndex((x) => sameContact(x, c));
    if (i >= 0) {
      const x = a.contacts[i];
      // The same session, perhaps as the new process Claude Code brought it back as.
      if (x.pid === c.pid && x.socketPath === c.socketPath && x.name === c.name && x.procStart === c.procStart) return;
      a.contacts[i] = c;
    } else {
      a.contacts.push(c);
    }
    a.misses.delete(contactKey(c));
    persist(a);
  };

  // Claude Code sends a message again when it cannot tell the first went:
  // the same id, stored once. The latest few hundred are remembered.
  const seenMsgIds = new Set<string>();
  const seenOnce = (id: string): boolean => {
    if (!id) return false;
    if (seenMsgIds.has(id)) return true;
    seenMsgIds.add(id);
    if (seenMsgIds.size > 500) seenMsgIds.delete(seenMsgIds.values().next().value as string);
    return false;
  };

  /** Store what a sender writes to the address, one envelope per line. */
  const inbound = (a: Address) => (sock: Socket) => {
    sock.setEncoding("utf8");
    sock.setTimeout(60_000, () => sock.destroy());
    let buffer = "";
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > INBOUND_LIMIT) {
        log(`${a.name}: dropped a message over ${INBOUND_LIMIT} bytes`);
        sock.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = parseEnvelope(line);
        if (!msg) {
          // Control frames come this way too; a message in a form this
          // version does not know would vanish without a trace.
          log(`${a.name}: a line that is no message: ${line.slice(0, 160)}`);
          continue;
        }
        if (seenOnce(msg.msgId)) {
          log(`${a.name}: message ${msg.msgId} from ${msg.fromName} again; kept once`);
          continue;
        }
        try {
          const stored = writeMessage(stateDir, a.threadId, { fromName: msg.fromName, replyPath: msg.replyPath, text: msg.text });
          log(`${a.name}: message ${stored.id} from ${msg.fromName}`);
          touch(a);
        } catch (e) {
          log(`${a.name}: could not store a message from ${msg.fromName}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        // A session that writes to the thread is one it talks to.
        const sender = contactAt(msg.replyPath, claudeEntries());
        if (sender) addContact(a, sender);
        scheduleWake(a.threadId);
      }
    });
    sock.on("error", () => { /* a dropped connection loses nothing stored */ });
  };

  /** Open the thread's address. `lastActive` is when it was last in use:
   *  now for an address somebody asks for, what is on disk for one a host
   *  before this one held. */
  const openAddress = (threadId: string, lastActive: number = Date.now()): Promise<Address> => {
    const open = addresses.get(threadId);
    if (open) return Promise.resolve(open);
    const pending = opening.get(threadId);
    if (pending) return pending;
    const p = (async () => {
      const name = channelName(wsRoot, threadId);
      // The socket the thread has used before, where Claude sends a reply,
      // whatever this host's environment would choose.
      const usual = threadSocketPath(stateDir, wsRoot, threadId);
      const server = createServer();
      const a: Address = { threadId, name, socketPath: usual, server, holder: null, entryPath: null, contacts: loadContacts(stateDir, threadId), misses: new Map(), respawns: [], socketIno: null, lastActive, activityWritten: 0 };
      server.on("connection", inbound(a));
      const listenAt = async (socketPath: string): Promise<void> => {
        sweepEntriesFor(socketPath);
        try { unlinkSync(socketPath); } catch { /* none */ }
        // Bound with group/other bits masked: connectable the moment it
        // exists, before any chmod could run.
        const prevUmask = process.umask(0o077);
        try {
          await new Promise<void>((resolve, reject) => {
            const failed = (e: Error) => { server.off("listening", bound); reject(e); };
            const bound = () => { server.off("error", failed); resolve(); };
            server.once("listening", bound);
            server.once("error", failed);
            server.listen(socketPath);
          });
        } finally {
          process.umask(prevUmask);
        }
      };
      try {
        await listenAt(usual);
      } catch (e) {
        // Where it used to be cannot be had: where this host would put it.
        const fresh = channelSocketPath(wsRoot, threadId);
        if (fresh === usual) throw e;
        log(`${name}: could not listen at ${usual} again (${e instanceof Error ? e.message : String(e)}); moving to ${fresh}`);
        a.socketPath = fresh;
        await listenAt(fresh);
      }
      try { a.socketIno = statSync(a.socketPath).ino; } catch { /* removed already: nothing of ours to remove later */ }
      if (recordedSocketPath(stateDir, threadId) !== a.socketPath) {
        try { recordSocketPath(stateDir, threadId, a.socketPath); } catch (e) { log(`${name}: could not record its socket: ${e instanceof Error ? e.message : String(e)}`); }
      }
      server.on("error", (e) => {
        log(`${name}: socket error: ${e.message}`);
        if (addresses.get(threadId) === a) closeAddress(a, "its socket failed");
      });
      addresses.set(threadId, a);
      if (!register(a)) {
        closeAddress(a, "it could not be registered");
        throw new Error(`could not register ${name} in Claude Code's session registry (${sessionsDir()})`);
      }
      log(`opened ${name} for Codex thread ${threadId}`);
      return a;
    })();
    opening.set(threadId, p);
    p.then(() => opening.delete(threadId), () => opening.delete(threadId));
    return p;
  };

  const handle = async (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (req.op === "ping") return { ok: true, pid: process.pid, addresses: addresses.size };
    if (req.op !== "open") return { ok: false, error: `unknown request: ${String(req.op)}` };
    if (!isThreadId(req.threadId)) return { ok: false, error: "not a Codex thread id" };
    if (!isContact(req.contact)) return { ok: false, error: "no Claude Code session named for the thread to talk to" };
    try {
      const a = await openAddress(req.threadId);
      // A send from the thread, or a task's receiver waiting on a reply.
      touch(a);
      addContact(a, req.contact);
      keepEntry(a);
      if (addresses.get(a.threadId) !== a) return { ok: false, error: `could not register ${a.name} in Claude Code's session registry (${sessionsDir()})` };
      return { ok: true, name: a.name, socketPath: a.socketPath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // ── Requests ──
  control = createServer((sock) => {
    sock.setEncoding("utf8");
    sock.setTimeout(10_000, () => sock.destroy());
    let buffer = "";
    let taken = false;
    sock.on("data", (chunk: string) => {
      if (taken) return;
      buffer += chunk;
      if (buffer.length > 64 * 1024) { sock.destroy(); return; }
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      taken = true;
      lastRequestAt = Date.now();
      let req: unknown;
      try { req = JSON.parse(buffer.slice(0, idx)); } catch { req = null; }
      const answer = req && typeof req === "object"
        ? handle(req as Record<string, unknown>)
        : Promise.resolve({ ok: false, error: "not a request" });
      void answer.then((a) => {
        lastRequestAt = Date.now();
        try { sock.end(JSON.stringify(a) + "\n"); } catch { /* gone */ }
      });
    });
    sock.on("error", () => { /* the asker went */ });
  });
  try { unlinkSync(controlPath); } catch { /* none */ }
  try {
    const listening = control;
    const prevUmask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        listening.once("listening", resolve);
        listening.once("error", reject);
        listening.listen(controlPath);
      });
    } finally {
      process.umask(prevUmask);
    }
  } catch (e) {
    log(`cannot listen at ${controlPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  control.on("error", (e) => {
    log(`control socket error: ${e.message}`);
    process.exit(1);
  });
  try { controlIno = statSync(controlPath).ino; } catch { /* removed already */ }

  // Ready: from here on a client finds this host by its state file.
  let procStart: string | null = procStartTicksOf(process.pid);
  if (procStart === null) { try { procStart = procStartOf(process.pid); } catch { /* ps unavailable */ } }
  const state: HostState = { pid: process.pid, procStart, pidDomain: ownPidDomain(), control: controlPath, startedAt: new Date().toISOString() };
  const stateTmp = `${hostStateFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(stateTmp, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(stateTmp, hostStateFile(stateDir));
  log(`host ${process.pid} ready for ${wsRoot}`);

  // Addresses a host before this one held, for threads that still have a
  // session to talk to: a host that went must not cost them their address.
  let threads: string[] = [];
  try { threads = readdirSync(channelsDir(stateDir)).filter(isThreadId); } catch { /* none */ }
  const entries = claudeEntries();
  const idleAtStart = idleLimitMs();
  for (const threadId of threads) {
    if (!loadContacts(stateDir, threadId).some((c) => contactRunning(c, entries))) continue;
    // One that went quiet for longer than an address stays open stays shut.
    const last = lastActivityOf(stateDir, threadId) || Date.now();
    if (idleAtStart !== null && Date.now() - last > idleAtStart) continue;
    try { await openAddress(threadId, last); } catch (e) { log(`could not reopen the address of ${threadId}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const sweep = () => {
    try { sweepChannels(stateDir, TASK_KEEP_MS, Date.now(), new Set(addresses.keys())); } catch { /* the next sweep */ }
    // A host can run for days: its log starts afresh past 1 MB. It is open
    // for appending, so what comes next goes at the start.
    try {
      if (statSync(hostLogFile(stateDir)).size > 1024 * 1024) {
        truncateSync(hostLogFile(stateDir), 0);
        log("log started afresh");
      }
    } catch { /* no log: output goes elsewhere */ }
  };
  sweep();
  setInterval(sweep, SWEEP_MS);

  // ── Who is still there ──
  setInterval(() => {
    const now = claudeEntries();
    const idleMs = idleLimitMs();
    for (const a of [...addresses.values()]) {
      // Nothing through it for the idle limit: it goes, as it would with
      // nobody left to talk to. The thread's next send opens it again, on
      // the socket it had.
      if (idleMs !== null && Date.now() - a.lastActive > idleMs) {
        closeAddress(a, `nothing has passed through it for ${formatDuration(idleMs)} (config address-idle)`);
        // Whom it talked to goes too, so that a host started later leaves it
        // shut and its folder is swept once its messages are: the next send
        // names its session again.
        a.contacts = [];
        persist(a);
        continue;
      }
      let changed = false;
      a.contacts = a.contacts.filter((c) => {
        const key = contactKey(c);
        if (contactRunning(c, now)) { a.misses.delete(key); return true; }
        const seen = (a.misses.get(key) ?? 0) + 1;
        if (seen < MISSES) { a.misses.set(key, seen); return true; }
        a.misses.delete(key);
        changed = true;
        return false;
      });
      if (changed) persist(a);
      if (a.contacts.length === 0) {
        closeAddress(a, "no Claude Code session it has talked to is running");
        continue;
      }
      keepEntry(a);
    }
    // Nothing held, nothing being opened or woken, nobody asking: done. A
    // task that asks after this starts a host again.
    if (addresses.size === 0 && opening.size === 0 && waking.size === 0 && wakeTimers.size === 0 && Date.now() - lastRequestAt >= CHECK_MS) {
      log("no addresses left: stopping");
      process.exit(0);
    }
  }, CHECK_MS);
}
