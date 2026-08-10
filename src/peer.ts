// src/peer.ts — the workspace front-door peer.
//
// Registers the broker as a peer in Claude Code's session registry and
// serves Claude's cross-session messaging protocol on a socket of our own,
// so any Claude session can ListAgents/SendMessage the workspace's Codex
// directly — no CLI invocation in the hot path.
//
// Direction map:
//   Claude → Codex   inbound envelope → agent_message injection (native
//                    peer form, verified) + turn/start nudge when idle
//   Codex → Claude   final agentMessage of a peer-initiated turn → wrapped
//                    envelope written to the sender's reply socket
//   Codex asks       collab.consult dynamic tool → item/tool/call →
//                    forwarded to the conversation's session; the next
//                    message from that session completes the call.
//                    Judgment, not permission: fail-open on timeout.
//
// Everything here degrades: if the registry is absent, the platform is
// Windows, or the flag is off, start() is a no-op and codex-collab behaves
// exactly as before.

import net from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  registerThread,
  findShortId,
  loadThreadIndex,
  createRun,
  updateRun,
  generateRunId,
  runLogRelPath,
  updateThreadStatus,
  pruneRuns,
} from "./threads";
import { EventDispatcher } from "./events";
import { config } from "./config";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Internal owner of a broker thread entry (vs a client net.Socket). */
export interface InternalOwner {
  kind: "peer";
  onNotification(method: string, params: Record<string, unknown> | undefined): void;
}

/** What the peer needs from the broker hosting it. */
export interface PeerHost {
  cwd: string;
  stateDir: string;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Claim a thread for an internal owner; false when a turn already runs. */
  claimThread(threadId: string, owner: InternalOwner): boolean;
  /** Release a claim made with claimThread (e.g. the turn failed to start).
   *  An internal owner never "disconnects", so nothing else frees a claim
   *  whose turn will never produce a turn/completed. */
  releaseThread(threadId: string): void;
  /** True when a turn is running (or starting) on the thread. */
  threadHasTurn(threadId: string): boolean;
  log(line: string): void;
}

interface Conversation {
  threadId: string;
  /** Short ID from the thread index — suffixes the thread peer's name. */
  shortId?: string;
  /** Display name of this conversation's thread peer, derived from the
   *  first message. Persisted so re-materialization keeps the name. */
  label?: string;
  /** Reply socket path (the sender's own messaging socket). Updated to the
   *  most recent sender — the person actively talking is who consults and
   *  replies go to. */
  replyPath: string;
  /** Sender's display name, for attribution inside Codex's context. */
  fromName: string;
  /** The sandbox this conversation's thread actually runs under — the basis
   *  of the `from-mode` we assert on its outbound messages. Header overrides
   *  make this per-conversation: a `sandbox: danger-full-access` conversation
   *  attests "bypass" even when the workspace default would not. */
  sandbox?: string;
  /** Model/effort the conversation runs with, passed on every turn the peer
   *  starts. Unlike sandbox these are per-TURN settings (turn/start accepts
   *  both), so a later message's `model:`/`effort:` header updates them —
   *  without this, a conversation started with a bad model would be
   *  poisoned forever, every turn failing with no way to correct it. */
  model?: string;
  effort?: string;
  /** Last inbound/outbound activity, for thread-peer retirement. */
  lastActivity: number;
}

/** A per-thread peer: its own registry entry (backed by a holder process
 *  whose only job is to be a live pid) and its own socket, so each Codex
 *  conversation is independently addressable from ListAgents — the mirror
 *  of how each Claude session is. The holder's stdin is a pipe from the
 *  broker: a crashed broker closes the pipe, the holder exits, and the
 *  registry entry invalidates itself — no cleanup code required. */
interface ThreadPeer {
  threadId: string;
  name: string;
  socketPath: string;
  entryPath: string;
  holder: ChildProcess;
  server: net.Server;
}

/** Retire a thread peer after this much conversation inactivity. The
 *  conversation itself survives (the front door continues it, and the
 *  thread peer re-materializes on the next message). */
export const THREAD_PEER_LINGER_MS = 30 * 60_000;

/** ListAgents flooding guard: at most this many thread peers at once. */
export const MAX_THREAD_PEERS = 8;

interface PendingConsult {
  threadId: string;
  resolve: (answer: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Consult answers carry judgment, not permission — fail-open like the ask
 *  channel: an unanswered question expires and Codex proceeds on its own. */
export const CONSULT_TIMEOUT_MS = 600_000;

// ─── Registry entry ─────────────────────────────────────────────────────────

export function sessionsDir(): string {
  // Override for tests and probes — writing a FAKE registry must never
  // touch the user's real one.
  return process.env.CODEX_COLLAB_SESSIONS_DIR ?? join(homedir(), ".claude", "sessions");
}

/** Exact `ps -o lstart=` output for a pid, in the registry's expected form.
 *  TZ/locale pinned, edges trimmed ONLY — `ps` pads the day ("Sat Aug  8")
 *  and the validator compares by exact string equality. */
export function procStartOf(pid: number): string {
  return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).toString().replace(/^\s+|\s+$/g, "");
}

/** A plausible Claude Code version string for our forged entry: borrow it
 *  from any live sibling session's entry, falling back to the last version
 *  this was verified against. */
export function sniffRegistryVersion(): string {
  try {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
        if (typeof parsed?.version === "string" && typeof parsed?.pid === "number") {
          try {
            process.kill(parsed.pid, 0);
            return parsed.version;
          } catch { /* dead entry — keep looking */ }
        }
      } catch { /* unreadable entry — keep looking */ }
    }
  } catch { /* no registry dir */ }
  return "2.1.226";
}

/** Peer display name for a workspace: codex-<dir>, sanitized. A directory
 *  that already leads with "codex" would stutter ("codex-codex-collab"), so
 *  that token is dropped from the suffix. */
export function peerNameFor(cwd: string): string {
  const dir = basename(cwd)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^codex[-_]?/i, "");
  return `codex-${dir || "workspace"}`.slice(0, 40);
}

/** Display name for a per-thread peer, derived from the conversation's
 *  FIRST message so the address book reads as topics, not plumbing:
 *  "Investigate the flaky broker test" → codex-investigate-the-flaky-a1b2.
 *  The shortId suffix keeps names unique and ties the peer to the same id
 *  `codex-collab threads` shows. Non-ASCII text (e.g. a Chinese opening
 *  message) falls back to the bare suffix. The name is fixed at creation —
 *  renaming a live peer would break reply addressing, which resolves by
 *  name. */
/** A sender can NAME its conversation with a `topic:` (or `subject:`)
 *  first line — the skill teaches this — because nothing else on the wire
 *  carries intent: SendMessage's summary field does not travel (verified
 *  against the live envelope). The topic line is addressing metadata, so
 *  it is stripped from what Codex sees; a topic-only message keeps the
 *  topic as its body. */
