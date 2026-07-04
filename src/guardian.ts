// src/guardian.ts — Guardian denial persistence and override-event mapping
//
// Guardian (`--approval auto`) denies actions autonomously. The app-server
// exposes `thread/approveGuardianDeniedAction` to override a denial: it takes
// the serialized core `GuardianAssessmentEvent` back and injects a developer
// message ("The user has manually approved a specific action...") into the
// thread without starting a turn — the agent retries on its next turn, and
// Guardian keeps that message in its review transcript so the retry passes.
//
// The server does not look the event up in any history; it only checks
// `status == "denied"` and formats the message from `event.action`. So the
// client's job is to (1) persist each denial as it arrives and (2) map the
// camelCase v2 notification shape back to the snake_case core event shape.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { AutoApprovalReviewParams, GuardianDenialRecord } from "./types";

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Persist a denied review's notification payload for later override.
 *  Returns the record path, or null if the payload has no usable reviewId
 *  (the protocol is [UNSTABLE]; degrade to log-only rather than crash). */
export function saveGuardianDenial(
  guardianDir: string,
  params: AutoApprovalReviewParams,
): string | null {
  const reviewId = typeof params.reviewId === "string" ? params.reviewId : null;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  if (!reviewId || !threadId || !/^[A-Za-z0-9._-]+$/.test(reviewId)) return null;
  const record: GuardianDenialRecord = {
    reviewId,
    threadId,
    receivedAt: new Date().toISOString(),
    notification: params,
  };
  mkdirSync(guardianDir, { recursive: true, mode: 0o700 });
  const path = join(guardianDir, `${reviewId}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/** All persisted denials in a workspace, newest first. Unreadable files are
 *  skipped (same tolerance as the run ledger). */
export function listGuardianDenials(guardianDir: string): GuardianDenialRecord[] {
  if (!existsSync(guardianDir)) return [];
  const records: GuardianDenialRecord[] = [];
  for (const name of readdirSync(guardianDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(guardianDir, name), "utf8"));
      if (typeof parsed?.reviewId === "string" && typeof parsed?.threadId === "string") {
        records.push(parsed as GuardianDenialRecord);
      }
    } catch {
      // Corrupt or partial file — skip.
    }
  }
  records.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  return records;
}

/** Resolve a (possibly prefixed) review ID against persisted denials.
 *  Throws on ambiguity, returns null when nothing matches. */
export function resolveGuardianDenial(
  guardianDir: string,
  idOrPrefix: string,
): GuardianDenialRecord | null {
  const matches = listGuardianDenials(guardianDir).filter(
    (r) => r.reviewId === idOrPrefix || r.reviewId.startsWith(idOrPrefix),
  );
  const exact = matches.find((r) => r.reviewId === idOrPrefix);
  if (exact) return exact;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous review ID prefix "${idOrPrefix}" matches: ${matches.map((r) => r.reviewId).join(", ")}`,
    );
  }
  return matches[0] ?? null;
}

/** Stamp a denial record as overridden so it drops out of the pending list. */
export function markGuardianDenialOverridden(guardianDir: string, reviewId: string): void {
  const path = join(guardianDir, `${reviewId}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as GuardianDenialRecord;
  record.overriddenAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Wire mapping: v2 notification (camelCase) → core GuardianAssessmentEvent
// (snake_case). Verified against codex-rs 0.142: the core struct has no
// serde rename_all, its enums are snake_case/lowercase, and the v2 schema
// camelCases both keys and enum values (e.g. "applyPatch", "unifiedExec",
// "socks5Tcp"). `permissions` (RequestPermissionProfile) is the core type
// embedded directly in the v2 schema — already snake_case, pass verbatim
// (it is deny_unknown_fields on the server, so do NOT transform it).
// ---------------------------------------------------------------------------

const ACTION_KEY_MAP: Record<string, string> = {
  toolName: "tool_name",
  connectorId: "connector_id",
  connectorName: "connector_name",
  toolTitle: "tool_title",
};

function camelToSnake(value: string): string {
  // serde snake_case splits on uppercase only: "socks5Tcp" → "socks5_tcp".
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Enum-valued action fields whose camelCase wire values must be converted
 *  (e.g. source "unifiedExec" → "unified_exec", protocol "socks5Tcp" →
 *  "socks5_tcp"). Data fields (command, cwd, argv, ...) pass through. */
const ACTION_ENUM_VALUE_KEYS = new Set(["type", "source", "protocol"]);

/** Map the notification's action payload to the core snake_case shape. */
export function mapGuardianAction(action: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    const mappedKey = ACTION_KEY_MAP[key] ?? key;
    out[mappedKey] =
      ACTION_ENUM_VALUE_KEYS.has(key) && typeof value === "string" ? camelToSnake(value) : value;
  }
  return out;
}

/** Build the `event` param for thread/approveGuardianDeniedAction from a
 *  persisted denial. Throws when the stored notification is missing the
 *  pieces the server requires (id, denied status, action). */
export function buildGuardianOverrideEvent(record: GuardianDenialRecord): Record<string, unknown> {
  const n = record.notification;
  const review = (n.review ?? {}) as Record<string, unknown>;
  // The dispatcher tolerates enum-shaped values like { type: "denied" }
  // (UNSTABLE protocol); accept the same shapes here so any denial it
  // persisted can actually be overridden.
  const rawStatus = review.status;
  const status =
    typeof rawStatus === "string"
      ? rawStatus
      : rawStatus !== null && typeof rawStatus === "object" &&
          typeof (rawStatus as { type?: unknown }).type === "string"
        ? (rawStatus as { type: string }).type
        : null;
  if (status !== "denied") {
    throw new Error(`Review ${record.reviewId} is not a denial (status: ${status ?? "unknown"})`);
  }
  const action = n.action;
  if (action === null || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
    throw new Error(`Review ${record.reviewId} has no action payload to approve`);
  }

  const event: Record<string, unknown> = {
    id: record.reviewId,
    turn_id: typeof n.turnId === "string" ? n.turnId : "",
    status: "denied",
    action: mapGuardianAction(action as Record<string, unknown>),
  };
  if (typeof n.targetItemId === "string") event.target_item_id = n.targetItemId;
  if (typeof n.startedAtMs === "number") event.started_at_ms = n.startedAtMs;
  if (typeof n.completedAtMs === "number") event.completed_at_ms = n.completedAtMs;
  if (typeof review.riskLevel === "string") event.risk_level = review.riskLevel;
  if (typeof review.userAuthorization === "string") event.user_authorization = review.userAuthorization;
  if (typeof review.rationale === "string") event.rationale = review.rationale;
  if (typeof n.decisionSource === "string") event.decision_source = camelToSnake(n.decisionSource);
  return event;
}

/** One-line summary of a denied action for listings and progress lines. */
export function describeGuardianAction(record: GuardianDenialRecord): string {
  const action = (record.notification.action ?? {}) as Record<string, unknown>;
  const type = typeof action.type === "string" ? action.type : "action";
  switch (type) {
    case "command":
      return `command: ${action.command}`;
    case "execve":
      return `execve: ${[action.program, ...((action.argv as string[]) ?? [])].join(" ")}`;
    case "applyPatch":
      return `patch: ${((action.files as string[]) ?? []).join(", ")}`;
    case "networkAccess":
      return `network: ${action.host}:${action.port}`;
    case "mcpToolCall":
      return `mcp tool: ${action.server}/${action.toolName}`;
    case "requestPermissions":
      return `permissions request${action.reason ? `: ${action.reason}` : ""}`;
    default:
      return type;
  }
}
