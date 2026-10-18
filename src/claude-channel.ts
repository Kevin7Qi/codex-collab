// src/claude-channel.ts — one address per Codex thread, and its mailbox
//
// A Codex thread that messages Claude Code gets one address for as long as
// it has somebody to talk to: codex(<thread>-<workspace>). Claude sends to it
// whenever it has something for the thread — the reply to a message, or an
// update of its own later — and every message is written to the thread's
// mailbox on disk before anything else, so nothing is lost while Codex is
// not running. A task (claude-tasks.ts) is Codex's receipt for one message
// it sent: its reply is the first message the session it went to sends back
// after delivery, read from the mailbox. Nothing has to be tagged, and one
// reply that answers two messages answers both.
//
// The addresses are held by one detached process per workspace, the channel
// host (`channel-host`, private; commands/channel.ts). It keeps a thread's
// address while a Claude session the thread has talked to is running, and
// exits once it holds none; the next task starts it again, under the same
// names, with the same mailboxes. Each address is a socket of the host's and
// an entry in Claude Code's session registry under a tiny process of its own
// (the registry has one entry per pid) whose stdin is a pipe from the host:
// it cannot outlive the host.
//
// Mailbox files are written to a temporary name and linked into place, so a
// reader never sees half a message and two messages never share a name. All
// of it is readable inside Codex's sandbox, and written only outside it.

import { spawn } from "node:child_process";
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mailboxRoot, workspaceHash } from "./config";
import { isCodexCollabSocket, procIdentity, sessionsDir, workspaceSuffix } from "./peer";
import { acquireLockAsync } from "./lock";
import { spawnEnv } from "./claude-sessions";

/** A Codex thread id as Codex hands it to its shell: a UUID. Every path built
 *  from one goes through this, since an id comes from the environment. */
export function isThreadId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

/** The part of a thread id an address shows: its last eight hex digits. A
 *  Codex thread id is a UUIDv7, whose first eight digits are a clock that
 *  moves every 65 seconds — two threads started a minute apart would share
 *  them — while its last are random. */
export function threadTag(threadId: string): string {
  return threadId.replace(/-/g, "").slice(-8);
}

/** The thread's address in Claude Code's registry, which is also its name
 *  there: the thread, and the workspace (the same suffix as the broker's
 *  front door and thread peers, so every address from one checkout is
 *  recognizably from it). */
export function channelName(cwd: string, threadId: string): string {
  return `codex(${threadTag(threadId)}-${workspaceSuffix(cwd)})`;
}

/** The socket behind a thread's address. Under the temp root, where every
 *  codex-collab process recognizes it as ours (`isCodexCollabSocket`), and
 *  short enough for a unix socket path wherever the home directory is. */
export function channelSocketPath(cwd: string, threadId: string): string {
  return join(mailboxRoot(), `thread-${threadTag(threadId)}-${workspaceHash(cwd).slice(0, 8)}.sock`);
}

/** Where the host takes requests. A client finds it through the host's
 *  state file, never by working the path out: the temp root follows TMPDIR,
 *  which differs between the processes that may ask. */
export function hostControlPath(cwd: string): string {
  return join(mailboxRoot(), `channels-${workspaceHash(cwd).slice(0, 12)}.sock`);
}

export function channelsDir(stateDir: string): string {
  return join(stateDir, "channels");
}

function threadDir(stateDir: string, threadId: string): string {
  if (!isThreadId(threadId)) throw new Error(`Not a Codex thread id: ${threadId}`);
  return join(channelsDir(stateDir), threadId);
}

export function inboxDir(stateDir: string, threadId: string): string {
  return join(threadDir(stateDir, threadId), "inbox");
}

// ─── The mailbox ─────────────────────────────────────────────────────────────

/** One message to the thread, as the host received it. `id` sorts by
 *  arrival: the time in milliseconds, then a random part. */
export interface ChannelMessage {
  id: string;
  at: string;
  fromName: string;
  /** The socket the sender said replies go to: who sent it. */
  replyPath: string;
  text: string;
}

const MESSAGE_FILE = /^(\d{13})-[0-9a-f]{8}\.json$/;