/** Per-conversation settings a sender may declare in the header block. */
export interface MessageHeaders {
  topic: string | null;
  model?: string;
  effort?: string;
  sandbox?: string;
  approval?: string;
}

/** Settings the header block accepts, with the values each allows. `approval`
 *  takes only `auto`: interactive policies route their prompts to CLI client
 *  sockets, and a messaging sender is not one, so anything else would hang
 *  the turn until it timed out. Guardian (`auto`) needs no human answerer. */
const HEADER_KEYS: Record<string, readonly string[] | null> = {
  model: null, // any slug-shaped value; the server rejects unknown models
  effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  sandbox: ["read-only", "workspace-write", "danger-full-access"],
  approval: ["auto"],
};

/** Model names are slugs. Requiring the shape keeps prose out of the header
 *  block: without it, a message opening "model: the new one is broken" would
 *  swallow that line as a (doomed) model override instead of content. */
const MODEL_SLUG_RE = /^[A-Za-z0-9._/-]{1,64}$/;

/** Parse the leading `key: value` header block. Recognized keys are consumed;
 *  the first line that is not a recognized header ends the block, so ordinary
 *  prose that happens to contain a colon is never eaten. Unknown or invalid
 *  values are left in the body rather than silently dropped — a misspelled
 *  setting should reach Codex as text, not vanish. */
export function parseHeaders(text: string): { headers: MessageHeaders; body: string } {
  const lines = text.split("\n");
  const headers: MessageHeaders = { topic: null };
  let consumed = 0;
  for (const line of lines) {
    const m = /^\s*([a-zA-Z]+):\s*(.{1,60})\s*$/.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "topic" || key === "subject") {
      if (headers.topic !== null) break;
      headers.topic = value;
    } else if (key === "reasoning" || key === "effort") {
      if (headers.effort !== undefined || !HEADER_KEYS.effort!.includes(value)) break;
      headers.effort = value;
    } else if (key in HEADER_KEYS) {
      const allowed = HEADER_KEYS[key];
      const bag = headers as unknown as Record<string, unknown>;
      if (bag[key] !== undefined) break;
      if (allowed && !allowed.includes(value)) break;
      if (key === "model" && !MODEL_SLUG_RE.test(value)) break;
      bag[key] = value;
    } else {
      break;
    }
    consumed++;
  }
  if (consumed === 0) return { headers, body: text };
  const body = lines.slice(consumed).join("\n").trim();
  // A header-only message keeps its topic as the body, so the conversation
  // still has something to act on.
  return { headers, body: body || headers.topic || text };
}

/** Back-compat shim for the topic-only callers and their tests. */
export function extractTopic(text: string): { topic: string | null; body: string } {
  const { headers, body } = parseHeaders(text);
  return { topic: headers.topic, body };
}

/** Peer name for a sender-chosen topic: codex-<topic-slug>. */
export function topicPeerLabel(topic: string): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return slug ? `codex-${slug}` : "";
}

export function threadPeerLabel(firstMessage: string, shortId: string): string {
  const words = firstMessage.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = "";
  for (const w of words) {
    if (slug.length + w.length + 1 > 24) break;
    slug += (slug ? "-" : "") + w;
  }
  return `codex-${slug ? `${slug}-` : ""}${shortId.slice(0, 4)}`;
}

export function buildRegistryEntry(opts: {
  pid: number;
  cwd: string;
  name: string;
  socketPath: string;
  version: string;
  procStart: string;
  sessionId: string;
}): Record<string, unknown> {
  const now = Date.now();
  return {
    pid: opts.pid,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    startedAt: now,
    procStart: opts.procStart,
    version: opts.version,
    peerProtocol: 1,
    kind: "interactive",
    entrypoint: "cli",
    messagingSocketPath: opts.socketPath,
    name: opts.name,
    nameSource: "explicit",
    status: "idle",
    updatedAt: now,
    statusUpdatedAt: now,
  };
}

// ─── Envelope parse / wrap ──────────────────────────────────────────────────

export interface InboundMessage {
  msgId: string;
  /** Reply socket path (uds: prefix stripped). */
  replyPath: string;
  fromName: string;
  text: string;
}

const CROSS_SESSION_RE =
  /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;

/** Parse one line of the messaging socket protocol. Returns null for
 *  anything that is not a deliverable user message (control frames,
 *  malformed JSON, unknown versions). */
export function parseEnvelope(line: string): InboundMessage | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed?.type !== "user") return null;
  const from = typeof parsed.from === "string" ? parsed.from : "";
  const replyPath = from.startsWith("uds:") ? from.slice(4) : from;
  if (!replyPath) return null;
  const message = parsed.message as { content?: unknown } | undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  const m = CROSS_SESSION_RE.exec(content);
  // Attribute order in the opening tag is the sender's choice — pull
  // from-name out of the attribute blob, not by position. The name flows
  // into logs and Codex's context, so strip control characters and bound
  // its length; the message text itself is passed through (multiline is
  // legitimate content).
  const rawName = (m && /\bfrom-name="([^"]*)"/.exec(m[1])?.[1]) || "claude";
  // eslint-disable-next-line no-control-regex
  const fromName = rawName.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) || "claude";
  const text = (m ? m[2] : content).trim();
  if (!text) return null;
  return {
    // Cap the id we retain: the dedupe set stores these, and an oversized
    // id (real ones are 36-char UUIDs) would let a hostile sender park
    // megabytes in memory 500 entries at a time.
    msgId: typeof parsed.msg_id === "string" ? parsed.msg_id.slice(0, 128) : randomUUID(),
    replyPath,
    fromName,
    text,
  };
}

/** Permission-mode class a sender attests in `from-mode`. Receivers gate
 *  delivery on it (see {@link buildEnvelope}). */
export type PeerMode = "prompting" | "bypass";

/** Our attested mode class, from how the peer's Codex threads actually run:
 *  an unsandboxed thread is the analogue of Claude's bypassPermissions;
 *  anything sandboxed prompts-or-restricts, so it is "prompting". */
export function peerModeFor(sandbox: string | undefined): PeerMode {
  return sandbox === "danger-full-access" ? "bypass" : "prompting";
}

/** Build an outbound envelope line. The SENDER performs the
 *  cross-session-message wrapping (that is the protocol's convention).
 *
 *  `from-mode` is a DELIVERY GATE, not decoration. The receiver computes
 *  its own mode class (bypassPermissions → "bypass", else "prompting") and:
 *    asserted && matches   → accept
 *    asserted && differs   → hold ("mode-mismatch")
 *    not asserted, bypass  → hold ("no-mode-asserted")
 *    not asserted, prompting → accept
 *  A held message is never delivered — it waits behind an approve/deny
 *  dialog, which a Remote Control session does not surface, so it simply
 *  never appears. Omitting the attribute therefore made us invisible to
 *  every bypass-mode session.
 *
 *  Attribute ORDER is load-bearing: the receiver re-serializes what it
 *  parsed and rejects the message unless it matches byte-for-byte. The
 *  canonical order is from, from-session, hop-chain, from-name, from-mode. */
