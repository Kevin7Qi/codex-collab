// src/types.ts — Protocol types for Codex app server (JSON-RPC over stdio)

import type { ApprovalPolicy, SandboxMode, ReasoningEffort } from "./config";

// --- JSON-RPC primitives ---

export type RequestId = string | number;

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: RequestId;
  result: unknown;
}

export interface JsonRpcError {
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcError;

// --- Initialize ---

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
}

// --- Threads ---

export type { ApprovalPolicy, SandboxMode, ReasoningEffort } from "./config";

/** Where the app-server routes approval requests for review. "auto_review"
 *  is the Guardian subagent: it approves or DENIES autonomously — it does
 *  not escalate to the client. Denials surface via the `guardianWarning`
 *  notification and can be overridden with thread/approveGuardianDeniedAction.
 *  Accepted on thread/start, thread/fork, thread/resume, and turn/start —
 *  no experimentalApi needed. */
export type ApprovalsReviewer = "user" | "auto_review";

export interface Thread {
  id: string;
  preview: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  // status is only populated on thread/read, not on thread/list
  status?: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: string;
  name?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  gitInfo: { sha: string | null; branch: string | null; originUrl: string | null } | null;
  turns: Turn[];
}

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "active"; activeFlags: string[] }
  | { type: "systemError" };

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: unknown;
  reasoningEffort?: string;
}

export interface ThreadForkParams {
  threadId: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: string | null;
  config?: Record<string, unknown>;
  ephemeral?: boolean;
}

// --- Turns ---

export interface UserInput {
  type: "text";
  text: string;
  text_elements?: unknown[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  sandboxPolicy?: unknown;
  model?: string;
  effort?: ReasoningEffort;
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  status: "inProgress" | "completed" | "interrupted" | "failed";
  error: TurnError | null;
}

export type CodexErrorInfo =
  | "contextWindowExceeded" | "usageLimitExceeded" | "serverOverloaded"
  | { httpConnectionFailed: { httpStatusCode: number | null } }
  | { responseStreamConnectionFailed: { httpStatusCode: number | null } }
  | "internalServerError" | "unauthorized" | "badRequest"
  | "threadRollbackFailed" | "sandboxError"
  | { responseStreamDisconnected: { httpStatusCode: number | null } }
  | { responseTooManyFailedAttempts: { httpStatusCode: number | null } }
  | "other";

/** Error carrying a JSON-RPC error code for protocol-level error forwarding. */
export class RpcError extends Error {
  constructor(message: string, public readonly rpcCode: number) {
    super(message);
    this.name = "RpcError";
  }
}

/** Thrown when a turn does not complete within --timeout. Typed so the CLI
 *  exit path can map it to a distinct exit code (see EXIT_CODES). */
export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnTimeoutError";
  }
}

export interface TurnError {
  message: string;
  codexErrorInfo?: CodexErrorInfo | null;
  additionalDetails?: string | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

// --- Items ---

/** Known item types with proper discriminants. */
export type KnownThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | PlanItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | ImageViewItem
  | EnteredReviewModeItem
  | ExitedReviewModeItem
  | ContextCompactionItem;

/** Any item from the server — known types narrow via `type` discriminant. */
export type ThreadItem = KnownThreadItem | GenericItem;

const KNOWN_ITEM_TYPES = new Set([
  "userMessage", "agentMessage", "plan", "reasoning",
  "commandExecution", "fileChange", "mcpToolCall", "webSearch",
  "imageView", "enteredReviewMode", "exitedReviewMode", "contextCompaction",
]);

/** Narrow a ThreadItem to a known type, enabling discriminated union switches. */
export function isKnownItem(item: ThreadItem): item is KnownThreadItem {
  return KNOWN_ITEM_TYPES.has(item.type);
}

export interface UserMessageItem {
  type: "userMessage";
  id: string;
  content: UserInput[];
}

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
  phase?: string | null;
}

export interface PlanItem {
  type: "plan";
  id: string;
  text: string;
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
}

export interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  processId: string | null;
  commandActions: Array<CommandAction>;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

export type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

export interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: Array<{
    path: string;
    kind: { type: "add" } | { type: "delete" } | { type: "update"; move_path: string | null };
    diff: string;
  }>;
  status: "inProgress" | "completed" | "failed" | "declined";
}

export interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: string;
  arguments: unknown;
  result?: unknown;
  error?: unknown;
  durationMs?: number | null;
}

export interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
}

export interface EnteredReviewModeItem {
  type: "enteredReviewMode";
  id: string;
  review: string;
}

export interface ExitedReviewModeItem {
  type: "exitedReviewMode";
  id: string;
  review: string;
}

export interface ImageViewItem {
  type: "imageView";
  id: string;
  path: string;
}

export interface ContextCompactionItem {
  type: "contextCompaction";
  id: string;
}

export interface GenericItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

// --- Notifications ---

