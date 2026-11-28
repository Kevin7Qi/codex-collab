// src/claude-envelope.ts — the envelope of Claude Code's cross-session messages
//
// One JSON line per message on a session's messaging socket, the text wrapped
// in `<cross-session-message>`. Parsed and built here for both directions.

import { randomUUID } from "node:crypto";


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
