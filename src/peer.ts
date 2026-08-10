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
import { registerThread } from "./threads";
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
  /** Short ID from the thread index — names the thread peer. */
  shortId?: string;
  /** Reply socket path (the sender's own messaging socket). Updated to the
   *  most recent sender — the person actively talking is who consults and
   *  replies go to. */
  replyPath: string;
  /** Sender's display name, for attribution inside Codex's context. */
  fromName: string;
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

/** Peer display name for a workspace: codex-<dir>, sanitized. */
export function peerNameFor(cwd: string): string {
  const dir = basename(cwd).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `codex-${dir || "workspace"}`.slice(0, 40);
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
    msgId: typeof parsed.msg_id === "string" ? parsed.msg_id : randomUUID(),
    replyPath,
    fromName,
    text,
  };
}

/** Build an outbound envelope line. The SENDER performs the
 *  cross-session-message wrapping (that is the protocol's convention). */
export function buildEnvelope(opts: {
  text: string;
  ourSocketPath: string;
  ourName: string;
}): string {
  const wrapped =
    `<cross-session-message from="uds:${opts.ourSocketPath}" from-name="${opts.ourName}">\n` +
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
  return { ok: true, reason: "" };
}

export function createPeer(host: PeerHost): Peer {
  const capability = peerCapability();
  const socketPath = join(host.stateDir, "peer.sock");
  const name = peerNameFor(host.cwd);
  const entryPath = join(sessionsDir(), `${process.pid}.json`);
  const conversationsPath = join(host.stateDir, "peer-conversations.json");
  const stateFile = join(host.stateDir, "peer-state.json");

  /** senderKey (reply socket path) → conversation. */
  const conversations = new Map<string, Conversation>();
  /** threadId → conversation (reverse index for consult + reply routing). */
  const threadConversations = new Map<string, Conversation>();
  /** threadId → its per-thread peer (registry entry + socket + holder). */
  const threadPeers = new Map<string, ThreadPeer>();
  /** threadId → accumulated reply text for a peer-initiated turn. */
  const replyBuffers = new Map<string, string[]>();
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
              replyPath: c.replyPath,
              fromName: typeof c.fromName === "string" ? c.fromName : "claude",
              lastActivity: Date.now(),
            };
            conversations.set(conv.replyPath, conv);
            threadConversations.set(conv.threadId, conv);
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
    const line = buildEnvelope({ text, ourSocketPath: id.sock, ourName: id.name });
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

  function createThreadPeer(threadId: string, shortId: string): void {
    if (threadPeers.has(threadId)) return;
    if (threadPeers.size >= MAX_THREAD_PEERS) {
      host.log(`peer: thread-peer cap (${MAX_THREAD_PEERS}) reached — ${threadId} stays behind the front door`);
      return;
    }
    try {
      // The holder is a liveness token: registry entries bind filename pid ==
      // content pid == a live process, one entry per pid, so every extra peer
      // needs a real (tiny) process. Its stdin pipe ties its life to ours.
      const holder = spawn("sh", ["-c", "read _ || true"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (!holder.pid) throw new Error("holder spawn returned no pid");
      const tpName = `codex-${shortId}`;
      const tpSocketPath = join(host.stateDir, `peer-${shortId}.sock`);
      const tpEntryPath = join(sessionsDir(), `${holder.pid}.json`);

      try { unlinkSync(tpSocketPath); } catch { /* none */ }
      const prevUmask = process.umask(0o077);
      const server = net.createServer();
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

  // ── Internal thread ownership ──

  function ownerFor(threadId: string): InternalOwner {
    return {
      kind: "peer",
      onNotification(method, params) {
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
          if (reply) {
            deliverTo(conv.replyPath, reply, threadId);
          } else if (turn?.status === "failed" || turn?.status === "interrupted") {
            const err = turn.error?.message;
            deliverTo(conv.replyPath, `[codex-collab] The turn ${turn.status} before producing a reply${err ? `: ${err}` : "."}`, threadId);
          } else {
            // A silent success reads as a lost message to the sender.
            deliverTo(conv.replyPath, "[codex-collab] Codex finished the turn without a closing message.", threadId);
          }
        }
      },
    };
  }

  // ── Thread bootstrap ──

  async function startThread(fromName: string): Promise<{ threadId: string; shortId: string }> {
    const userConfig = readUserConfig();
    const params: Record<string, unknown> = {
      cwd: host.cwd,
      approvalPolicy: "never",
      sandbox: userConfig.sandbox ?? "workspace-write",
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      developerInstructions: PEER_DEVELOPER_INSTRUCTIONS,
      dynamicTools: PEER_DYNAMIC_TOOLS,
    };
    if (userConfig.model) params.model = userConfig.model;
    const result = await host.request("thread/start", params) as {
      thread: { id: string };
      model?: string;
    };
    const threadId = result.thread.id;
    // Peer conversations live in the same thread index the CLI uses, so
    // `codex-collab threads` shows them and short IDs stay one namespace.
    let shortId: string;
    try {
      shortId = registerThread(host.stateDir, threadId, {
        model: result.model,
        cwd: host.cwd,
        preview: `peer conversation with ${fromName}`,
      });
    } catch {
      shortId = threadId.replace(/-/g, "").slice(-8); // index unavailable — derive a stable suffix
    }
    // Keep peer threads out of Codex's memory consolidation, like every
    // thread codex-collab creates. Non-fatal.
    try {
      await host.request("thread/memoryMode/set", { threadId, mode: "disabled" });
    } catch { /* older codex */ }
    return { threadId, shortId };
  }

  /** Minimal user-defaults read (model/sandbox). commands/shared.ts owns the
   *  full loader, but the broker process should not import the CLI layer —
   *  and a broken config file must degrade, not die, in a daemon. */
  function readUserConfig(): { model?: string; sandbox?: string } {
    try {
      const parsed = JSON.parse(readFileSync(config.configFile, "utf-8"));
      return {
        model: typeof parsed?.model === "string" ? parsed.model : undefined,
        sandbox: typeof parsed?.sandbox === "string" ? parsed.sandbox : undefined,
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
        host.log(`peer: inbound handling failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    inboundQueues.set(key, next);
    void next.finally(() => {
      if (inboundQueues.get(key) === next) inboundQueues.delete(key);
    });
  }

  async function handleInbound(msg: InboundMessage, boundThreadId: string | null = null): Promise<void> {
    if (seenMsgIds.has(msg.msgId)) return;
    seenMsgIds.add(msg.msgId);
    if (seenMsgIds.size > 500) {
      for (const id of [...seenMsgIds].slice(0, 250)) seenMsgIds.delete(id);
    }

    // A thread-peer socket pins the conversation; the front door routes by
    // sender. Either way the most recent sender becomes the conversation's
    // counterpart — the person actively talking is who consults and replies
    // go to.
    let conv = boundThreadId
      ? threadConversations.get(boundThreadId)
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
        return;
      }
    }

    // Ensure a thread for this conversation.
    if (!conv) {
      if (boundThreadId) {
        // Thread-peer socket for a conversation we no longer track (state
        // loss) — rebind to the existing thread rather than starting fresh.
        conv = { threadId: boundThreadId, replyPath: msg.replyPath, fromName: msg.fromName, lastActivity: Date.now() };
        conversations.set(msg.replyPath, conv);
        threadConversations.set(boundThreadId, conv);
        saveConversations();
      } else {
        const { threadId, shortId } = await startThread(msg.fromName);
        conv = { threadId, shortId, replyPath: msg.replyPath, fromName: msg.fromName, lastActivity: Date.now() };
        conversations.set(msg.replyPath, conv);
        threadConversations.set(threadId, conv);
        createThreadPeer(threadId, shortId);
        saveConversations();
        host.log(`peer: new conversation with ${msg.fromName} → thread ${threadId}`);
      }
    } else {
      conv.lastActivity = Date.now();
      if (conv.replyPath !== msg.replyPath || (msg.fromName && conv.fromName !== msg.fromName)) {
        conversations.delete(conv.replyPath);
        conv.replyPath = msg.replyPath;
        conv.fromName = msg.fromName || conv.fromName;
        conversations.set(conv.replyPath, conv);
        saveConversations();
      }
      // Re-materialize a retired (or never-created) thread peer on activity.
      if (!threadPeers.has(conv.threadId)) {
        createThreadPeer(conv.threadId, conv.shortId ?? conv.threadId.replace(/-/g, "").slice(-8));
      }
    }

    // Deliver in native peer form, resuming an unloaded thread if needed.
    // A resumed thread has lost its dynamic tools (thread/resume cannot
    // re-declare them) — re-send instructions that say so.
    try {
      await injectPeerMessage(conv.threadId, msg.fromName, msg.text);
    } catch {
      try {
        await host.request("thread/resume", {
          threadId: conv.threadId,
          developerInstructions: PEER_RESUME_INSTRUCTIONS,
        });
        await injectPeerMessage(conv.threadId, msg.fromName, msg.text);
      } catch (e) {
        // Thread unrecoverable (deleted?) — start fresh and redeliver.
        host.log(`peer: thread ${conv.threadId} unrecoverable (${e instanceof Error ? e.message : String(e)}) — starting a new one`);
        threadConversations.delete(conv.threadId);
        retireThreadPeer(conv.threadId);
        const { threadId, shortId } = await startThread(msg.fromName);
        conv.threadId = threadId;
        conv.shortId = shortId;
        threadConversations.set(threadId, conv);
        createThreadPeer(threadId, shortId);
        saveConversations();
        await injectPeerMessage(threadId, msg.fromName, msg.text);
      }
    }

    // Mid-turn: the injection is read at the next sampling point — done.
    if (host.threadHasTurn(conv.threadId)) return;

    // Idle: wake the thread. The claim can race a CLI run's turn/start;
    // losing it just means the message waits for that turn's next sampling.
    if (!host.claimThread(conv.threadId, ownerFor(conv.threadId))) return;
    replyBuffers.set(conv.threadId, []);
    updateStatus("busy");
    try {
      await host.request("turn/start", {
        threadId: conv.threadId,
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
        try {
          process.kill(pid, 0);
          return true;
        } catch { /* dead */ }
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
    handleToolCall,
    hasLiveSessions,
    stop,
  };
}
