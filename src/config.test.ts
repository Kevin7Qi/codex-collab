import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join, basename, resolve, sep } from "path";
import { createHash } from "crypto";
import {
  config,
  validateId,
  resolveWorkspaceDir,
  resolveStateDir,
  resolveModel,
  validateEffort,
  loadTemplate,
  loadTemplateWithMeta,
  interpolateTemplate,
  parseTemplateFrontmatter,
  listTemplates,
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

  test("has threadsListLimit", () => {
    expect(config.threadsListLimit).toBe(20);
  });

  test("has new fields", () => {
    expect(config.defaultBrokerIdleTimeout).toBe(30 * 60 * 1000);
    expect(config.maxRunsPerWorkspace).toBe(50);
    expect(config.serviceName).toBe("codex-collab");
  });

  test("has accepted reasoning efforts", () => {
    expect(config.reasoningEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
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
    // On Windows, git returns forward-slash paths while process.cwd() uses backslashes
    expect(resolve(result)).toBe(resolve(process.cwd()));
  });

  test("returns resolved cwd when not in a git repo", () => {
    // Use a platform-appropriate temp directory that is not inside a git repo
    const tmpDir = process.env.TMPDIR ?? (process.platform === "win32" ? process.env.TEMP ?? "C:\\Windows\\Temp" : "/tmp");
    const result = resolveWorkspaceDir(tmpDir);
    expect(resolve(result)).toBe(resolve(realpathSync(tmpDir)));
  });
});

// ─── resolveStateDir ────────────────────────────────────────────────────────

describe("resolveStateDir", () => {
  test("returns path under ~/.codex-collab/workspaces/", () => {
    const result = resolveStateDir(process.cwd());
    expect(result).toContain(`.codex-collab${sep}workspaces${sep}`);
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
    const tmpDir = process.env.TMPDIR ?? (process.platform === "win32" ? process.env.TEMP ?? "C:\\Windows\\Temp" : "/tmp");
    const dir2 = resolveStateDir(tmpDir);
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

  test("rejects path traversal attempts", () => {
    expect(() => loadTemplate("../escape")).toThrow("Invalid template name");
    expect(() => loadTemplate("sub/path")).toThrow("Invalid template name");
    expect(() => loadTemplate("..\\escape")).toThrow("Invalid template name");
  });

  test("loads built-in plan-review template without override", () => {
    const content = loadTemplate("plan-review");
    expect(content).toContain("{{PROMPT}}");
    expect(content).toContain("implementation plan");
    // Frontmatter should be stripped
    expect(content).not.toContain("---");
    expect(content).not.toContain("sandbox:");
  });

  test("strips frontmatter from template with override dir", () => {
    writeFileSync(join(tmpDir, "with-fm.md"), "---\nname: test\ndescription: A test\n---\nBody here");
    const content = loadTemplate("with-fm", tmpDir);
    expect(content).toBe("Body here");
  });

  test("loadTemplateWithMeta returns both metadata and body", () => {
    writeFileSync(join(tmpDir, "meta-test.md"), "---\nname: meta-test\ndescription: Test template\nsandbox: read-only\n---\nTemplate body {{PROMPT}}");
    const { meta, body } = loadTemplateWithMeta("meta-test", tmpDir);
    expect(meta.name).toBe("meta-test");
    expect(meta.description).toBe("Test template");
    expect(meta.sandbox).toBe("read-only");
    expect(body).toBe("Template body {{PROMPT}}");
  });

  test("throws helpful message for missing template without override", () => {
    expect(() => loadTemplate("nonexistent-xyz")).toThrow("Template \"nonexistent-xyz\" not found");
  });
});

// ─── parseTemplateFrontmatter ───────────────────────────────────────────────

describe("parseTemplateFrontmatter", () => {
  test("extracts frontmatter fields", () => {
    const raw = "---\nname: test\ndescription: A test template\nsandbox: read-only\n---\nBody content";
    const { meta, body } = parseTemplateFrontmatter(raw);
    expect(meta.name).toBe("test");
    expect(meta.description).toBe("A test template");
    expect(meta.sandbox).toBe("read-only");
    expect(body).toBe("Body content");
  });

  test("returns empty meta and full body when no frontmatter", () => {
    const raw = "Just plain content\nNo frontmatter here";
    const { meta, body } = parseTemplateFrontmatter(raw);
    expect(meta.name).toBe("");
    expect(meta.description).toBe("");
    expect(meta.sandbox).toBeUndefined();
    expect(body).toBe(raw);
  });

  test("handles missing closing delimiter", () => {
    const raw = "---\nname: broken\nNo closing delimiter";
    const { body } = parseTemplateFrontmatter(raw);
    expect(body).toBe(raw);
  });

  test("strips leading blank lines after frontmatter", () => {
    const raw = "---\nname: test\n---\n\n\nBody";
    const { body } = parseTemplateFrontmatter(raw);
    expect(body).toBe("Body");
  });

  test("handles CRLF line endings", () => {
    const raw = "---\r\nname: test\r\ndescription: CRLF template\r\nsandbox: read-only\r\n---\r\nBody with CRLF";
    const { meta, body } = parseTemplateFrontmatter(raw);
    expect(meta.name).toBe("test");
    expect(meta.description).toBe("CRLF template");
    expect(meta.sandbox).toBe("read-only");
    expect(body).toBe("Body with CRLF");
  });
});

// ─── listTemplates ──────────────────────────────────────────────────────────

describe("listTemplates", () => {
  test("includes built-in plan-review template", () => {
    const templates = listTemplates();
    const planReview = templates.find(t => t.name === "plan-review");
    expect(planReview).toBeDefined();
    expect(planReview!.description).toContain("implementation plan");
    expect(planReview!.sandbox).toBe("read-only");
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
