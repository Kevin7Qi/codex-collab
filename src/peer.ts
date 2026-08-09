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
import { execFileSync } from "node:child_process";
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
  /** True when a turn is running (or starting) on the thread. */
  threadHasTurn(threadId: string): boolean;
  log(line: string): void;
}

interface Conversation {
  threadId: string;
  /** Reply socket path (the sender's own messaging socket). */
  replyPath: string;
  /** Sender's display name, for attribution inside Codex's context. */
  fromName: string;
}

interface PendingConsult {
  threadId: string;
  senderKey: string;
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
  // from-name out of the attribute blob, not by position.
  const fromName = (m && /\bfrom-name="([^"]*)"/.exec(m[1])?.[1]) || "claude";
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
  /** threadId → accumulated reply text for a peer-initiated turn. */
  const replyBuffers = new Map<string, string[]>();
  /** threadId → pending consult awaiting the sender's next message. */
  const pendingConsults = new Map<string, PendingConsult>();
  /** Bounded msg_id dedupe (Claude Code retries identical sends). */
  const seenMsgIds = new Set<string>();

  let server: net.Server | null = null;
  let active = false;
  let stopped = false;

  // ── Persistence (best-effort; a lost map only means a fresh thread) ──

  function loadConversations(): void {
    try {
      const parsed = JSON.parse(readFileSync(conversationsPath, "utf-8"));
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (typeof c?.threadId === "string" && typeof c?.replyPath === "string") {
            const conv: Conversation = {
              threadId: c.threadId,
              replyPath: c.replyPath,
              fromName: typeof c.fromName === "string" ? c.fromName : "claude",
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

  function deliverTo(replyPath: string, text: string): void {
    const line = buildEnvelope({ text, ourSocketPath: socketPath, ourName: name });
    const sock = net.connect({ path: replyPath }, () => {
      sock.write(line);
      sock.end();
    });
    sock.on("error", (e) => {
      host.log(`peer: could not deliver to ${replyPath}: ${e.message}`);
    });
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
        } else if (method === "turn/completed" || method === "turn/failed") {
          const texts = replyBuffers.get(threadId);
          replyBuffers.delete(threadId);
          updateStatus("idle");
          const conv = threadConversations.get(threadId);
          if (!conv) return;
          const reply = (texts ?? []).join("\n\n").trim();
          if (reply) {
            deliverTo(conv.replyPath, reply);
          } else if (method === "turn/failed") {
            const err = (params?.error as { message?: string } | undefined)?.message;
            deliverTo(conv.replyPath, `[codex-collab] The turn failed before producing a reply${err ? `: ${err}` : "."}`);
          }
        }
      },
    };
  }

  // ── Thread bootstrap ──

  async function startThread(): Promise<string> {
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
    const result = await host.request("thread/start", params) as { thread: { id: string } };
    const threadId = result.thread.id;
    // Keep peer threads out of Codex's memory consolidation, like every
    // thread codex-collab creates. Non-fatal.
    try {
      await host.request("thread/memoryMode/set", { threadId, mode: "disabled" });
    } catch { /* older codex */ }
    return threadId;
  }

  /** Minimal user-defaults read (model/sandbox). commands/shared.ts owns the
   *  full loader, but the broker process should not import the CLI layer —
   *  and a broken config file must degrade, not die, in a daemon. */
  function readUserConfig(): { model?: string; sandbox?: string } {
    try {
      const parsed = JSON.parse(readFileSync(join(homedir(), ".codex-collab", "config.json"), "utf-8"));
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

  async function handleInbound(msg: InboundMessage): Promise<void> {
    if (seenMsgIds.has(msg.msgId)) return;
    seenMsgIds.add(msg.msgId);
    if (seenMsgIds.size > 500) {
      for (const id of [...seenMsgIds].slice(0, 250)) seenMsgIds.delete(id);
    }

    let conv = conversations.get(msg.replyPath);

    // A pending consult on this conversation's thread consumes the message
    // as its answer — that is the whole correlation rule: the reply address
    // binds the thread, and one consult per (thread, sender) is in flight.
    if (conv) {
      const pending = pendingConsults.get(conv.threadId);
      if (pending && pending.senderKey === msg.replyPath) {
        pendingConsults.delete(conv.threadId);
        clearTimeout(pending.timer);
        pending.resolve(msg.text);
        return;
      }
    }

    // Ensure a thread for this conversation.
    if (!conv) {
      const threadId = await startThread();
      conv = { threadId, replyPath: msg.replyPath, fromName: msg.fromName };
      conversations.set(msg.replyPath, conv);
      threadConversations.set(threadId, conv);
      saveConversations();
      host.log(`peer: new conversation with ${msg.fromName} → thread ${threadId}`);
    } else if (msg.fromName && conv.fromName !== msg.fromName) {
      conv.fromName = msg.fromName;
      saveConversations();
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
        const threadId = await startThread();
        conv.threadId = threadId;
        threadConversations.set(threadId, conv);
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
      replyBuffers.delete(conv.threadId);
      updateStatus("idle");
      host.log(`peer: turn/start failed for ${conv.threadId}: ${e instanceof Error ? e.message : String(e)}`);
      deliverTo(conv.replyPath, `[codex-collab] Could not start a turn: ${e instanceof Error ? e.message : String(e)}`);
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
    );

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingConsults.delete(threadId);
        resolve(null);
      }, CONSULT_TIMEOUT_MS);
      timer.unref?.();
      pendingConsults.set(threadId, { threadId, senderKey: conv.replyPath, resolve, timer });
    });

    return answer === null
      ? failOpen("No answer arrived in time — proceed on your own best judgment.")
      : failOpen(answer);
  }

  // ── Liveness scan ──

  function hasLiveSessions(): boolean {
    try {
      for (const file of readdirSync(sessionsDir())) {
        if (!file.endsWith(".json") || file === `${process.pid}.json`) continue;
        const pid = Number(file.slice(0, -".json".length));
        if (!Number.isInteger(pid) || pid <= 0) continue;
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
      server = net.createServer((sock) => {
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
            handleInbound(msg).catch((e) => {
              host.log(`peer: inbound handling failed: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
        });
        sock.on("error", () => { /* sender hangups are routine */ });
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
    for (const [threadId, pending] of pendingConsults) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      pendingConsults.delete(threadId);
    }
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
