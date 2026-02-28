// src/config.ts — Configuration for codex-collab

import pkg from "../package.json";

function getHome(): string {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME environment variable is not set");
  return home;
}

export const config = {
  // Default model
  model: "gpt-5.3-codex",

  // Reasoning effort levels
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: "xhigh" as const,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Approval policies accepted by the Codex app server
  approvalPolicies: ["never", "on-request", "on-failure", "untrusted"] as const,
  defaultApprovalPolicy: "never" as const,

  // Timeouts
  defaultTimeout: 1200, // seconds — turn completion (20 min)
  requestTimeout: 30_000, // milliseconds — individual protocol requests (30s)

  // Data paths — lazy via getters so HOME is validated at point of use, not import time.
  // Validated by ensureDataDirs() in cli.ts before any file operations.
  get dataDir() { return `${getHome()}/.codex-collab`; },
  get threadsFile() { return `${this.dataDir}/threads.json`; },
  get logsDir() { return `${this.dataDir}/logs`; },
  get approvalsDir() { return `${this.dataDir}/approvals`; },

  // Display
  jobsListLimit: 20,

  // Client identity (sent during initialize handshake)
  clientName: "codex-collab",
  clientVersion: pkg.version,
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
