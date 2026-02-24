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

export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: string | null;
  config?: Record<string, unknown>;
  experimentalRawEvents: boolean;
  persistExtendedHistory: boolean;
}

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

export interface ThreadResumeParams {
  threadId: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: string | null;
  config?: Record<string, unknown>;
  persistExtendedHistory: boolean;
}

export type ThreadResumeResponse = ThreadStartResponse;

export interface ThreadListParams {
  cursor?: string;
  limit?: number;
  sortKey?: "created_at" | "updated_at";
  sourceKinds?: string[];
  archived?: boolean;
  cwd?: string;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface ThreadReadResponse {
  thread: Thread;
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

export interface TurnError {
  message: string;
  codexErrorInfo?: CodexErrorInfo | null;
  additionalDetails?: string | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// --- Items ---

export type ThreadItem =
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
  | ContextCompactionItem
  | GenericItem;

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

// --- Model list ---

export interface ModelListParams {
  limit?: number;
  cursor?: string;
  includeHidden?: boolean;
}

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

export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

// --- Turn result (our own type, not protocol) ---

export interface FileChange {
  path: string;
  kind: string;
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

// --- Short ID mapping ---

export interface ThreadMappingEntry {
  threadId: string;
  createdAt: string;
  model?: string;
  cwd?: string;
  lastStatus?: "running" | "completed" | "failed" | "interrupted" | "killed";
  updatedAt?: string;
}

export interface ThreadMapping {
  [shortId: string]: ThreadMappingEntry;
}
