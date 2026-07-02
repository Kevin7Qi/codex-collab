// src/config.ts — Configuration for codex-collab

import { homedir } from "os";
import { join, basename, resolve, sep } from "path";
import { createHash } from "crypto";
import { realpathSync, existsSync, readFileSync, readdirSync } from "fs";
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

// ─── Workspace state schema version ─────────────────────────────────────────
// Bumped whenever the on-disk shape of a workspace state dir
// ({stateDir}/threads.json, runs/*.json) changes in a way that needs migration.
// Persisted per-workspace in {stateDir}/migration-state.json so the legacy
// global→workspace migration runs once and subsequent commands skip it
// (avoids the synthetic-run churn against pruneRuns when the workspace has
// more migrated threads than maxRunsPerWorkspace).
export const STATE_SCHEMA_VERSION = 1;
export const MIGRATION_STATE_FILENAME = "migration-state.json";

/**
 * True iff `candidate` is the same path as `root` or lives inside `root`.
 * Caller should pass absolute paths; comparison is string-based using the
 * platform separator (so "/a/b" is NOT inside "/a/bb").
 */
export function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

// ─── Config object ──────────────────────────────────────────────────────────

export const config = {
  // Reasoning effort levels
  reasoningEfforts: VALID_EFFORTS,

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Approval policies accepted by the Codex app server
  approvalPolicies: ["never", "on-request", "on-failure", "untrusted"] as const,
  // CLI/config approval modes: server policies plus "auto", which maps to
  // approvalPolicy "on-request" reviewed by Codex's Guardian subagent
  // (approvalsReviewer "auto_review") with the interactive flow as the
  // escalation path.
  approvalModes: ["never", "on-request", "on-failure", "untrusted", "auto"] as const,
  defaultApprovalPolicy: "never" as const,

  // Timeouts
  defaultTimeout: 1200, // seconds — turn completion (20 min)
  requestTimeout: 30_000, // milliseconds — individual protocol requests (30s)
  // Broker idle timeout (ms) before a detached broker self-exits. Overridable
  // via CODEX_COLLAB_BROKER_IDLE_TIMEOUT_MS so tests can make brokers exit in
  // seconds instead of lingering for 30 min and orphaning across test runs.
  get defaultBrokerIdleTimeout(): number {
    const raw = process.env.CODEX_COLLAB_BROKER_IDLE_TIMEOUT_MS;
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 30 * 60 * 1000; // 30 min in ms
  },

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
export type ApprovalMode = (typeof config.approvalModes)[number];

// ─── Pure utility functions ─────────────────────────────────────────────────

/** Validate that an ID contains only safe characters for file paths. */
export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ID: "${id}"`);
  }
  return id;
}

// The workspace root for a given cwd is constant for a process's lifetime, but
// a single command resolves it several times (resolveStateDir, workspaceDirName,
// and the migration cwd-scope filter all call this on every invocation). Cache
// by cwd so the `git` subprocess spawns at most once per cwd instead of 2-3×.
const workspaceDirCache = new Map<string, string>();

/**
 * Find workspace root by running `git rev-parse --show-toplevel`.
 * If not in a git repo, returns the resolved (realpath) cwd.
 * Memoized per cwd — the result is stable within a process.
 */
export function resolveWorkspaceDir(cwd: string): string {
  const cached = workspaceDirCache.get(cwd);
  if (cached !== undefined) return cached;
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  });
  let wsRoot: string;
  if (result.status === 0 && result.stdout) {
    wsRoot = result.stdout.trim();
  } else {
    // Canonicalize like git does (it returns the physical path) so state-dir
    // hashing is stable across symlinked cwds — e.g. macOS's /var → /private/var.
    const resolved = resolve(cwd);
    try {
      wsRoot = realpathSync(resolved);
    } catch {
      wsRoot = resolved;
    }
  }
  workspaceDirCache.set(cwd, wsRoot);
  return wsRoot;
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
  let canonical: string;
  try {
    canonical = realpathSync(wsRoot);
  } catch {
    canonical = resolve(wsRoot);
  }
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

// ─── Template metadata ─────────────────────────────────────────────────────

export interface TemplateMeta {
  name: string;
  description: string;
  sandbox?: string;
}

/**
 * Parse YAML frontmatter from a template string.
 * Returns the metadata fields and the body (content after frontmatter).
 */
export function parseTemplateFrontmatter(raw: string): { meta: TemplateMeta; body: string } {
  // Normalize CRLF to LF so Windows-edited templates parse correctly
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { meta: { name: "", description: "" }, body: normalized };
  }
  const endIdx = lines.indexOf("---", 1);
  if (endIdx === -1) {
    return { meta: { name: "", description: "" }, body: normalized };
  }

  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const match = lines[i].match(/^(\w+)\s*:\s*(.+)$/);
    if (match) meta[match[1]] = match[2].trim();
  }

  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");
  return {
    meta: {
      name: meta.name ?? "",
      description: meta.description ?? "",
      sandbox: meta.sandbox,
    },
    body,
  };
}

/**
 * Read a `.md` template file and return its body (frontmatter stripped).
 * Checks user templates dir first (`~/.codex-collab/templates/`),
 * then falls back to built-in templates (relative to this file).
 *
 * The optional `promptsDir` parameter overrides both (used in tests).
 */
export function loadTemplate(name: string, promptsDir?: string): string {
  const raw = loadTemplateRaw(name, promptsDir);
  return parseTemplateFrontmatter(raw).body;
}

/**
 * Load a template and return both its parsed metadata and body.
 */
export function loadTemplateWithMeta(name: string, promptsDir?: string): { meta: TemplateMeta; body: string } {
  return parseTemplateFrontmatter(loadTemplateRaw(name, promptsDir));
}

/** Load the raw template content (including frontmatter). */
function loadTemplateRaw(name: string, promptsDir?: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`Invalid template name: "${name}"`);
  }

  if (promptsDir) {
    const filePath = join(promptsDir, `${name}.md`);
    if (!existsSync(filePath)) {
      throw new Error(`Template not found: ${filePath}`);
    }
    return readFileSync(filePath, "utf-8");
  }

  // Check user templates first, then built-in
  const userPath = join(config.dataDir, "templates", `${name}.md`);
  if (existsSync(userPath)) {
    return readFileSync(userPath, "utf-8");
  }

  const builtinPath = join(import.meta.dir, "prompts", `${name}.md`);
  if (existsSync(builtinPath)) {
    return readFileSync(builtinPath, "utf-8");
  }

  throw new Error(`Template "${name}" not found. Place a ${name}.md file in ~/.codex-collab/templates/ or check available built-in templates.`);
}

/**
 * List all available templates from user and built-in directories.
 * User templates override built-in templates with the same name.
 */
export function listTemplates(): TemplateMeta[] {
  const templates = new Map<string, TemplateMeta>();

  // Built-in templates
  const builtinDir = join(import.meta.dir, "prompts");
  if (existsSync(builtinDir)) {
    for (const file of readdirSync(builtinDir).filter(f => f.endsWith(".md"))) {
      const name = file.replace(/\.md$/, "");
      const raw = readFileSync(join(builtinDir, file), "utf-8");
      const { meta } = parseTemplateFrontmatter(raw);
      templates.set(name, { ...meta, name });
    }
  }

  // User templates (override built-in)
  const userDir = join(config.dataDir, "templates");
  if (existsSync(userDir)) {
    for (const file of readdirSync(userDir).filter(f => f.endsWith(".md"))) {
      const name = file.replace(/\.md$/, "");
      const raw = readFileSync(join(userDir, file), "utf-8");
      const { meta } = parseTemplateFrontmatter(raw);
      templates.set(name, { ...meta, name });
    }
  }

  return [...templates.values()].sort((a, b) => a.name.localeCompare(b.name));
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
