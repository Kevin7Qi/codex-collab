// src/shared-server.ts — attach to Codex's own app-server instead of spawning one
//
// Codex runs a shared, multi-client app-server behind a control socket:
// `codex app-server daemon start` binds it, the TUI attaches to it when it
// exists, and the Codex desktop app both starts and uses it on every host it
// reaches over SSH. Everything that connects to that socket shares one
// server: threads started by any client render live in every other client,
// and there is one writer per thread, so Codex's single-writer lock never
// contends. This module is codex-collab's client for that socket.
//
// The socket speaks WebSocket (an HTTP upgrade, then RFC 6455 frames) with
// one JSON-RPC message per text frame. Bun's own WebSocket cannot dial a
// unix socket, so the framing is done here, over node:net — small enough
// that a dependency would cost more than it saves.
//
// Direction of dependence is fixed: codex-collab joins Codex's server, never
// the reverse. When no socket answers, `connectAppServer` falls back to the
// private `codex app-server` child that `connectDirect` has always spawned.

import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "./config";
import { createRpcEndpoint, NO_RESPONSE } from "./rpc";
import { connectDirectWithRetry, type AppServerClient, type ConnectOptions } from "./client";
import type { InitializeParams, InitializeResponse } from "./types";

/** How a connection reaches the app-server. Reported by `health` and by the
 *  broker's handshake, so a user can always tell whether Codex's own server
 *  or a private child is running their turns. */
export interface ServerInfo {
  kind: "shared" | "private";
  /** Control socket path (shared). */
  socketPath?: string;
  /** Child process id (private). */
  pid?: number;
}

/** `config server`: attach to the shared server when its socket answers
 *  (`auto`), insist on it (`shared`), or never try (`private`). */
export type ServerPreference = "auto" | "shared" | "private";
export const SERVER_PREFERENCES: readonly ServerPreference[] = ["auto", "shared", "private"] as const;

/** The socket `codex app-server daemon` binds and `codex app-server proxy`
 *  bridges to: `$CODEX_HOME/app-server-control/app-server-control.sock`.
 *  `CODEX_COLLAB_SERVER_SOCKET` points somewhere else — a private socket
 *  server for tests, or a non-default daemon. */
export function controlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_COLLAB_SERVER_SOCKET?.trim();
  if (override) return resolve(override);
  const home = resolve(env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"));
  return join(home, "app-server-control", "app-server-control.sock");
}

/** The preference in force: the environment first (`CODEX_COLLAB_SERVER`),
 *  then `config server`, else `auto`. Read directly from the config file
 *  rather than through the CLI's loader: the broker uses this too, and a
 *  broken config file must degrade in a daemon, not die. */
export function serverPreference(
  env: NodeJS.ProcessEnv = process.env,
  configFile: string = config.configFile,
): { preference: ServerPreference; reason: string } {
  const fromEnv = env.CODEX_COLLAB_SERVER?.trim();
  if (fromEnv && (SERVER_PREFERENCES as readonly string[]).includes(fromEnv)) {
    return { preference: fromEnv as ServerPreference, reason: `CODEX_COLLAB_SERVER=${fromEnv}` };
  }
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf-8"));
    const configured = parsed?.server;
    if (typeof configured === "string" && (SERVER_PREFERENCES as readonly string[]).includes(configured)) {
      return { preference: configured as ServerPreference, reason: `config server ${configured}` };
    }
  } catch { /* no config, or unreadable — the default applies */ }
  return { preference: "auto", reason: "default" };
}

/** Attaching needs AF_UNIX from node:net, which Windows does not offer. */
export function attachSupported(platform: string = process.platform): boolean {
  return platform !== "win32";
}

