// src/config.ts — Configuration for codex-collab

import { homedir } from "os";
import { join, basename, resolve } from "path";
import { createHash } from "crypto";
import { realpathSync, existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import pkg from "../package.json";

function getHome(): string {
  const home = homedir();
  if (!home) throw new Error("Cannot determine home directory");
  return home;
}

// ─── Model aliases ──────────────────────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  spark: "gpt-5.3-codex-spark",
};

// ─── Effort levels ──────────────────────────────────────────────────────────

const VALID_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

// ─── Config object ──────────────────────────────────────────────────────────

export const config = {
  // Reasoning effort levels
  reasoningEfforts: VALID_EFFORTS,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Approval policies accepted by the Codex app server
  approvalPolicies: ["never", "on-request", "on-failure", "untrusted"] as const,
  defaultApprovalPolicy: "never" as const,

  // Timeouts
  defaultTimeout: 1200, // seconds — turn completion (20 min)
  requestTimeout: 30_000, // milliseconds — individual protocol requests (30s)
  defaultBrokerIdleTimeout: 30 * 60 * 1000, // 30 min in ms

  // Limits
  maxRunsPerWorkspace: 50,

  // Service identity
  serviceName: "codex-collab" as const,

  // Data paths — lazy via getters so the home directory is validated at point of use, not import time.
  // Lazily created by getWorkspacePaths() on first access.
  get dataDir() { return join(getHome(), ".codex-collab"); },

  /** @deprecated Will be removed when threads module is refactored to use per-workspace state. */
  get threadsFile() { return join(this.dataDir, "threads.json"); },
  /** @deprecated Will be removed when events module is refactored to use per-workspace state. */
  get logsDir() { return join(this.dataDir, "logs"); },
  /** @deprecated Will be removed when approvals module is refactored to use per-workspace state. */
  get approvalsDir() { return join(this.dataDir, "approvals"); },
  /** @deprecated Will be removed when turns module is refactored to use per-workspace state. */
  get killSignalsDir() { return join(this.dataDir, "kill-signals"); },
  /** @deprecated Will be removed when cli module is refactored to use per-workspace state. */
  get pidsDir() { return join(this.dataDir, "pids"); },

  get configFile() { return join(this.dataDir, "config.json"); },

  // Display
  threadsListLimit: 20,

  // Client identity (sent during initialize handshake)
  clientName: "codex-collab",
  clientVersion: pkg.version,
};

Object.freeze(config);

export type ReasoningEffort = (typeof config.reasoningEfforts)[number];
export type SandboxMode = (typeof config.sandboxModes)[number];
export type ApprovalPolicy = (typeof config.approvalPolicies)[number];

// ─── Pure utility functions ─────────────────────────────────────────────────

/** Validate that an ID contains only safe characters for file paths. */
export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ID: "${id}"`);
  }
  return id;
}

/**
 * Find workspace root by running `git rev-parse --show-toplevel`.
 * If not in a git repo, returns the resolved (realpath) cwd.
 */
export function resolveWorkspaceDir(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return resolve(cwd);
}

/**
 * Compute per-workspace state directory:
 * `~/.codex-collab/workspaces/{slug}-{hash}/`
 *
 * - slug: sanitized lowercase basename of the workspace root
 * - hash: first 16 chars of SHA-256 of the canonical (realpath) path
 */
export function resolveStateDir(cwd: string): string {
  const wsRoot = resolveWorkspaceDir(cwd);
  const canonical = realpathSync(wsRoot);
  const slug = basename(canonical).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return join(getHome(), ".codex-collab", "workspaces", `${slug}-${hash}`);
}

/**
 * Resolve model aliases. Currently: `spark → gpt-5.3-codex-spark`.
 * Passes through unknown names. Returns undefined for undefined input.
 */
export function resolveModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  return MODEL_ALIASES[model] ?? model;
}

/**
 * Validate reasoning effort against known levels.
 * Throws on invalid. Returns undefined for undefined input.
 */
export function validateEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (effort === undefined) return undefined;
  if (!(VALID_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `Invalid effort level "${effort}". Valid levels: ${VALID_EFFORTS.join(", ")}`,
    );
  }
  return effort as ReasoningEffort;
}

/**
 * Read a `.md` template file from the prompts directory.
 * Default prompts dir is `src/prompts/` relative to this file.
 */
export function loadTemplate(name: string, promptsDir?: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid template name: "${name}"`);
  }
  const dir = promptsDir ?? join(import.meta.dir, "prompts");
  const filePath = join(dir, `${name}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Template not found: ${filePath}`);
  }
  return readFileSync(filePath, "utf-8");
}

/**
 * Replace `{{VAR}}` placeholders in a template string.
 * Unknown variables are left as-is.
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? vars[key] : match;
  });
}