export function buildEnvelope(opts: {
  text: string;
  ourSocketPath: string;
  ourName: string;
  mode?: PeerMode;
}): string {
  const modeAttr = opts.mode ? ` from-mode="${opts.mode}"` : "";
  const wrapped =
    `<cross-session-message from="uds:${opts.ourSocketPath}" from-name="${opts.ourName}"${modeAttr}>\n` +
    `${opts.text}\n</cross-session-message>`;
  return JSON.stringify({
    msgV: 1,
    msg_id: randomUUID(),
    type: "user",
    message: { role: "user", content: wrapped },
    priority: "next",
    from: `uds:${opts.ourSocketPath}`,
  }) + "\n";
}

// ─── Thread bootstrap material ──────────────────────────────────────────────

export const PEER_DEVELOPER_INSTRUCTIONS = `You are working as a peer alongside Claude Code sessions in this workspace.

- Messages from Claude arrive in your conversation as agent_message items authored by /root/claude. They come from a fellow agent, not from the human user.
- To ask your peer a question mid-task and wait for the answer, call the collab.consult tool. If it returns no answer, proceed on your own best judgment.
- When a peer's message started your current turn, your final message is delivered back to that peer automatically — write it to be read by them.`;

/** Re-sent on thread/resume, which cannot re-declare dynamic tools — the
 *  consult tool is gone for the remainder of a resumed thread's life. */
export const PEER_RESUME_INSTRUCTIONS = PEER_DEVELOPER_INSTRUCTIONS +
  `\n- NOTE: the collab.consult tool is unavailable in this session. Ask questions in your reply instead.`;

export const PEER_DYNAMIC_TOOLS = [{
  type: "namespace",
  name: "collab",
  description: "Reach the Claude session collaborating with you on this workspace.",
  tools: [{
    type: "function",
    name: "consult",
    description:
      "Ask your Claude peer a question and wait for their answer. Use when you need judgment, context, or a decision only they have. Ask one question at a time; batch related questions into a single call.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
      },
      required: ["question"],
    },
  }],
}];

// ─── The peer ───────────────────────────────────────────────────────────────

export interface Peer {
  /** Started successfully (capability present, registry written). */
  active: boolean;
  /** True when the thread is one of the peer's conversations — its dynamic
   *  tools were declared by the peer, so their calls belong to it no matter
   *  who runs the current turn. */
  ownsThread(threadId: string): boolean;
  /** Give a thread a peer address after a CLI client created or resumed it.
   *  Without this, starting work with `run` would foreclose ever talking to
   *  that conversation — the two entry points would produce different, and
   *  irreversibly different, kinds of thread. */
  adoptThread(threadId: string): void;
  /** Handle a dynamic tool call routed from the broker. */
  handleToolCall(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** True when any OTHER live Claude session is registered — the broker's
   *  idle shutdown defers while someone might still message the peer. */
  hasLiveSessions(): boolean;
  stop(): void;
}

export function peerCapability(): { ok: boolean; reason: string } {
  if (process.platform === "win32") return { ok: false, reason: "windows (messaging unsupported)" };
  if (process.env.CODEX_COLLAB_PEER === "off") return { ok: false, reason: "CODEX_COLLAB_PEER=off" };
  if (!existsSync(sessionsDir())) return { ok: false, reason: "no Claude session registry" };

  // A Claude Code too old for peer messaging still keeps a session registry —
  // it just binds no messaging socket. Registering against it would advertise
  // a peer nobody can reach, so treat "live sessions exist and NONE advertises
  // a socket" as unsupported. No live sessions at all is inconclusive, not
  // negative: a session may start later, and the peer costs nothing until one
  // does. Our own entries do not skew this — the broker probes before it
  // registers, and a crashed broker's holders die with it.
  let live = 0;
  let reachable = 0;
  try {
    for (const file of readdirSync(sessionsDir())) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
        if (typeof entry?.pid !== "number" || entry.pid === process.pid) continue;
        process.kill(entry.pid, 0);
        live++;
        if (typeof entry.messagingSocketPath === "string") reachable++;
      } catch { /* dead or unreadable — not a live session */ }
    }
  } catch { /* unreadable registry */ }
  if (live > 0 && reachable === 0) {
    return { ok: false, reason: "this Claude Code binds no messaging sockets (needs a newer version)" };
  }
  return { ok: true, reason: "" };
}