export interface SharedConnectOptions {
  socketPath: string;
  /** Request timeout in ms. Defaults to config.requestTimeout. */
  requestTimeout?: number;
  /** Connect + upgrade + handshake deadline. */
  connectTimeout?: number;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** One client-to-server frame: FIN set, masked (the RFC requires it). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

export interface Frame { fin: boolean; opcode: number; payload: Buffer }

/** Parse as many complete frames as `buf` holds. Returns them and the
 *  unconsumed remainder. Server frames arrive unmasked; a masked one is
 *  still decoded, since decoding is cheap and refusing is not useful. */
/** Decode the complete frames at the head of `buf`. `rest` is the
 *  incomplete tail, and `need` how many bytes in all the frame it begins
 *  takes (0 when unknown, or nothing is pending): a reader can then
 *  collect input until that much has arrived instead of re-parsing on
 *  every chunk. */
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer; need: number } {
  const frames: Frame[] = [];
  let offset = 0;
  let need = 0;
  for (;;) {
    if (buf.length - offset < 2) { need = buf.length - offset > 0 ? 2 : 0; break; }
    const fin = (buf[offset] & 0x80) !== 0;
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buf.length - pos < 2) { need = 4; break; }
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) { need = 10; break; }
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame too large");
      len = Number(big);
      pos += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length - pos < 4) { need = pos - offset + 4; break; }
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length - pos < len) { need = pos - offset + len; break; }
    let payload = buf.subarray(pos, pos + len);
    if (mask) {
      const m = mask;
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ m[i & 3];
      payload = unmasked;
    }
    frames.push({ fin, opcode, payload });
    offset = pos + len;
  }
  return { frames, rest: buf.subarray(offset), need };
}

