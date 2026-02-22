// src/config.ts — Configuration for codex-collab

const home = process.env.HOME || "/tmp";

export const config = {
  // Default model
  model: "gpt-5.3-codex",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: "xhigh" as const,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Approval policies (matches AskForApproval in protocol)
  approvalPolicies: ["never", "on-request", "on-failure", "untrusted"] as const,
  defaultApprovalPolicy: "never" as const,

  // Timeouts
  defaultTimeout: 900, // seconds — turn completion (15 min)
  requestTimeout: 30_000, // milliseconds — individual protocol requests (30s)

  // Data paths
  dataDir: `${home}/.codex-collab`,
  threadsFile: `${home}/.codex-collab/threads.json`,
  logsDir: `${home}/.codex-collab/logs`,
  approvalsDir: `${home}/.codex-collab/approvals`,

  // Display
  jobsListLimit: 20,

  // Client identity (sent during initialize handshake)
  clientName: "codex-collab",
  clientVersion: "2.0.0",
};

Object.freeze(config);

export type ReasoningEffort = (typeof config.reasoningEfforts)[number];
export type SandboxMode = (typeof config.sandboxModes)[number];
export type ApprovalPolicy = (typeof config.approvalPolicies)[number];