export function createPeer(host: PeerHost): Peer {
  const capability = peerCapability();
  const socketPath = join(host.stateDir, "peer.sock");
  const name = peerNameFor(host.cwd);
  const entryPath = join(sessionsDir(), `${process.pid}.json`);
  const conversationsPath = join(host.stateDir, "peer-conversations.json");
  const stateFile = join(host.stateDir, "peer-state.json");

  /** senderKey (reply socket path) → that sender's MOST RECENT conversation,
   *  used when a message names no topic. */
  const conversations = new Map<string, Conversation>();
  /** peer name → conversation, so a `topic:` line reopens the conversation
   *  it names instead of starting a duplicate. */
  const byLabel = new Map<string, Conversation>();
  /** threadId → conversation (reverse index for consult + reply routing). */
  const threadConversations = new Map<string, Conversation>();
  /** threadId → its per-thread peer (registry entry + socket + holder). */
  const threadPeers = new Map<string, ThreadPeer>();
  /** threadId → accumulated reply text for a peer-initiated turn. */
  const replyBuffers = new Map<string, string[]>();
  /** threadId → the run record and log this peer turn is writing, so
   *  `progress`, `output`, `follow` and thread status work on a messaged
   *  conversation exactly as they do on a CLI run. Without it the only
   *  answerable question about a running turn is "has it replied yet",
   *  which is useless when what you need to know is whether it is stuck. */
  const activeRuns = new Map<string, { runId: string; dispatcher: EventDispatcher; startedAt: number }>();
  /** threadId → pending consult awaiting the sender's next message. */
  const pendingConsults = new Map<string, PendingConsult>();
  /** Bounded msg_id dedupe (Claude Code retries identical sends). */
  const seenMsgIds = new Set<string>();

  let server: net.Server | null = null;
  let active = false;
  let stopped = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  // ── Persistence (best-effort; a lost map only means a fresh thread) ──

  function loadConversations(): void {
    try {
      const parsed = JSON.parse(readFileSync(conversationsPath, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (typeof c?.threadId === "string" && typeof c?.replyPath === "string") {
            const conv: Conversation = {
              threadId: c.threadId,
              shortId: typeof c.shortId === "string" ? c.shortId : undefined,
              label: typeof c.label === "string" ? c.label : undefined,
              replyPath: c.replyPath,
              fromName: typeof c.fromName === "string" ? c.fromName : "claude",
              sandbox: typeof c.sandbox === "string" ? c.sandbox : undefined,
              model: typeof c.model === "string" ? c.model : undefined,
              effort: typeof c.effort === "string" ? c.effort : undefined,
              lastActivity: Date.now(),
            };
            conversations.set(conv.replyPath, conv);
            threadConversations.set(conv.threadId, conv);
            if (conv.label) byLabel.set(conv.label, conv);
          }
        }
      }
    } catch { /* none yet */ }
  }

  function saveConversations(): void {
    try {
      writeFileSync(conversationsPath, JSON.stringify([...conversations.values()], null, 2), { mode: 0o600 });
    } catch (e) {
      host.log(`peer: could not persist conversations: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function updateStatus(status: "idle" | "busy"): void {
    try {
      const entry = JSON.parse(readFileSync(entryPath, "utf-8"));
      entry.status = status;
      entry.updatedAt = Date.now();
      entry.statusUpdatedAt = Date.now();
      writeFileSync(entryPath, JSON.stringify(entry));
    } catch { /* entry gone — re-registration happens on next start */ }
  }

  // ── Outbound ──

  /** The identity a conversation speaks as: its thread peer when one is
   *  registered, else the front door. Replying to our messages therefore
   *  naturally continues the SAME conversation — the reply address is the
   *  thread binding. */
  function identityFor(threadId: string | null): { sock: string; name: string } {
    const tp = threadId ? threadPeers.get(threadId) : undefined;
    return tp ? { sock: tp.socketPath, name: tp.name } : { sock: socketPath, name };
  }

  function deliverTo(replyPath: string, text: string, asThreadId: string | null = null): void {
    const id = identityFor(asThreadId);
    // Attest the mode of the conversation doing the talking, falling back to
    // the workspace default for messages with no thread (front-door errors).
    const sandbox = (asThreadId ? threadConversations.get(asThreadId)?.sandbox : undefined)
      ?? readUserConfig().sandbox;
    const line = buildEnvelope({
      text,
      ourSocketPath: id.sock,
      ourName: id.name,
      mode: peerModeFor(sandbox),
    });
    const sock = net.connect({ path: replyPath }, () => {
      sock.write(line);
      sock.end();
    });
    sock.on("error", (e) => {
      host.log(`peer: could not deliver to ${replyPath}: ${e.message}`);
    });
  }

  // ── Per-thread peers ──

  /** Attach a line-parsing inbound handler to a peer socket. `boundThreadId`
   *  pins messages to a specific conversation (thread-peer sockets); null
   *  means front-door routing by sender. */
  function attachSocketHandler(server: net.Server, boundThreadId: string | null): void {
    server.on("connection", (sock) => {
      sock.setEncoding("utf8");
      let buffer = "";
      sock.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) { sock.destroy(); return; }
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = parseEnvelope(line);
          if (!msg) continue;
          enqueueInbound(msg, boundThreadId);
        }
      });
      sock.on("error", () => { /* sender hangups are routine */ });
    });
  }

  function createThreadPeer(threadId: string, shortId: string, label?: string): void {
    if (threadPeers.has(threadId)) return;
    if (threadPeers.size >= MAX_THREAD_PEERS) {
      host.log(`peer: thread-peer cap (${MAX_THREAD_PEERS}) reached — ${threadId} stays behind the front door`);
      return;
    }
    // Track partially-created resources so a failure anywhere below cleans
    // up completely — an untracked holder or listener would outlive every
    // sweep and stop() because nothing else knows about it.
    let holder: ChildProcess | null = null;
    let server: net.Server | null = null;
    try {
      // The holder is a liveness token: registry entries bind filename pid ==
      // content pid == a live process, one entry per pid, so every extra peer
      // needs a real (tiny) process. Its stdin pipe ties its life to ours.
      holder = spawn("sh", ["-c", "read _ || true"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (!holder.pid) throw new Error("holder spawn returned no pid");
      // Uniqueness: the name IS the address. A topic label can collide with
      // a live sibling (same topic twice, or the front door's name) — the
      // short-id suffix disambiguates only when needed, keeping the common
      // case clean.
      let tpName = label ?? `codex-${shortId}`;
      const taken = tpName === name || [...threadPeers.values()].some((tp) => tp.name === tpName);
      if (taken) tpName = `${tpName}-${shortId.slice(0, 4)}`;
      const tpSocketPath = join(host.stateDir, `peer-${shortId}.sock`);
      const tpEntryPath = join(sessionsDir(), `${holder.pid}.json`);

      try { unlinkSync(tpSocketPath); } catch { /* none */ }
      const prevUmask = process.umask(0o077);
      server = net.createServer();
      attachSocketHandler(server, threadId);
      // A listen failure is asynchronous; without a handler it is an
      // uncaught exception that kills the whole broker. Retire just this
      // thread peer instead — the conversation stays reachable via the
      // front door.
      server.on("error", (e) => {
        host.log(`peer: thread-peer socket error for ${threadId}: ${e.message} — retiring it`);
        retireThreadPeer(threadId);
      });
      server.listen(tpSocketPath);
      process.umask(prevUmask);

      const entry = buildRegistryEntry({
        pid: holder.pid,
        cwd: host.cwd,
        name: tpName,
        socketPath: tpSocketPath,
        version: sniffRegistryVersion(),
        procStart: procStartOf(holder.pid),
        sessionId: randomUUID(),
      });
      writeFileSync(tpEntryPath, JSON.stringify(entry), { mode: 0o644 });
      holder.unref();

      threadPeers.set(threadId, {
        threadId, name: tpName, socketPath: tpSocketPath, entryPath: tpEntryPath, holder, server,
      });
      host.log(`peer: thread peer "${tpName}" registered for ${threadId}`);
    } catch (e) {
      host.log(`peer: could not create thread peer for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
      // Failure after partial setup (e.g. procStartOf or the registry write
      // threw): reap what exists, or it leaks past every sweep and stop().
      try { server?.close(); } catch { /* not listening */ }
      try { holder?.kill(); } catch { /* not spawned */ }
      if (holder?.pid) {
        try { unlinkSync(join(sessionsDir(), `${holder.pid}.json`)); } catch { /* not written */ }
      }
      try { unlinkSync(join(host.stateDir, `peer-${shortId}.sock`)); } catch { /* not bound */ }
    }
  }

  function retireThreadPeer(threadId: string): void {
    const tp = threadPeers.get(threadId);
    if (!tp) return;
    threadPeers.delete(threadId);
    try { tp.server.close(); } catch { /* already down */ }
    try { unlinkSync(tp.socketPath); } catch { /* none */ }
    try { unlinkSync(tp.entryPath); } catch { /* none */ }
    try { tp.holder.kill(); } catch { /* already dead */ }
  }

  /** Sweep idle thread peers. The conversation record survives — the next
   *  front-door message re-materializes the thread peer. */
  function sweepThreadPeers(): void {
    const now = Date.now();
    for (const [threadId] of threadPeers) {
      const conv = threadConversations.get(threadId);
      const idle = !conv || now - conv.lastActivity > THREAD_PEER_LINGER_MS;
      if (idle && !host.threadHasTurn(threadId)) retireThreadPeer(threadId);
    }
  }

  /** Adopt a thread a CLI client just created or resumed, so it can be
   *  messaged later. The CLI registers the thread in the shared index
   *  immediately after `thread/start` returns, but the broker sees the
   *  response FIRST — so look the name up on a short delay rather than
   *  racing it, and fall back to a derived suffix if the index has nothing
   *  (an external thread, or an index write that failed). */
  function adoptThread(threadId: string): void {
    if (!active || stopped || threadPeers.has(threadId)) return;
    const timer = setTimeout(() => {
      if (!active || stopped || threadPeers.has(threadId)) return;
      let shortId: string | null = null;
      let preview = "";
      try {
        shortId = findShortId(host.stateDir, threadId);
        if (shortId) preview = loadThreadIndex(host.stateDir)[shortId]?.preview ?? "";
      } catch { /* index unreadable — derive below */ }
      const id = shortId ?? threadId.replace(/-/g, "").slice(-8);
      createThreadPeer(threadId, id, threadPeerLabel(preview, id));
    }, 2000);
    timer.unref?.();
  }

  // ── Run records for peer turns ──

  /** Open a run record and progress log for a turn the peer is about to
   *  start, mirroring what the CLI writes so `progress`, `output`, `follow`
   *  and `threads` status answer the same questions for a messaged
   *  conversation. Best-effort: a ledger failure must never stop the turn. */
  function beginRun(threadId: string, shortId: string, prompt: string, model?: string): void {
    try {
      const runId = generateRunId();
      const logFile = runLogRelPath(shortId, runId);
      const dispatcher = new EventDispatcher(
        join(host.stateDir, logFile),
        () => {}, // no terminal to print to — the log IS the progress surface
      );
      createRun(host.stateDir, {
        runId,
        threadId,
        shortId,
        kind: "task",
        phase: "running",
        status: "running",
        pid: process.pid,
        sessionId: null,
        logFile,
        logOffset: 0,
        prompt,
        model: model ?? null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        elapsed: null,
        output: null,
        filesChanged: null,
        commandsRun: null,
        error: null,
      });
      activeRuns.set(threadId, { runId, dispatcher, startedAt: Date.now() });
      updateThreadStatus(host.stateDir, threadId, "running");
      pruneRuns(host.stateDir);
    } catch (e) {
      host.log(`peer: could not open a run record for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Close the run record for a finished peer turn. `status` comes from
   *  turn.status, so an interrupted or failed turn is recorded as such
   *  rather than silently reading as success. */
  function finishRun(threadId: string, status: string, output: string, error: string | null): void {
    const run = activeRuns.get(threadId);
    if (!run) return;
    activeRuns.delete(threadId);
    try {
      run.dispatcher.flushOutput();
      run.dispatcher.flush();
      const normalized = status === "completed" || status === "failed" || status === "interrupted"
        ? status
        : "completed";
      updateRun(host.stateDir, run.runId, {
        status: normalized as "completed" | "failed" | "interrupted",
        phase: "finalizing",
        completedAt: new Date().toISOString(),
        elapsed: `${Math.round((Date.now() - run.startedAt) / 1000)}s`,
        output: output || null,
        filesChanged: run.dispatcher.getFilesChanged(),
        commandsRun: run.dispatcher.getCommandsRun(),
        error,
        pendingApproval: null,
        pendingQuestion: null,
      });
      updateThreadStatus(host.stateDir, threadId, normalized as "completed" | "failed" | "interrupted");
    } catch (e) {
      host.log(`peer: could not close the run record for ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Internal thread ownership ──

  function ownerFor(threadId: string): InternalOwner {
    return {
      kind: "peer",
      onNotification(method, params) {
        // Feed the same dispatcher the CLI uses, so a messaged conversation
        // produces the same progress log and run record a `run` does.
        const run = activeRuns.get(threadId);
        if (run) {
          try {
            if (method === "item/started") {
              run.dispatcher.handleItemStarted(params as never);
            } else if (method === "item/completed") {
              run.dispatcher.handleItemCompleted(params as never);
            } else if (method.endsWith("/delta") || method.endsWith("Delta")) {
              run.dispatcher.handleDelta(method, params as never);
            } else if (method === "error") {
              run.dispatcher.handleError(params as never);
            }
          } catch (e) {
            // Progress logging must never break delivery.
            host.log(`peer: progress logging failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (method === "item/completed") {
          const item = params?.item as { type?: string; text?: string } | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            replyBuffers.get(threadId)?.push(item.text);
          }
        } else if (method === "turn/completed") {
          // There is no turn/failed notification — failure and interruption
          // arrive as turn/completed with turn.status set accordingly.
          const texts = replyBuffers.get(threadId);
          replyBuffers.delete(threadId);
          updateStatus("idle");
          const conv = threadConversations.get(threadId);
          if (!conv) return;
          conv.lastActivity = Date.now();
          // Buffer already consumed (or never armed): this is a goal-mode
          // continuation turn completing after the reply was delivered —
          // stay silent rather than spam the sender per continuation.
          if (!texts) return;
          const turn = params?.turn as { status?: string; error?: { message?: string } | null } | undefined;
          const reply = texts.join("\n\n").trim();
          finishRun(threadId, turn?.status ?? "completed", reply, turn?.error?.message ?? null);
          const died = turn?.status === "failed" || turn?.status === "interrupted";
          if (reply) {
            // A turn that died mid-way may still have buffered text (its
            // opening message, typically). Delivering that alone reads as
            // Codex still working — or worse, as the finished answer. Say
            // what happened. (Live-observed: `kill` on a peer turn delivered
            // only "I'll run the two-minute wait…" with no hint of the kill.)
            const note = died
              ? `\n\n[codex-collab] Note: the turn ${turn!.status} after this text was written — it is not a complete reply${turn?.error?.message ? ` (${turn.error.message})` : ""}.`
              : "";
            deliverTo(conv.replyPath, reply + note, threadId);
          } else if (died) {
            const err = turn?.error?.message;
            deliverTo(conv.replyPath, `[codex-collab] The turn ${turn?.status} before producing a reply${err ? `: ${err}` : "."}`, threadId);
          } else {
            // A silent success reads as a lost message to the sender.
            deliverTo(conv.replyPath, "[codex-collab] Codex finished the turn without a closing message.", threadId);
          }
        }
      },
    };
  }

  // ── Thread bootstrap ──

  async function startThread(
    fromName: string,
    firstMessage: string,
    headers: MessageHeaders = { topic: null },
  ): Promise<{ threadId: string; shortId: string; sandbox: string; model?: string; effort?: string }> {
    const userConfig = readUserConfig();
    // Header settings override the workspace defaults for this conversation
    // only. `auto` maps to Guardian, the one approval policy that resolves
    // without a human at a terminal; everything else stays `never`, because
    // approval prompts route to CLI client sockets and would hang here.
    const approval = headers.approval === "auto"
      ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review" }
      : { approvalPolicy: "never", approvalsReviewer: "user" };
    const sandbox = headers.sandbox ?? userConfig.sandbox ?? "workspace-write";
    const params: Record<string, unknown> = {
      cwd: host.cwd,
      ...approval,
      sandbox,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      developerInstructions: PEER_DEVELOPER_INSTRUCTIONS,
      dynamicTools: PEER_DYNAMIC_TOOLS,
    };
    const model = headers.model ?? userConfig.model;
    if (model) params.model = model;
    // Reasoning effort reaches a thread only through `config`, which the peer
    // used to drop entirely — a workspace default that silently did nothing.
    const effort = headers.effort ?? userConfig.reasoning;
    if (effort) params.config = { model_reasoning_effort: effort };
    const result = await host.request("thread/start", params) as {
      thread: { id: string };
      model?: string;
    };
    const threadId = result.thread.id;
    // Peer conversations live in the same thread index the CLI uses, so
    // `codex-collab threads` shows them and short IDs stay one namespace.
    // Preview and server-side name both carry the conversation's opening
    // message — the same convention `run` uses with its prompt — so
    // listings read as topics.
    const preview = firstMessage.split("\n", 1)[0].slice(0, 100) || `peer conversation with ${fromName}`;
    let shortId: string;
    try {
      shortId = registerThread(host.stateDir, threadId, {
        model: result.model,
        cwd: host.cwd,
        preview,
      });
    } catch {
      shortId = threadId.replace(/-/g, "").slice(-8); // index unavailable — derive a stable suffix
    }
    try {
      await host.request("thread/name/set", { threadId, name: preview });
    } catch { /* non-fatal, like run's naming */ }
    // Keep peer threads out of Codex's memory consolidation, like every
    // thread codex-collab creates. Non-fatal.
    try {
      await host.request("thread/memoryMode/set", { threadId, mode: "disabled" });
    } catch { /* older codex */ }
    return { threadId, shortId, sandbox, model, effort };
  }

  /** Minimal user-defaults read (model/sandbox). commands/shared.ts owns the
   *  full loader, but the broker process should not import the CLI layer —
   *  and a broken config file must degrade, not die, in a daemon. */
  function readUserConfig(): { model?: string; sandbox?: string; reasoning?: string } {
    try {
      const parsed = JSON.parse(readFileSync(config.configFile, "utf-8"));
      return {
        model: typeof parsed?.model === "string" ? parsed.model : undefined,
        sandbox: typeof parsed?.sandbox === "string" ? parsed.sandbox : undefined,
        reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : undefined,
      };
    } catch {
      return {};
    }
  }

  async function injectPeerMessage(threadId: string, fromName: string, text: string): Promise<void> {
    await host.request("thread/inject_items", {
      threadId,
      items: [{
        type: "agent_message",
        author: "/root/claude",
        recipient: "/root",
        content: [{ type: "input_text", text: `[${fromName}] ${text}` }],
      }],
    });
  }

  // ── Inbound ──

  /** Per-conversation FIFO for inbound messages. Two messages from the same
   *  new sender arriving back-to-back would otherwise BOTH miss the
   *  conversation map — the first handler's `await startThread()` is a
   *  suspension point — and each would create its own thread. Claude Code
   *  queues sends and drains them in bursts, so this race is a matter of
   *  when, not if. Keyed by the thread for thread-peer sockets and by the
   *  sender for the front door: the same key a message would resolve its
   *  conversation under. */
  const inboundQueues = new Map<string, Promise<void>>();

  function enqueueInbound(msg: InboundMessage, boundThreadId: string | null): void {
    const key = boundThreadId ?? msg.replyPath;
    const prev = inboundQueues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => handleInbound(msg, boundThreadId))
      .catch((e) => {
        const detail = e instanceof Error ? e.message : String(e);
        host.log(`peer: inbound handling failed: ${detail}`);
        // Tell the sender: without this, a processing failure (a rejected
        // thread/start — say, an invalid `model:` header — or an
        // unrecoverable thread) reads as Codex silently thinking forever.
        // The message stays unmarked in the dedupe set, so a retry retries.
        deliverTo(msg.replyPath, `[codex-collab] Your message could not be processed: ${detail}`, boundThreadId);
      });
    inboundQueues.set(key, next);
    void next.finally(() => {
      if (inboundQueues.get(key) === next) inboundQueues.delete(key);
    });
  }

  /** Record a message id as handled. Called on SUCCESS paths only: marking
   *  before delivery would turn any transient failure into a permanently
   *  lost message, because the sender's retry (same id) would be dropped
   *  as a duplicate. */
  function markSeen(msgId: string): void {
    seenMsgIds.add(msgId);
    if (seenMsgIds.size > 500) {
      for (const id of [...seenMsgIds].slice(0, 250)) seenMsgIds.delete(id);
    }
  }

  /** True iff the reply path belongs to a live REGISTERED session: some
   *  registry entry advertises it as messagingSocketPath and its process is
   *  alive. This is the trust gate on inbound messages. It matters beyond
   *  hostile-neighbor hygiene: Codex's own sandboxed exec commands run
   *  same-uid and could otherwise connect to our sockets and answer their
   *  OWN pending consult — a self-approval loop. Registration is something
   *  only a real Claude Code session (or the user) produces. */
  function senderIsRegistered(replyPath: string): boolean {
    try {
      for (const file of readdirSync(sessionsDir())) {
        if (!file.endsWith(".json")) continue;
        try {
          const entry = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
          if (entry?.messagingSocketPath !== replyPath) continue;
          if (typeof entry?.pid !== "number") continue;
          process.kill(entry.pid, 0);
          return true;
        } catch { /* unreadable entry or dead pid — keep scanning */ }
      }
    } catch { /* registry gone */ }
    return false;
  }

  async function handleInbound(msg: InboundMessage, boundThreadId: string | null = null): Promise<void> {
    if (seenMsgIds.has(msg.msgId)) return;

    if (!senderIsRegistered(msg.replyPath)) {
      markSeen(msg.msgId); // rejection is final — no point re-processing retries
      host.log(`peer: dropping message from unregistered sender ${msg.replyPath}`);
      return;
    }

    /** Headers are parsed on EVERY message — a bound (thread-peer) socket
     *  pins the conversation, so its `topic:` is inert, but `model:` and
     *  `effort:` adjustments must work however the sender addressed us:
     *  replying to the conversation's own peer is the natural way to send
     *  them. What reaches Codex is the message minus the header block —
     *  addressing and settings metadata, not content. */
    const parsed = parseHeaders(msg.text);
    const headers = parsed.headers;
    const deliveryText = parsed.body !== msg.text ? parsed.body : msg.text;
    /** A `topic:` line SELECTS a conversation: it continues the one with
     *  that name, or starts a new one. Without it, a sender continues
     *  whichever conversation it spoke to last — so one session can hold
     *  several parallel conversations, switching between them by topic. */
    const topic = boundThreadId ? null : headers.topic;

    // A thread-peer socket pins the conversation; the front door routes by
    // topic when given, else by sender. Either way the most recent sender
    // becomes the conversation's counterpart — the person actively talking
    // is who consults and replies go to.
    const topicLabel = topic ? topicPeerLabel(topic) : "";
    let conv = boundThreadId
      ? threadConversations.get(boundThreadId)
      : topic
        ? (topicLabel ? byLabel.get(topicLabel) : undefined)
        : conversations.get(msg.replyPath);

    // A pending consult on this conversation's thread consumes the message
    // as its answer — that is the whole correlation rule: the reply address
    // binds the thread, and one consult per thread is in flight.
    if (conv) {
      const pending = pendingConsults.get(conv.threadId);
      if (pending) {
        pendingConsults.delete(conv.threadId);
        clearTimeout(pending.timer);
        conv.lastActivity = Date.now();
        pending.resolve(msg.text);
        markSeen(msg.msgId);
        return;
      }
    }

    // Ensure a thread for this conversation.
    let freshThread = false;
    if (!conv) {
      if (boundThreadId) {
        // Thread-peer socket for a conversation we no longer track (state
        // loss) — rebind to the existing thread rather than starting fresh.
        conv = { threadId: boundThreadId, replyPath: msg.replyPath, fromName: msg.fromName, lastActivity: Date.now() };
        conversations.set(msg.replyPath, conv);
        threadConversations.set(boundThreadId, conv);
        saveConversations();
      } else {
        const { threadId, shortId, sandbox, model, effort } = await startThread(msg.fromName, topic ?? deliveryText, headers);
        const label = topicLabel || threadPeerLabel(deliveryText, shortId);
        conv = { threadId, shortId, label, replyPath: msg.replyPath, fromName: msg.fromName, sandbox, model, effort, lastActivity: Date.now() };
        conversations.set(msg.replyPath, conv); // newest becomes this sender's default
        threadConversations.set(threadId, conv);
        if (label) byLabel.set(label, conv);
        createThreadPeer(threadId, shortId, label);
        saveConversations();
        host.log(`peer: new conversation "${label}" with ${msg.fromName} → thread ${threadId}`);
        freshThread = true;
      }
    } else {
      conv.lastActivity = Date.now();
      if (conv.replyPath !== msg.replyPath || (msg.fromName && conv.fromName !== msg.fromName)) {
        // Only clear the old sender slot if it still points at THIS
        // conversation — a sender can now hold several.
        if (conversations.get(conv.replyPath) === conv) conversations.delete(conv.replyPath);
        conv.replyPath = msg.replyPath;
        conv.fromName = msg.fromName || conv.fromName;
        conversations.set(conv.replyPath, conv);
        saveConversations();
      }
      // Re-materialize a retired (or never-created) thread peer on activity.
      if (!threadPeers.has(conv.threadId)) {
        createThreadPeer(
          conv.threadId,
          conv.shortId ?? conv.threadId.replace(/-/g, "").slice(-8),
          conv.label,
        );
      }
    }

    // Settings carried on a CONTINUATION message. model/effort are per-turn
    // settings (turn/start accepts both), so an update takes effect from the
    // next turn the peer starts — the recovery path for a conversation whose
    // model turned out to be wrong. sandbox/approval bind at thread creation
    // and cannot change mid-conversation: say so rather than silently
    // dropping the request (the header block already stripped it from what
    // Codex sees, so nobody else will).
    if (!freshThread) {
      const settingsChanged =
        (headers.model !== undefined && headers.model !== conv.model) ||
        (headers.effort !== undefined && headers.effort !== conv.effort);
      if (settingsChanged) {
        if (headers.model !== undefined) conv.model = headers.model;
        if (headers.effort !== undefined) conv.effort = headers.effort;
        saveConversations();
      }
      if (headers.sandbox !== undefined || headers.approval !== undefined) {
        deliverTo(
          conv.replyPath,
          "[codex-collab] Note: sandbox: and approval: are fixed when a conversation starts — this conversation keeps its original settings (model:/effort: updates do apply, from the next turn). Start a new topic: to use a different sandbox or approval mode.",
          conv.threadId,
        );
      }
    }

    // Deliver in native peer form, resuming an unloaded thread if needed.
    // A resumed thread has lost its dynamic tools (thread/resume cannot
    // re-declare them) — re-send instructions that say so.
    try {
      await injectPeerMessage(conv.threadId, msg.fromName, deliveryText);
    } catch {
      try {
        await host.request("thread/resume", {
          threadId: conv.threadId,
          developerInstructions: PEER_RESUME_INSTRUCTIONS,
        });
        await injectPeerMessage(conv.threadId, msg.fromName, deliveryText);
      } catch (e) {
        // Thread unrecoverable (deleted?) — start fresh and redeliver.
        host.log(`peer: thread ${conv.threadId} unrecoverable (${e instanceof Error ? e.message : String(e)}) — starting a new one`);
        threadConversations.delete(conv.threadId);
        retireThreadPeer(conv.threadId);
        const { threadId, shortId, sandbox, model, effort } = await startThread(msg.fromName, topic ?? deliveryText, headers);
        conv.threadId = threadId;
        conv.shortId = shortId;
        conv.sandbox = sandbox;
        conv.model = model;
        conv.effort = effort;
        // Keep the conversation's name across a thread restart: its name is
        // its ADDRESS, and a recreated thread is still the same conversation.
        if (!conv.label) conv.label = threadPeerLabel(deliveryText, shortId);
        threadConversations.set(threadId, conv);
        if (conv.label) byLabel.set(conv.label, conv);
        createThreadPeer(threadId, shortId, conv.label);
        saveConversations();
        await injectPeerMessage(threadId, msg.fromName, deliveryText);
      }
    }

    // The message is in the thread — delivery has happened; everything
    // after is a best-effort wake-up. Only now is a retry a duplicate.
    markSeen(msg.msgId);

    // Mid-turn: the injection is read at the next sampling point — done.
    if (host.threadHasTurn(conv.threadId)) return;

    // Idle: wake the thread. The claim can race a CLI run's turn/start;
    // losing it just means the message waits for that turn's next sampling.
    if (!host.claimThread(conv.threadId, ownerFor(conv.threadId))) return;
    replyBuffers.set(conv.threadId, []);
    beginRun(
      conv.threadId,
      conv.shortId ?? conv.threadId.replace(/-/g, "").slice(-8),
      deliveryText,
      conv.model,
    );
    updateStatus("busy");
    try {
      // Every peer-started turn restates the conversation's model/effort:
      // turn/start accepts both, which is what makes a continuation
      // message's `model:`/`effort:` update actually take effect.
      await host.request("turn/start", {
        threadId: conv.threadId,
        ...(conv.model ? { model: conv.model } : {}),
        ...(conv.effort ? { effort: conv.effort } : {}),
        input: [{
          type: "text",
          text: "(A peer message was just delivered to this conversation as an agent_message from /root/claude. Read it and respond or act accordingly.)",
        }],
      });
    } catch (e) {
      // The claim MUST be released here: no turn started, so no
      // turn/completed will ever free it, and an internal owner never
      // disconnects — a leaked claim blocks the thread (and idle shutdown)
      // for the broker's whole life.
      host.releaseThread(conv.threadId);
      replyBuffers.delete(conv.threadId);
      finishRun(conv.threadId, "failed", "", e instanceof Error ? e.message : String(e));
      updateStatus("idle");
      host.log(`peer: turn/start failed for ${conv.threadId}: ${e instanceof Error ? e.message : String(e)}`);
      deliverTo(conv.replyPath, `[codex-collab] Could not start a turn: ${e instanceof Error ? e.message : String(e)}`, conv.threadId);
    }
  }

  // ── Consult bridge ──

  async function handleToolCall(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const tool = typeof params.tool === "string" ? params.tool : "";
    const args = params.arguments as { question?: unknown } | undefined;
    const question = typeof args?.question === "string" ? args.question : "";

    const failOpen = (text: string) => ({
      contentItems: [{ type: "inputText", text }],
      success: true,
    });

    if (tool !== "consult" || !question) {
      return { contentItems: [{ type: "inputText", text: `Unknown tool call: ${tool}` }], success: false };
    }
    const conv = threadConversations.get(threadId);
    if (!conv) {
      return failOpen("No Claude peer is connected to this conversation — proceed on your own best judgment.");
    }
    if (pendingConsults.has(threadId)) {
      // One consult per (thread, sender) in flight keeps correlation exact.
      return failOpen("A previous consult is still awaiting an answer — proceed on your own best judgment, or retry later.");
    }

    deliverTo(
      conv.replyPath,
      `[consult] ${question}\n\n(Codex is waiting on your answer — reply to this peer to deliver it. If no answer arrives within ${Math.round(CONSULT_TIMEOUT_MS / 60000)} minutes, Codex proceeds on its own.)`,
      threadId,
    );

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingConsults.delete(threadId);
        resolve(null);
      }, CONSULT_TIMEOUT_MS);
      timer.unref?.();
      pendingConsults.set(threadId, { threadId, resolve, timer });
    });

    return answer === null
      ? failOpen("No answer arrived in time — proceed on your own best judgment.")
      : failOpen(answer);
  }

  // ── Liveness scan ──

  function hasLiveSessions(): boolean {
    // Entries WE wrote must not count: the front door is our own pid, and
    // thread-peer entries are backed by our holder processes — counting
    // them would keep the broker resident because of its own bookkeeping.
    const ours = new Set<number>([process.pid]);
    for (const tp of threadPeers.values()) {
      if (tp.holder.pid) ours.add(tp.holder.pid);
    }
    try {
      for (const file of readdirSync(sessionsDir())) {
        if (!file.endsWith(".json")) continue;
        const pid = Number(file.slice(0, -".json".length));
        if (!Number.isInteger(pid) || pid <= 0 || ours.has(pid)) continue;
        // Validate content, not just filename liveness: a recycled pid (or
        // a junk file) would otherwise keep the broker and its app-server
        // resident indefinitely. This scan runs once per idle period, so
        // the per-entry ps call is cheap where it matters.
        try {
          const entry = JSON.parse(readFileSync(join(sessionsDir(), file), "utf-8"));
          if (entry?.pid !== pid) continue;
          process.kill(pid, 0);
          if (typeof entry?.procStart === "string" && entry.procStart !== procStartOf(pid)) continue;
          return true;
        } catch { /* dead, unreadable, or ps failed — not a live session */ }
      }
    } catch { /* registry gone */ }
    return false;
  }

  // ── Start / stop ──

  function start(): boolean {
    if (!capability.ok) {
      host.log(`peer: inactive (${capability.reason})`);
      return false;
    }
    try {
      loadConversations();

      // Socket first, registry second: the entry advertises the socket, so
      // the socket must exist before anyone can read the advertisement.
      try { unlinkSync(socketPath); } catch { /* none */ }
      const prevUmask = process.umask(0o077);
      server = net.createServer();
      attachSocketHandler(server, null);
      // Async listen failures must not crash the broker — a peer that
      // cannot bind simply deactivates; everything else keeps working.
      server.on("error", (e) => {
        host.log(`peer: front-door socket error: ${e.message} — deactivating peer`);
        stop();
      });
      server.listen(socketPath);
      process.umask(prevUmask);

      const entry = buildRegistryEntry({
        pid: process.pid,
        cwd: host.cwd,
        name,
        socketPath,
        version: sniffRegistryVersion(),
        procStart: procStartOf(process.pid),
        sessionId: randomUUID(),
      });
      mkdirSync(sessionsDir(), { recursive: true });
      writeFileSync(entryPath, JSON.stringify(entry), { mode: 0o644 });
      writeFileSync(stateFile, JSON.stringify({
        pid: process.pid, name, socketPath, startedAt: new Date().toISOString(),
      }, null, 2) + "\n", { mode: 0o600 });

      sweepTimer = setInterval(sweepThreadPeers, 5 * 60_000);
      sweepTimer.unref?.();

      active = true;
      host.log(`peer: registered as "${name}" (socket ${socketPath})`);
      return true;
    } catch (e) {
      host.log(`peer: failed to start (${e instanceof Error ? e.message : String(e)}) — continuing without peer`);
      stop();
      return false;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    active = false;
    if (sweepTimer) clearInterval(sweepTimer);
    for (const [threadId, pending] of pendingConsults) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      pendingConsults.delete(threadId);
    }
    for (const [threadId] of threadPeers) retireThreadPeer(threadId);
    try { server?.close(); } catch { /* already down */ }
    try { unlinkSync(socketPath); } catch { /* none */ }
    try { unlinkSync(entryPath); } catch { /* none */ }
    try { unlinkSync(stateFile); } catch { /* none */ }
  }

  start();

  return {
    get active() { return active; },
    ownsThread: (threadId: string) => threadConversations.has(threadId),
    adoptThread,
    handleToolCall,
    hasLiveSessions,
    stop,
  };
}
