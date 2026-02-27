// src/config.ts — Configuration for codex-collab

const home = process.env.HOME ?? "";

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
  defaultTimeout: 1200, // seconds — turn completion (20 min)
  requestTimeout: 30_000, // milliseconds — individual protocol requests (30s)

  // Data paths (require HOME; validated by ensureDataDirs in cli.ts)
  dataDir: `${home}/.codex-collab`,
  threadsFile: `${home}/.codex-collab/threads.json`,
  logsDir: `${home}/.codex-collab/logs`,
  approvalsDir: `${home}/.codex-collab/approvals`,

  // Display
  jobsListLimit: 20,

  // Client identity (sent during initialize handshake)
  clientName: "codex-collab",
  clientVersion: "1.0.0",
};

Object.freeze(config);

export type ReasoningEffort = (typeof config.reasoningEfforts)[number];
export type SandboxMode = (typeof config.sandboxModes)[number];
export type ApprovalPolicy = (typeof config.approvalPolicies)[number];

/** Validate that an ID contains only safe characters for file paths. */
export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ID: "${id}"`);
  }
  return id;
}
