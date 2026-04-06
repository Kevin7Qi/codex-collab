import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import {
  config,
  validateId,
  resolveWorkspaceDir,
  resolveStateDir,
  resolveModel,
  validateEffort,
  loadTemplate,
  interpolateTemplate,
} from "./config";

// ─── config object ──────────────────────────────────────────────────────────

describe("config object", () => {
  test("has data paths under .codex-collab", () => {
    expect(config.dataDir).toContain(".codex-collab");
    expect(config.configFile).toContain("config.json");
  });

  test("deprecated paths still work", () => {
    expect(config.threadsFile).toContain("threads.json");
    expect(config.logsDir).toContain("logs");
    expect(config.approvalsDir).toContain("approvals");
    expect(config.killSignalsDir).toContain("kill-signals");
    expect(config.pidsDir).toContain("pids");
  });

  test("has protocol timeouts", () => {
    expect(config.requestTimeout).toBeGreaterThan(0);
    expect(config.defaultTimeout).toBeGreaterThan(0);
  });

  test("has threadsListLimit (renamed from jobsListLimit)", () => {
    expect(config.threadsListLimit).toBe(20);
    // jobsListLimit should still work as deprecated alias
    expect(config.jobsListLimit).toBe(20);
  });

  test("has new fields", () => {
    expect(config.defaultBrokerIdleTimeout).toBe(30 * 60 * 1000);
    expect(config.maxRunsPerWorkspace).toBe(50);
    expect(config.serviceName).toBe("codex-collab");
  });

  test("has reasoning efforts including none and minimal", () => {
    expect(config.reasoningEfforts).toContain("none");
    expect(config.reasoningEfforts).toContain("minimal");
    expect(config.reasoningEfforts).toContain("low");
    expect(config.reasoningEfforts).toContain("medium");
    expect(config.reasoningEfforts).toContain("high");
    expect(config.reasoningEfforts).toContain("xhigh");
  });

  test("is frozen", () => {
    expect(Object.isFrozen(config)).toBe(true);
  });
});

// ─── validateId ─────────────────────────────────────────────────────────────

describe("validateId", () => {
  test("accepts valid IDs", () => {
    expect(validateId("abc-123_XYZ")).toBe("abc-123_XYZ");
  });

  test("rejects invalid IDs", () => {
    expect(() => validateId("has spaces")).toThrow("Invalid ID");
    expect(() => validateId("../escape")).toThrow("Invalid ID");
  });
});

// ─── resolveWorkspaceDir ────────────────────────────────────────────────────

describe("resolveWorkspaceDir", () => {
  test("returns git repo root for cwd inside a git repo", () => {
    const result = resolveWorkspaceDir(process.cwd());
    // This test repo is a git repo; the root should contain package.json
    expect(result).toBe(process.cwd());
  });

  test("returns resolved cwd when not in a git repo", () => {
    // /tmp is not a git repo
    const result = resolveWorkspaceDir("/tmp");
    expect(result).toBe(realpathSync("/tmp"));
  });
});

// ─── resolveStateDir ────────────────────────────────────────────────────────

describe("resolveStateDir", () => {
  test("returns path under ~/.codex-collab/workspaces/", () => {
    const result = resolveStateDir(process.cwd());
    expect(result).toContain(".codex-collab/workspaces/");
  });

  test("path contains slug and hash", () => {
    const result = resolveStateDir(process.cwd());
    const wsRoot = resolveWorkspaceDir(process.cwd());
    const canonical = realpathSync(wsRoot);
    const slug = basename(canonical).replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
    expect(result).toContain(`${slug}-${hash}`);
  });

  test("different paths produce different state dirs", () => {
    const dir1 = resolveStateDir(process.cwd());
    const dir2 = resolveStateDir("/tmp");
    expect(dir1).not.toBe(dir2);
  });
});

// ─── resolveModel ───────────────────────────────────────────────────────────

describe("resolveModel", () => {
  test("resolves spark alias", () => {
    expect(resolveModel("spark")).toBe("gpt-5.3-codex-spark");
  });

  test("passes through unknown model names", () => {
    expect(resolveModel("o4-mini")).toBe("o4-mini");
    expect(resolveModel("gpt-5")).toBe("gpt-5");
  });

  test("returns undefined for undefined input", () => {
    expect(resolveModel(undefined)).toBeUndefined();
  });
});

// ─── validateEffort ─────────────────────────────────────────────────────────

describe("validateEffort", () => {
  test("accepts all valid effort levels", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(validateEffort(level)).toBe(level);
    }
  });

  test("throws on invalid effort", () => {
    expect(() => validateEffort("max")).toThrow();
    expect(() => validateEffort("turbo")).toThrow();
    expect(() => validateEffort("")).toThrow();
  });

  test("returns undefined for undefined input", () => {
    expect(validateEffort(undefined)).toBeUndefined();
  });
});

// ─── loadTemplate ───────────────────────────────────────────────────────────

describe("loadTemplate", () => {
  const tmpDir = join(process.env.TMPDIR ?? "/tmp", "config-test-prompts");

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "greeting.md"), "Hello, {{NAME}}!");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads a template file by name", () => {
    const content = loadTemplate("greeting", tmpDir);
    expect(content).toBe("Hello, {{NAME}}!");
  });

  test("throws for missing template", () => {
    expect(() => loadTemplate("nonexistent", tmpDir)).toThrow();
  });
});

// ─── interpolateTemplate ────────────────────────────────────────────────────

describe("interpolateTemplate", () => {
  test("replaces known variables", () => {
    const result = interpolateTemplate("Hello, {{NAME}}! Welcome to {{PLACE}}.", {
      NAME: "Alice",
      PLACE: "Wonderland",
    });
    expect(result).toBe("Hello, Alice! Welcome to Wonderland.");
  });

  test("leaves unknown variables as-is", () => {
    const result = interpolateTemplate("{{KNOWN}} and {{UNKNOWN}}", {
      KNOWN: "replaced",
    });
    expect(result).toBe("replaced and {{UNKNOWN}}");
  });

  test("handles empty vars", () => {
    const result = interpolateTemplate("no vars here", {});
    expect(result).toBe("no vars here");
  });

  test("replaces multiple occurrences of the same variable", () => {
    const result = interpolateTemplate("{{X}} and {{X}}", { X: "y" });
    expect(result).toBe("y and y");
  });
});