/** The Sec-WebSocket-Accept value a compliant server returns for `key`. */
export function acceptKeyFor(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

/**
 * Connect to a shared app-server over its control socket, perform the
 * WebSocket upgrade and the JSON-RPC initialize handshake, and return an
 * AppServerClient. Rejects when nothing listens, the upgrade is refused, or
 * the handshake does not complete within `connectTimeout`.
 */
export async function connectShared(opts: SharedConnectOptions): Promise<AppServerClient> {
  const requestTimeout = opts.requestTimeout ?? config.requestTimeout;
  const connectTimeout = opts.connectTimeout ?? 5000;
  const socket = new net.Socket();
  let upgraded = false;
  let gone = false;
  let goneReason: string | null = null;
  // Input not yet decoded: the incomplete frame's head, plus the chunks
  // that followed it, joined only once the frame can be complete — a
  // large frame arrives in many chunks, and joining on each is quadratic.
  let inbound: Buffer = Buffer.alloc(0);
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let needBytes = 0;
  let fragments: Buffer[] = [];
  let fragmentOpcode = OP_TEXT;

  const endpoint = createRpcEndpoint({
    label: "codex",
    requestTimeout,
    send: (data) => {
      if (gone || socket.destroyed) throw new Error("socket is closed");
      socket.write(encodeFrame(OP_TEXT, Buffer.from(data.endsWith("\n") ? data.slice(0, -1) : data)));
    },
    downReason: () => goneReason,
    overflowReason: "App server response buffer exceeded maximum size",
    onOverflow: () => socket.destroy(),
    writeFailedPrefix: "App server socket write failed: ",
  });

  const key = randomBytes(16).toString("base64");
  const expectedAccept = acceptKeyFor(key);

  /** The upgrade response is parsed by hand; everything after it is frames. */
  const awaitUpgrade = new Promise<void>((resolveUpgrade, rejectUpgrade) => {
    const onData = (chunk: Buffer): void => {
      inbound = Buffer.concat([inbound, chunk]);
      const end = inbound.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = inbound.subarray(0, end).toString("utf8");
      inbound = inbound.subarray(end + 4);
      socket.off("data", onData);
      const status = head.split("\r\n")[0] ?? "";
      const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
      if (!/ 101 /.test(status)) {
        rejectUpgrade(new Error(`WebSocket upgrade refused: ${status || "(no status line)"}`));
        return;
      }
      if (accept !== expectedAccept) {
        rejectUpgrade(new Error("WebSocket upgrade returned a bad Sec-WebSocket-Accept"));
        return;
      }
      upgraded = true;
      socket.on("data", onFrames);
      resolveUpgrade();
      if (inbound.length > 0) onFrames(Buffer.alloc(0));
    };
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write(
        `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  });

  function onFrames(chunk: Buffer): void {
    if (chunk.length > 0) {
      pendingChunks.push(chunk);
      pendingBytes += chunk.length;
    }
    if (needBytes > 0 && inbound.length + pendingBytes < needBytes) return; // the frame cannot be complete yet
    inbound = Buffer.concat([inbound, ...pendingChunks]);
    pendingChunks = [];
    pendingBytes = 0;
    let parsed: { frames: Frame[]; rest: Buffer; need: number };
    try {
      parsed = decodeFrames(inbound);
    } catch (e) {
      socket.destroy(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    inbound = parsed.rest;
    needBytes = parsed.need;
    for (const frame of parsed.frames) {
      switch (frame.opcode) {
        case OP_PING:
          if (!socket.destroyed) socket.write(encodeFrame(OP_PONG, frame.payload));
          break;
        case OP_PONG:
          break;
        case OP_CLOSE:
          // Server-initiated close: acknowledge, then let 'close' settle state.
          if (!socket.destroyed) {
            try { socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* racing teardown */ }
            socket.end();
          }
          break;
        case OP_TEXT:
        case OP_BINARY:
        case OP_CONTINUATION: {
          if (frame.opcode !== OP_CONTINUATION) {
            fragments = [];
            fragmentOpcode = frame.opcode;
          }
          fragments.push(frame.payload);
          if (!frame.fin) break;
          const message = Buffer.concat(fragments);
          fragments = [];
          if (fragmentOpcode === OP_TEXT) {
            // One JSON-RPC message per frame; the endpoint's line parser
            // wants a terminator, and tolerates one that is already there.
            const text = message.toString("utf8");
            endpoint.feed(text.endsWith("\n") ? text : text + "\n");
          }
          break;
        }
        default:
          break; // reserved opcodes: ignore
      }
    }
  }

  function settleGone(reason: string): void {
    if (gone) return;
    gone = true;
    goneReason = reason;
    endpoint.fail(reason);
  }

  socket.on("close", () => settleGone("App server connection closed"));
  // Bun emits no "close" of its own after the peer ends the connection: the
  // half-closed socket would sit there, its requests waiting on their own
  // timeouts. Treat the peer's end as the end.
  socket.on("end", () => {
    settleGone("App server connection closed by the server");
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("error", (err) => {
    if (!upgraded) return; // surfaced through the connect/upgrade rejection
    settleGone(`App server socket error: ${err.message}`);
  });

  // Connect + upgrade + handshake, bounded together: a socket that
  // upgrades but never answers `initialize` must fail within the same
  // deadline, or the caller's own readiness budget goes on waiting for a
  // server that is not there (and `auto` never falls back).
  const connectDeadline = Date.now() + connectTimeout;
  await new Promise<void>((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new Error(`Timed out connecting to the app-server at ${opts.socketPath}`));
    }, connectTimeout);
    const fail = (e: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      rejectConnect(e);
    };
    socket.once("error", (err) => { if (!upgraded) fail(new Error(`Could not connect to the app-server at ${opts.socketPath}: ${err.message}`)); });
    // A socket that accepts and hangs up before any answer must not burn
    // the whole deadline: `auto` has a private server to fall back to.
    const hungUp = (): void => { if (!upgraded) fail(new Error(`The app-server at ${opts.socketPath} closed the connection before the WebSocket upgrade`)); };
    socket.once("end", hungUp);
    socket.once("close", hungUp);
    awaitUpgrade.then(() => { clearTimeout(timer); resolveConnect(); }, fail);
    socket.connect({ path: opts.socketPath });
  });

  async function close(): Promise<void> {
    if (endpoint.isClosed()) return;
    endpoint.markClosed();
    if (!socket.destroyed) {
      try { socket.write(encodeFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* already down */ }
      socket.end();
    }
    await new Promise<void>((resolveClose) => {
      const timer = setTimeout(() => { socket.destroy(); resolveClose(); }, 1000);
      const done = (): void => { clearTimeout(timer); resolveClose(); };
      if (socket.destroyed) { done(); return; }
      socket.once("close", done);
    });
  }

  // A shared server sends every client subscribed to a thread that thread's
  // requests — and re-sends the pending ones to a client that rejoins — and
  // the first reply settles them. Until something here has a turn of its
  // own and registers handlers for it, the only correct answer is none:
  // "method not found" would be taken as a decline of someone else's
  // approval or question.
  endpoint.onAnyRequest(() => NO_RESPONSE);

  const initParams: InitializeParams = {
    clientInfo: { name: config.clientName, title: null, version: config.clientVersion },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ["item/reasoning/textDelta"],
    },
  };
  let initResult: InitializeResponse;
  try {
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    const handshakeDeadline = new Promise<never>((_resolve, reject) => {
      handshakeTimer = setTimeout(
        () => reject(new Error(`Timed out initializing the app-server at ${opts.socketPath}`)),
        Math.max(50, connectDeadline - Date.now()),
      );
    });
    try {
      initResult = await Promise.race([endpoint.request<InitializeResponse>("initialize", initParams), handshakeDeadline]);
    } finally {
      if (handshakeTimer) clearTimeout(handshakeTimer);
    }
    endpoint.notify("initialized");
  } catch (e) {
    await close();
    throw e;
  }

  return {
    request: endpoint.request,
    notify: endpoint.notify,
    on: endpoint.on,
    onAny: endpoint.onAny,
    onRequest: endpoint.onRequest,
    onAnyRequest: endpoint.onAnyRequest,
    respond: endpoint.respond,
    onClose: endpoint.onClose,
    close,
    userAgent: initResult.userAgent,
    brokerBusy: false,
    isBrokered: false,
    server: { kind: "shared", socketPath: opts.socketPath },
  };
}

/** Wording for the failure to attach when the user insisted on it. */
function attachRequiredError(socketPath: string, detail: string | null): Error {
  return new Error(
    (detail
      ? `Could not attach to the Codex app-server at ${socketPath}: ${detail}`
      : `No Codex app-server is listening at ${socketPath}.`) +
    `\nStart one with 'codex app-server daemon start', or let codex-collab run its own with 'codex-collab config server auto'.`,
  );
}

/**
 * The one way to get an app-server connection: attach to Codex's shared
 * server when the preference allows and its socket answers, else spawn a
 * private one. A caller that names a `command` is running a mock server
 * and always gets the private path.
 */
export async function connectAppServer(opts?: ConnectOptions, platform: string = process.platform): Promise<AppServerClient> {
  const { preference, reason } = serverPreference();
  // `shared` is an insistence, not a preference: where attaching cannot
  // work at all, say so rather than start the private server it ruled out.
  if (!opts?.command && preference === "shared" && !attachSupported(platform)) {
    throw new Error(
      `${reason} asks for Codex's shared app-server, which cannot be reached on Windows (its control socket is a unix socket). ` +
      `Use 'codex-collab config server auto' or 'private'.`,
    );
  }
  if (!opts?.command && preference !== "private" && attachSupported(platform)) {
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const socketPath = controlSocketPath(env);
    if (existsSync(socketPath)) {
      try {
        return await connectShared({ socketPath, requestTimeout: opts?.requestTimeout });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        if (preference === "shared") throw attachRequiredError(socketPath, detail);
        console.error(`[codex] Codex's app-server socket at ${socketPath} did not answer (${detail}) — starting a private app-server.`);
      }
    } else if (preference === "shared") {
      throw attachRequiredError(socketPath, null);
    }
  }
  return connectDirectWithRetry(opts);
}