/** Store a message in the thread's mailbox and return it as stored. */
export function writeMessage(stateDir: string, threadId: string, fields: Omit<ChannelMessage, "id" | "at">, now: number = Date.now()): ChannelMessage {
  const dir = inboxDir(stateDir, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (;;) {
    const id = `${String(now).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
    const msg: ChannelMessage = { id, at: new Date(now).toISOString(), ...fields };
    const tmp = join(dir, `.${id}.${process.pid}.tmp`);
    // The messages are the user's work: theirs alone to read.
    writeFileSync(tmp, JSON.stringify(msg) + "\n", { mode: 0o600 });
    try {
      // A link fails where a name is taken, which a rename would overwrite.
      linkSync(tmp, join(dir, `${id}.json`));
      return msg;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      try { unlinkSync(tmp); } catch { /* gone */ }
    }
  }
}

/** The ids of the thread's messages that arrived at or after `sinceMs`,
 *  oldest first. */
export function messageIdsSince(stateDir: string, threadId: string, sinceMs = 0): string[] {
  let files: string[];
  try {
    files = readdirSync(inboxDir(stateDir, threadId));
  } catch {
    return [];
  }
  const from = String(Math.max(0, Math.floor(sinceMs))).padStart(13, "0");
  return files
    .filter((f) => { const m = MESSAGE_FILE.exec(f); return !!m && m[1] >= from; })
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** One message, or null when it is not there (or unreadable). */
export function readMessage(stateDir: string, threadId: string, id: string): ChannelMessage | null {
  if (!/^\d{13}-[0-9a-f]{8}$/.test(id)) return null;
  try {
    const m = JSON.parse(readFileSync(join(inboxDir(stateDir, threadId), `${id}.json`), "utf-8"));
    return m && typeof m.id === "string" && typeof m.text === "string" && typeof m.fromName === "string" && typeof m.replyPath === "string" ? m as ChannelMessage : null;
  } catch {
    return null;
  }
}

/** The thread's messages since `sinceMs`, oldest first. */
export function messagesSince(stateDir: string, threadId: string, sinceMs = 0): ChannelMessage[] {
  return messageIdsSince(stateDir, threadId, sinceMs)
    .map((id) => readMessage(stateDir, threadId, id))
    .filter((m): m is ChannelMessage => m !== null);
}

/** Watch the thread's mailbox for the first message since `sinceMs` that
 *  `accept` takes; every other message is shown to `onOther` once. One look
 *  every `pollMs`, a listing of a small directory; `lookNow()` makes one at
 *  once and returns what it found, for a caller about to decide that nothing
 *  came — a reply that landed since the last look is still the reply. */
export function watchInbox(
  stateDir: string,
  threadId: string,
  sinceMs: number,
  accept: (m: ChannelMessage) => boolean,
  opts: { pollMs?: number; onOther?: (m: ChannelMessage) => void } = {},
): { message: Promise<ChannelMessage>; lookNow(): ChannelMessage | null; stop(): void } {
  const pollMs = opts.pollMs ?? (Number(process.env.CODEX_COLLAB_INBOX_POLL_MS) || 1000);
  const seen = new Set<string>();
  let found: ChannelMessage | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  let resolveMessage!: (m: ChannelMessage) => void;
  const message = new Promise<ChannelMessage>((resolve) => { resolveMessage = resolve; });
  const lookNow = (): ChannelMessage | null => {
    if (found) return found;
    for (const id of messageIdsSince(stateDir, threadId, sinceMs)) {
      if (seen.has(id)) continue;
      const m = readMessage(stateDir, threadId, id);
      // Unreadable now is no verdict: looked at again next time.
      if (!m) continue;
      seen.add(id);
      if (accept(m)) {
        found = m;
        stop();
        resolveMessage(m);
        return m;
      }
      try { opts.onOther?.(m); } catch { /* a note, not the wait */ }
    }
    return null;
  };
  timer = setInterval(lookNow, pollMs);
  lookNow();
  return { message, lookNow, stop };
}

// ─── Who the thread talks to ─────────────────────────────────────────────────

/** A Claude Code session the thread has talked to: one it sent a message,
 *  or one that sent it one. While any of them runs, the address stays. */
export interface Contact {
  name: string;
  pid: number;
  sessionId: string | null;
  procStart: string | null;
  socketPath: string;
}

export function isContact(v: unknown): v is Contact {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.name === "string" && typeof c.pid === "number" && Number.isInteger(c.pid) && c.pid > 0
    && (c.sessionId === null || typeof c.sessionId === "string")
    && (c.procStart === null || typeof c.procStart === "string")
    && typeof c.socketPath === "string";
}

/** The same session, as far as two records of it tell: by its session id
 *  where both have one, which Claude Code keeps when it brings a background
 *  session back as a new process; else by its process. */
export function sameContact(a: Contact, b: Contact): boolean {
  return a.sessionId && b.sessionId ? a.sessionId === b.sessionId : a.pid === b.pid && a.procStart === b.procStart;
}

function contactsFile(stateDir: string, threadId: string): string {
  return join(threadDir(stateDir, threadId), "contacts.json");
}

/** The thread's contacts as last written, [] when none are. */
export function loadContacts(stateDir: string, threadId: string): Contact[] {
  try {
    const parsed = JSON.parse(readFileSync(contactsFile(stateDir, threadId), "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isContact) : [];
  } catch {
    return [];
  }
}

/** Write the thread's contacts. For the host alone, the file's one writer. */
export function saveContacts(stateDir: string, threadId: string, contacts: Contact[]): void {
  const file = contactsFile(stateDir, threadId);
  mkdirSync(threadDir(stateDir, threadId), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(contacts) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Claude Code's registry entries, codex-collab's own left out: what a
 *  contact is looked for in. Read once per look, for every thread. */
export function claudeEntries(): Record<string, unknown>[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir());
  } catch {
    return [];
  }
  const entries: Record<string, unknown>[] = [];
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const e = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
      if (!e || typeof e !== "object" || e.pid !== Number(file.slice(0, -".json".length))) continue;
      if (isCodexCollabSocket(e.messagingSocketPath)) continue;
      entries.push(e);
    } catch { /* being rewritten: the next look reads it */ }
  }
  return entries;
}

/** Whether a contact is running: an entry of its session id, or of its very
 *  process (Claude Code gives a session a new id on /clear), whose process is
 *  not verifiably gone. */
export function contactRunning(c: Contact, entries: Record<string, unknown>[], identify: typeof procIdentity = procIdentity): boolean {
  return entries.some((e) => {
    const same = (!!c.sessionId && e.sessionId === c.sessionId)
      || (e.pid === c.pid && (c.procStart === null || e.procStart === c.procStart));
    return same && identify(e) !== "dead";
  });
}

/** The contact behind a reply address: the registry entry whose socket it is. */
export function contactAt(replyPath: string, entries: Record<string, unknown>[]): Contact | null {
  const e = entries.find((x) => x.messagingSocketPath === replyPath);
  if (!e || typeof e.pid !== "number") return null;
  return {
    name: typeof e.name === "string" ? e.name : "a Claude Code session",
    pid: e.pid,
    sessionId: typeof e.sessionId === "string" ? e.sessionId : null,
    procStart: typeof e.procStart === "string" ? e.procStart : null,
    socketPath: replyPath,
  };
}

// ─── Reaching the host ───────────────────────────────────────────────────────

/** What the running host wrote about itself once it was ready. */
export interface HostState {
  pid: number;
  procStart: string | null;
  pidDomain: string | null;
  control: string;
  startedAt: string;
}

export function hostStateFile(stateDir: string): string {
  return join(channelsDir(stateDir), "host.json");
}

export function readHostState(stateDir: string): HostState | null {
  try {
    const s = JSON.parse(readFileSync(hostStateFile(stateDir), "utf-8"));
    return s && typeof s.pid === "number" && typeof s.control === "string" ? s as HostState : null;
  } catch {
    return null;
  }
}

/** One request to the host: a line out, a line back. Rejects when nothing
 *  answers within `timeoutMs`. */
export function askHost(control: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const done = (err: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const sock = connect({ path: control }, () => sock.write(JSON.stringify(request) + "\n"));
    const timer = setTimeout(() => done(new Error(`the channel host did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        if (buffer.length > 64 * 1024) done(new Error("the channel host's answer was too long"));
        return;
      }
      try {
        const parsed = JSON.parse(buffer.slice(0, idx));
        if (parsed && typeof parsed === "object") done(null, parsed);
        else done(new Error("the channel host answered with something other than an object"));
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    });
    sock.on("error", (e) => done(e));
    sock.on("close", () => done(new Error("the channel host closed the connection without answering")));
  });
}

