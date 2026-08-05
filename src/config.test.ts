import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "fs";
import { join, basename, resolve, sep } from "path";
import { createHash } from "crypto";
import { describeAuth } from "./commands/config";
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
    expect(config.reasoningEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  test("auto-select ceiling is a known effort below the top of the enum", () => {
    const efforts = config.reasoningEfforts as readonly string[];
    expect(efforts).toContain(config.autoEffortCeiling);
    expect(efforts.indexOf(config.autoEffortCeiling)).toBeLessThan(efforts.length - 1);
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
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
      expect(validateEffort(level)).toBe(level);
    }
  });

  test("throws on invalid effort", () => {
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

describe("describeAuth (health account check)", () => {
  test("ChatGPT login is ready and names the plan and email", () => {
    const r = describeAuth({
      account: { type: "chatgpt", email: "a@b.com", planType: "pro" },
      requiresOpenaiAuth: true,
    });
    expect(r.ready).toBe(true);
    expect(r.detail).toContain("pro");
    expect(r.detail).toContain("a@b.com");
  });

  test("an API key counts as ready, but is reported as unverified", () => {
    // Presence of a key is not proof it works — don't claim more than we know.
    const r = describeAuth({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(r.ready).toBe(true);
    expect(r.detail).toMatch(/not verified/i);
  });

  test("a provider needing no OpenAI auth is ready even with no account", () => {
    // Third-party base URL / proxy setups: no OpenAI credentials exist by design.
    const r = describeAuth({ account: null, requiresOpenaiAuth: false });
    expect(r.ready).toBe(true);
  });

  test("an unrecognized account type fails open", () => {
    const r = describeAuth({ account: { type: "somethingNew" }, requiresOpenaiAuth: true });
    expect(r.ready).toBe(true);
  });

  test("an unavailable account/read fails open", () => {
    // Older codex builds, a busy broker, a transient RPC error — none of these
    // are evidence the user is logged out.
    expect(describeAuth("unknown").ready).toBe(true);
  });

  test("no account plus requiresOpenaiAuth is the only failure", () => {
    const r = describeAuth({ account: null, requiresOpenaiAuth: true });
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/NOT AUTHENTICATED/);
  });

  test("no account and no stated auth requirement is inconclusive, not logged out", () => {
    // requiresOpenaiAuth is optional and nullable. Absent or null says nothing
    // about whether credentials exist, so reporting it as logged out would tell
    // a working user to run `codex login`.
    expect(describeAuth({ account: null }).ready).toBe(true);
    expect(describeAuth({ account: null, requiresOpenaiAuth: null }).ready).toBe(true);
    expect(describeAuth({}).ready).toBe(true);
    expect(describeAuth({ account: null }).detail).not.toMatch(/NOT AUTHENTICATED/);
  });
});

describe("brokerReadyTimeout", () => {
  const ENV = "CODEX_COLLAB_BROKER_READY_TIMEOUT_MS";
  const original = process.env[ENV];
  afterAll(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  test("defaults to a window wide enough for a cold app-server", () => {
    delete process.env[ENV];
    // Falling back early does not save the caller time — it only adds a
    // second concurrent app-server startup, which is what collides.
    expect(config.brokerReadyTimeout).toBe(30_000);
  });

  test("honors the env override so tests can shorten it", () => {
    process.env[ENV] = "250";
    expect(config.brokerReadyTimeout).toBe(250);
  });

  test("ignores a non-positive or unparseable override", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env[ENV] = bad;
      expect(config.brokerReadyTimeout).toBe(30_000);
    }
  });
});