export interface ItemStartedParams {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface ItemCompletedParams {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface DeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnCompletedParams {
  threadId: string;
  turn: Turn;
}

export interface ErrorNotificationParams {
  error: {
    message: string;
    codexErrorInfo?: CodexErrorInfo | null;
    additionalDetails?: string | null;
  };
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

// --- Review ---

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export type ReviewDelivery = "inline" | "detached";

export interface ReviewStartParams {
  threadId: string;
  target: ReviewTarget;
  delivery?: ReviewDelivery;
}

export interface ReviewStartResponse {
  turn: Turn;
  reviewThreadId: string;
}

// --- Approval requests (server -> client) ---

export interface CommandApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: Array<CommandAction> | null;
  networkApprovalContext?: { host: string; protocol: string } | null;
}

export interface FileChangeApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  reason: string | null;
  grantRoot: string | null;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** item/autoApprovalReview/started|completed notification payloads (Guardian
 *  reviewing an approval request). Marked [UNSTABLE] in Codex 0.142 and
 *  "expected to change soon" — every field is optional and consumers must
 *  parse defensively, degrading to a generic progress line. */
export interface AutoApprovalReviewParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  /** Stable identifier for the review lifecycle — the handle
   *  thread/approveGuardianDeniedAction overrides are keyed by. */
  reviewId?: string;
  targetItemId?: string | null;
  startedAtMs?: number;
  completedAtMs?: number;
  decisionSource?: string;
  /** Verdict: { status, riskLevel, userAuthorization, rationale }. */
  review?: unknown;
  /** Reviewed action, tagged by `type` (command, execve, applyPatch,
   *  networkAccess, mcpToolCall, requestPermissions). */
  action?: unknown;
  [key: string]: unknown;
}

/** A Guardian denial captured from item/autoApprovalReview/completed and
 *  persisted under the workspace's guardian/ dir so the user can override
 *  it later with `approve --guardian <review-id>`. */
export interface GuardianDenialRecord {
  reviewId: string;
  threadId: string;
  receivedAt: string;
  /** Set once the override RPC has been sent; hides it from the pending list. */
  overriddenAt?: string;
  /** Raw notification payload (camelCase v2 wire shape). */
  notification: AutoApprovalReviewParams;
}

// --- Model list ---

export interface Model {
  id: string;
  model: string;
  upgrade: string | null;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  isDefault: boolean;
}

// --- Turn result (our own type, not protocol) ---

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string;
}

export interface CommandExec {
  command: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  output: string;
  filesChanged: FileChange[];
  commandsRun: CommandExec[];
  error?: string;
  durationMs: number;
}

// --- Thread index (local, per-workspace) ---

export interface ThreadIndexEntry {
  threadId: string;
  createdAt: string;
  updatedAt?: string;
  model?: string;
  cwd?: string;
  /** First-prompt excerpt shown in `threads` listings. */
  preview?: string;
  /** Denormalized latest-turn status for display; the run ledger is the
   *  authoritative per-invocation record. */
  lastStatus?: "running" | "completed" | "failed" | "interrupted";
}

export interface ThreadIndex {
  [shortId: string]: ThreadIndexEntry;
}

// --- Run ledger (local, per-workspace) ---

export type RunKind = "task" | "review";

export type RunPhase =
  | "starting" | "reviewing" | "editing" | "verifying"
  | "running" | "investigating" | "finalizing";

export type RunStatus = "running" | "completed" | "failed" | "interrupted";

/** A pending interactive approval attached to a run — the on-disk signal
 *  observers (follow, Monitor scripts) use to see a blocked run without
 *  owning its stdout. */
export interface PendingApproval {
  id: string;
  kind: "commandExecution" | "fileChange";
  /** Command text or file-change reason — whatever best describes the ask. */
  summary: string | null;
  requestedAt: string;
}

// --- Ask channel (Codex asks mid-turn, anyone answers) ---

/** On-disk shape of a mailbox question file (`{id}.json`). Written by
 *  `codex-collab ask` from INSIDE Codex's sandbox — which is why the mailbox
 *  lives in temp space (resolveMailboxDir), not the workspace state dir. */
export interface QuestionRecord {
  id: string;
  question: string;
  askedAt: string;
  expiresAt: string;
  workspaceDir: string;
  /** PID of the asking process (orphan detection for sweeps). */
  pid: number;
  /** Set when the deadline lapsed unanswered; the file is kept for the
   *  audit trail until `clean` sweeps it. */
  expired?: boolean;
}

/** A question awaiting an answer, mirrored onto the run record — the on-disk
 *  signal observers (`next`, `follow`, Monitor scripts) use to see a run
 *  asking for steering without owning its stdout. Unlike PendingApproval,
 *  this never blocks the run terminally: questions fail open. */
export interface PendingQuestion {
  id: string;
  summary: string | null;
  askedAt: string;
  expiresAt: string;
}

/** Terminal state of an ask-channel question, appended to the run record so
 *  a long autonomous run's post-mortem says plainly how often it was steered
 *  and how often it decided alone. */
export interface ResolvedQuestion {
  id: string;
  summary: string | null;
  outcome: "answered" | "expired";
  /** Posting-to-answer latency; absent for expired questions. */
  latencyMs?: number;
}

export interface RunRecord {
  runId: string;
  threadId: string;
  shortId: string;
  kind: RunKind;
  phase: RunPhase | null;
  status: RunStatus;
  /** PID of the runner process that owns this run. Liveness checks must be
   *  run-specific: the thread's PID file tracks only the LATEST runner, so a
   *  stale older record would read as alive through its successor's file.
   *  Absent on records written by older versions. */
  pid?: number | null;
  sessionId: string | null;
  logFile: string;
  logOffset: number;
  prompt: string | null;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  elapsed: string | null;
  output: string | null;
  filesChanged: FileChange[] | null;
  commandsRun: CommandExec[] | null;
  error: string | null;
  /** Set while an interactive approval is blocking the run; null/absent otherwise. */
  pendingApproval?: PendingApproval | null;
  /** Set while a `codex-collab ask` question awaits an answer; null/absent otherwise. */
  pendingQuestion?: PendingQuestion | null;
  /** Resolved ask-channel questions, in resolution order. */
  questions?: ResolvedQuestion[];
}

// --- Broker state (per-workspace) ---

export interface BrokerState {
  endpoint: string | null;
  pid: number | null;
  sessionDir: string;
  startedAt: string;
}

export interface SessionState {
  sessionId: string;
  startedAt: string;
}

export type BrokerEndpointKind = "unix" | "pipe";

export interface ParsedEndpoint {
  kind: BrokerEndpointKind;
  path: string;
}