/** The host refused a request it understood: asking again will not help. */
export class ChannelRefused extends Error {}

/** How long a client waits for a host it started to be ready. (The variable
 *  is a test seam.) */
const HOST_START_TIMEOUT_MS = Number(process.env.CODEX_COLLAB_CHANNEL_START_MS) || 15_000;

/** Open the thread's address, starting the workspace's host if none is
 *  running, and add `contact` to the sessions it talks to. Resolves with the
 *  address once Claude can send to it. `start` launches a host (detached);
 *  the default runs this CLI's `channel-host`. */
export async function openChannel(
  stateDir: string,
  cwd: string,
  threadId: string,
  contact: Contact,
  opts: { start?: (cwd: string, stateDir: string) => void } = {},
): Promise<{ name: string; socketPath: string }> {
  if (!isThreadId(threadId)) throw new ChannelRefused(`Not a Codex thread id: ${threadId}`);
  const ask = async (): Promise<{ name: string; socketPath: string } | null> => {
    const state = readHostState(stateDir);
    if (!state) return null;
    let answer: Record<string, unknown>;
    try {
      answer = await askHost(state.control, { op: "open", threadId, contact });
    } catch {
      return null;
    }
    if (answer.ok === true && typeof answer.name === "string" && typeof answer.socketPath === "string") {
      return { name: answer.name, socketPath: answer.socketPath };
    }
    throw new ChannelRefused(typeof answer.error === "string" ? answer.error : "the channel host refused to open the address");
  };
  const first = await ask();
  if (first) return first;

  // One starter at a time: two tasks of one workspace starting a host each
  // would have two processes claim the same names.
  mkdirSync(channelsDir(stateDir), { recursive: true, mode: 0o700 });
  const release = await acquireLockAsync(join(channelsDir(stateDir), "host.lock"), { staleThresholdMs: 30_000 });
  try {
    const again = await ask();
    if (again) return again;
    // A host that wrote its state and does not answer is stopped or stuck,
    // and its addresses reach nobody: it goes, so that a new one can take
    // the names. A pid that is no longer that host is left alone.
    const stale = readHostState(stateDir);
    if (stale && procIdentity({ pid: stale.pid, ...(stale.procStart ? { procStart: stale.procStart } : {}), ...(stale.pidDomain ? { pidDomain: stale.pidDomain } : {}) }) === "live") {
      try { process.kill(stale.pid, "SIGTERM"); } catch { /* gone */ }
      const until = Date.now() + 3000;
      while (Date.now() < until && procIdentity({ pid: stale.pid, ...(stale.procStart ? { procStart: stale.procStart } : {}) }) === "live") await Bun.sleep(50);
      try { process.kill(stale.pid, "SIGKILL"); } catch { /* gone */ }
    }
    try { unlinkSync(hostStateFile(stateDir)); } catch { /* none */ }
    (opts.start ?? startHost)(cwd, stateDir);
    const deadline = Date.now() + HOST_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await Bun.sleep(50);
      const opened = await ask();
      if (opened) return opened;
    }
    throw new Error(`the channel host did not start within ${HOST_START_TIMEOUT_MS / 1000}s (its log: ${hostLogFile(stateDir)})`);
  } finally {
    release();
  }
}

