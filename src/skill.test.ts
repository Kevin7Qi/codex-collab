import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SKILL_SOURCE,
  TEMPLATES_PLACEHOLDER,
  renderTemplateTable,
  renderSkillMd,
  unifiedDiff,
  installedSkillMd,
  CODEX_SKILL_SOURCE,
  codexSkillInSync,
  codexSkillInstallDir,
  expectedCodexSkillMd,
  installedCodexSkillMd,
  codexRulesInSync,
  codexRulesInstallPath,
  expectedCodexRules,
  installCodexRules,
  removeCodexRules,
} from "./skill";

describe("Codex exec-policy rule (opt-in)", () => {
  test("allows the two commands that must leave the sandbox, and nothing wider", () => {
    const rules = expectedCodexRules();
    expect(rules).toContain('prefix_rule(pattern=["codex-collab", "send"], decision="allow")');
    // `peers stop` ends the session through Claude Code, which the sandbox
    // blocks as surely as it blocks `send`'s socket.
    expect(rules).toContain('prefix_rule(pattern=["codex-collab", "peers", "stop"], decision="allow")');
    // Narrow prefixes only: nothing here allows `codex-collab` wholesale.
    expect(rules.split("\n").filter((l) => l.startsWith("prefix_rule"))).toHaveLength(2);
    expect(rules).not.toContain('prefix_rule(pattern=["codex-collab"]');
  });

  test("path: override, then $CODEX_HOME/rules, then ~/.codex/rules", () => {
    const saved = { path: process.env.CODEX_COLLAB_CODEX_RULES_PATH, home: process.env.CODEX_HOME };
    try {
      process.env.CODEX_COLLAB_CODEX_RULES_PATH = "/tmp/override.rules";
      expect(codexRulesInstallPath()).toBe("/tmp/override.rules");
      delete process.env.CODEX_COLLAB_CODEX_RULES_PATH;
      process.env.CODEX_HOME = "/tmp/codex-home";
      expect(codexRulesInstallPath()).toBe(join("/tmp/codex-home", "rules", "codex-collab.rules"));
      delete process.env.CODEX_HOME;
      expect(codexRulesInstallPath().endsWith(join(".codex", "rules", "codex-collab.rules"))).toBe(true);
    } finally {
      if (saved.path === undefined) delete process.env.CODEX_COLLAB_CODEX_RULES_PATH; else process.env.CODEX_COLLAB_CODEX_RULES_PATH = saved.path;
      if (saved.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.home;
    }
  });

  test("install, in-sync, stale, remove", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-rules-test-"));
    const path = join(dir, "rules", "codex-collab.rules");
    try {
      expect(codexRulesInSync(path)).toBeNull();
      expect(installCodexRules(path)).toBe(path);
      expect(codexRulesInSync(path)).toBe(true);
      writeFileSync(path, "stale\n");
      expect(codexRulesInSync(path)).toBe(false);
      expect(removeCodexRules(path)).toBe(true);
      expect(codexRulesInSync(path)).toBeNull();
      expect(removeCodexRules(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── the Codex-side skill ───────────────────────────────────────────────────

describe("Codex skill", () => {
  test("is embedded, names the two commands, and says where send must run", () => {
    expect(CODEX_SKILL_SOURCE).toContain("name: claude-collab");
    expect(CODEX_SKILL_SOURCE).toContain("codex-collab peers");
    expect(CODEX_SKILL_SOURCE).toContain("codex-collab send");
    expect(CODEX_SKILL_SOURCE).toContain("outside the sandbox");
    expect(expectedCodexSkillMd()).not.toContain("\r\n");
  });

  test("install dir: override, then $CODEX_HOME, then ~/.codex", () => {
    const saved = { dir: process.env.CODEX_COLLAB_CODEX_SKILL_DIR, home: process.env.CODEX_HOME };
    try {
      process.env.CODEX_COLLAB_CODEX_SKILL_DIR = "/tmp/override-skill";
      expect(codexSkillInstallDir()).toBe("/tmp/override-skill");
      delete process.env.CODEX_COLLAB_CODEX_SKILL_DIR;
      process.env.CODEX_HOME = "/tmp/codex-home";
      expect(codexSkillInstallDir()).toBe(join("/tmp/codex-home", "skills", "claude-collab"));
      delete process.env.CODEX_HOME;
      expect(codexSkillInstallDir().endsWith(join(".codex", "skills", "claude-collab"))).toBe(true);
    } finally {
      if (saved.dir === undefined) delete process.env.CODEX_COLLAB_CODEX_SKILL_DIR; else process.env.CODEX_COLLAB_CODEX_SKILL_DIR = saved.dir;
      if (saved.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.home;
    }
  });

  test("in-sync: null when absent, true when identical (CRLF tolerated), false when stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-skill-test-"));
    try {
      expect(installedCodexSkillMd(dir)).toBeNull();
      expect(codexSkillInSync(dir)).toBeNull();
      writeFileSync(join(dir, "SKILL.md"), expectedCodexSkillMd().replace(/\n/g, "\r\n"));
      expect(codexSkillInSync(dir)).toBe(true);
      writeFileSync(join(dir, "SKILL.md"), "stale\n");
      expect(codexSkillInSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── embedded source ────────────────────────────────────────────────────────

describe("SKILL_SOURCE", () => {
  test("is embedded and contains the template placeholder", () => {
    expect(SKILL_SOURCE.length).toBeGreaterThan(1000);
    expect(SKILL_SOURCE).toContain(TEMPLATES_PLACEHOLDER);
    expect(SKILL_SOURCE).toContain("name: codex-collab");
  });
});

// ─── renderTemplateTable ────────────────────────────────────────────────────

describe("renderTemplateTable", () => {
  test("empty list", () => {
    expect(renderTemplateTable([])).toBe("No templates found.");
  });

  test("rows with description and sandbox", () => {
    const table = renderTemplateTable([
      { name: "collab", description: "Collaboration channel", sandbox: "workspace-write" },
      { name: "bare", description: "" },
    ]);
    expect(table).toContain("| Template | Description |");
    expect(table).toContain("| `collab` | Collaboration channel (workspace-write) |");
    expect(table).toContain("| `bare` | (no description) |");
  });
});

// ─── renderSkillMd ──────────────────────────────────────────────────────────

describe("renderSkillMd", () => {
  test("replaces the placeholder line with the table", () => {
    const src = `# Title\n\n${TEMPLATES_PLACEHOLDER}\n\nTail\n`;
    const out = renderSkillMd(src, [{ name: "a", description: "d" }]);
    expect(out).not.toContain(TEMPLATES_PLACEHOLDER);
    expect(out).toContain("| `a` | d |");
    expect(out.startsWith("# Title\n")).toBe(true);
    expect(out.endsWith("Tail\n")).toBe(true);
  });

  test("only whole-line placeholders are replaced", () => {
    const src = `inline ${TEMPLATES_PLACEHOLDER} stays\n${TEMPLATES_PLACEHOLDER}\n`;
    const out = renderSkillMd(src, []);
    expect(out).toContain(`inline ${TEMPLATES_PLACEHOLDER} stays`);
    expect(out).toContain("No templates found.");
  });

  test("normalizes CRLF", () => {
    const out = renderSkillMd(`a\r\n${TEMPLATES_PLACEHOLDER}\r\n`, []);
    expect(out).toBe("a\nNo templates found.\n");
  });
});

// ─── installedSkillMd ───────────────────────────────────────────────────────

describe("installedSkillMd", () => {
  test("reads SKILL.md from a dir; null when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-test-"));
    try {
      expect(installedSkillMd(dir)).toBeNull();
      writeFileSync(join(dir, "SKILL.md"), "content\n");
      expect(installedSkillMd(dir)).toBe("content\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── unifiedDiff ────────────────────────────────────────────────────────────

describe("unifiedDiff", () => {
  test("identical texts produce empty diff", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nb\nc\n")).toBe("");
  });

  test("single-line change", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nX\nc\n");
    expect(diff).toContain("--- installed");
    expect(diff).toContain("+++ expected");
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain("-b");
    expect(diff).toContain("+X");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  test("pure addition to empty text", () => {
    const diff = unifiedDiff("", "a\nb\n");
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diff).toContain("+a");
    expect(diff).toContain("+b");
  });

  test("distant changes produce separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i}`);
    const changed = [...lines];
    changed[2] = "CHANGED-A";
    changed[25] = "CHANGED-B";
    const diff = unifiedDiff(lines.join("\n") + "\n", changed.join("\n") + "\n");
    const hunkHeaders = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(2);
    expect(diff).toContain("-line2");
    expect(diff).toContain("+CHANGED-A");
    expect(diff).toContain("-line25");
    expect(diff).toContain("+CHANGED-B");
    // context lines far from both changes are not included
    expect(diff).not.toContain(" line12");
  });

  test("nearby changes merge into one hunk", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    const changed = [...lines];
    changed[4] = "A";
    changed[6] = "B";
    const diff = unifiedDiff(lines.join("\n") + "\n", changed.join("\n") + "\n");
    const hunkHeaders = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(1);
  });

  test("custom labels", () => {
    const diff = unifiedDiff("a\n", "b\n", "old.md", "new.md");
    expect(diff).toContain("--- old.md");
    expect(diff).toContain("+++ new.md");
  });
});

// ─── mode-conditional sections ──────────────────────────────────────────────

describe("renderSkillMd — mode sections", () => {
  const src = [
    "shared intro",
    "<!-- MODE:peer -->",
    "peer only",
    "<!-- /MODE:peer -->",
    "<!-- MODE:cli -->",
    "cli only",
    "<!-- /MODE:cli -->",
    "shared outro",
  ].join("\n");

  test("each mode keeps its own sections and drops the other's", () => {
    const peer = renderSkillMd(src, [], "peer");
    expect(peer).toContain("peer only");
    expect(peer).not.toContain("cli only");

    const cli = renderSkillMd(src, [], "cli");
    expect(cli).toContain("cli only");
    expect(cli).not.toContain("peer only");
  });

  test("shared content survives either way, and markers never leak", () => {
    for (const mode of ["peer", "cli"] as const) {
      const out = renderSkillMd(src, [], mode);
      expect(out).toContain("shared intro");
      expect(out).toContain("shared outro");
      expect(out).not.toContain("MODE:");
    }
  });

  test("nested and repeated blocks of the same mode are handled", () => {
    const repeated = [
      "<!-- MODE:cli -->", "one", "<!-- /MODE:cli -->",
      "keep",
      "<!-- MODE:cli -->", "two", "<!-- /MODE:cli -->",
    ].join("\n");
    const peer = renderSkillMd(repeated, [], "peer");
    expect(peer).toContain("keep");
    expect(peer).not.toContain("one");
    expect(peer).not.toContain("two");
  });

  test("an unclosed marker keeps its content rather than eating the file", () => {
    // A mangled source should render a visibly odd skill, not a silently
    // truncated one — the reader can see something is wrong.
    const broken = ["<!-- MODE:peer -->", "kept", "tail"].join("\n");
    expect(renderSkillMd(broken, [], "peer")).toContain("tail");
  });

  test("the template table still expands inside a mode section", () => {
    const withTable = [
      "<!-- MODE:peer -->", TEMPLATES_PLACEHOLDER, "<!-- /MODE:peer -->",
    ].join("\n");
    const out = renderSkillMd(withTable, [{ name: "collab", description: "d" }], "peer");
    expect(out).toContain("collab");
    expect(out).not.toContain(TEMPLATES_PLACEHOLDER);
  });

  test("a source with no markers renders identically in both modes", () => {
    // Until the source is marked up, nothing changes for anyone.
    const plain = "just\ncontent";
    expect(renderSkillMd(plain, [], "peer")).toBe(renderSkillMd(plain, [], "cli"));
  });
});
