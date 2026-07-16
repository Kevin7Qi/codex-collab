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
} from "./skill";

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