export function hostLogFile(stateDir: string): string {
  return join(channelsDir(stateDir), "host.log");
}

/** Start the workspace's host, detached: in its own process group, with no
 *  terminal, so that it outlives the task that started it, and with Codex's
 *  and Claude Code's markers dropped from its environment, since it is
 *  nobody's command. Its log is kept short: it starts afresh past 1 MB. */
export function startHost(cwd: string, stateDir: string, cli: string = process.argv[1]): void {
  const log = hostLogFile(stateDir);
  try { if (statSync(log).size > 1024 * 1024) unlinkSync(log); } catch { /* none yet */ }
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(process.execPath, ["run", cli, "channel-host", "--dir", cwd], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: spawnEnv(),
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** Remove what the thread mailboxes keep past `maxAgeMs`: old messages, and
 *  the folder of a thread with no messages left and nobody to talk to.
 *  Returns how many messages went. */
export function sweepChannels(stateDir: string, maxAgeMs: number, now: number = Date.now(), open: ReadonlySet<string> = new Set()): number {
  let threads: string[];
  try {
    threads = readdirSync(channelsDir(stateDir)).filter(isThreadId);
  } catch {
    return 0;
  }
  const cutoff = String(Math.max(0, now - maxAgeMs)).padStart(13, "0");
  let removed = 0;
  for (const threadId of threads) {
    const dir = inboxDir(stateDir, threadId);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { /* none */ }
    for (const f of files) {
      const m = MESSAGE_FILE.exec(f);
      // A temporary file left by a writer that died is old by its own clock.
      const old = m ? m[1] < cutoff : f.endsWith(".tmp") && isOlderThan(join(dir, f), maxAgeMs, now);
      if (!old) continue;
      try { unlinkSync(join(dir, f)); if (m) removed++; } catch { /* gone */ }
    }
    if (open.has(threadId) || loadContacts(stateDir, threadId).length > 0) continue;
    try { rmdirSync(dir); } catch { /* not empty, or none */ }
    try { unlinkSync(contactsFile(stateDir, threadId)); } catch { /* none */ }
    try { rmdirSync(threadDir(stateDir, threadId)); } catch { /* not empty */ }
  }
  return removed;
}

function isOlderThan(path: string, ms: number, now: number): boolean {
  try {
    return now - statSync(path).mtimeMs > ms;
  } catch {
    return false;
  }
}
