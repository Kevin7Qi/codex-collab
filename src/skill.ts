// src/skill.ts — installed-skill rendering and drift detection
//
// The SKILL.md source is embedded into the binary at build time (Bun text
// import), so the binary can always regenerate the skill file that matches
// its own version plus the machine's current template set. Nothing in this
// module writes to ~/.claude/skills/ — that happens only in the explicit
// `skill sync` command, never as a side effect.

import { homedir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { listTemplates, type TemplateMeta } from "./config";
import { readConfiguredMode, resolveCollabMode } from "./peer";
import skillSource from "../SKILL.md" with { type: "text" };

/** The SKILL.md source embedded at build time (placeholder not yet expanded). */
export const SKILL_SOURCE: string = skillSource;

/** Placeholder line in the SKILL.md source replaced by the template table. */
export const TEMPLATES_PLACEHOLDER = "<!-- TEMPLATES -->";

/** Section markers that scope a block of the source to one collaboration
 *  mode: `<!-- MODE:peer -->` … `<!-- /MODE:peer -->`. Both paths stay in
 *  the source — the CLI one is load-bearing for Windows, for humans, and for
 *  scripts — but Claude is only taught the one its machine actually uses.
 *  Teaching both is how the file grew while promising to shrink. */
const MODE_OPEN = /^<!--\s*MODE:(peer|cli)\s*-->$/;
const MODE_CLOSE = /^<!--\s*\/MODE:(peer|cli)\s*-->$/;

/** Drop the blocks that belong to the other mode. Unbalanced markers keep
 *  their content rather than silently swallowing the rest of the file: a
 *  mangled source should render a visibly odd skill, not a truncated one. */
function applyModeSections(lines: string[], mode: "peer" | "cli"): string[] {
  const out: string[] = [];
  let skipping: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const close = MODE_CLOSE.exec(trimmed);
    if (close) {
      if (skipping === close[1]) skipping = null;
      continue;
    }
    const open = MODE_OPEN.exec(trimmed);
    if (open) {
      if (open[1] !== mode) skipping = open[1];
      continue;
    }
    if (skipping === null) out.push(line);
  }
  return out;
}

/** Directory Claude Code loads the skill from. */
export function skillInstallDir(): string {
  const override = process.env.CODEX_COLLAB_SKILL_DIR;
  if (override) return override;
  return join(homedir(), ".claude", "skills", "codex-collab");
}

/** Render the template table injected into SKILL.md. */
export function renderTemplateTable(templates: TemplateMeta[]): string {
  if (templates.length === 0) return "No templates found.";
  const rows = templates.map((t) => {
    const desc = t.description || "(no description)";
    const sandbox = t.sandbox ? ` (${t.sandbox})` : "";
    return `| \`${t.name}\` | ${desc}${sandbox} |`;
  });
  return ["| Template | Description |", "|----------|-------------|", ...rows].join("\n");
}

/** Expand the source SKILL.md: keep the sections this mode uses, then
 *  replace the placeholder line with the table. */
export function renderSkillMd(
  source: string,
  templates: TemplateMeta[],
  mode: "peer" | "cli" = "peer",
): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  return applyModeSections(lines, mode)
    .map((line) => (line === TEMPLATES_PLACEHOLDER ? renderTemplateTable(templates) : line))
    .join("\n");
}

/** The mode the installed skill should be rendered for. Keyed off the
 *  INSTALL — platform, the configured mode, and the version of Claude Code
 *  on PATH — never off whether a session happens to be running, or the same
 *  machine would render different files minutes apart. */
export function skillRenderMode(): "peer" | "cli" {
  return resolveCollabMode(readConfiguredMode()).mode;
}

/** The SKILL.md this binary would install right now (embedded source +
 *  current built-in and user templates). */
export function expectedSkillMd(): string {
  return renderSkillMd(SKILL_SOURCE, listTemplates(), skillRenderMode());
}

/** Installed SKILL.md content, or null if missing/unreadable. */
export function installedSkillMd(dir: string = skillInstallDir()): string | null {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

/** True iff the installed SKILL.md matches what this binary would generate.
 *  Returns null when no skill is installed (nothing to be out of date). */
export function skillInSync(dir: string = skillInstallDir()): boolean | null {
  const installed = installedSkillMd(dir);
  if (installed === null) return null;
  return normalizeNewlines(installed) === normalizeNewlines(expectedSkillMd());
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// ─── Unified diff ───────────────────────────────────────────────────────────
// Minimal line-based LCS diff — SKILL.md is a few hundred lines, so the
// O(n·m) table is trivial. Used to show the user exactly what `skill sync`
// is about to write before anything touches disk.

type DiffOp = { t: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  const lines = normalizeNewlines(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // lcs[i*width+j] = LCS length of a[i:] vs b[j:]
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

/** Unified diff between two texts. Empty string when they are identical. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel = "installed",
  newLabel = "expected",
  context = 3,
): string {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  if (!ops.some((o) => o.t !== " ")) return "";

  // Expand each change by `context` lines, then merge overlapping ranges.
  const ranges: Array<[number, number]> = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].t === " ") continue;
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length, idx + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  // Old/new line number (1-based) at each op index.
  const oldPos = new Array<number>(ops.length + 1);
  const newPos = new Array<number>(ops.length + 1);
  let ol = 1;
  let nl = 1;
  for (let idx = 0; idx <= ops.length; idx++) {
    oldPos[idx] = ol;
    newPos[idx] = nl;
    if (idx < ops.length) {
      if (ops[idx].t !== "+") ol++;
      if (ops[idx].t !== "-") nl++;
    }
  }

  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const [start, end] of ranges) {
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((o) => o.t !== "+").length;
    const newCount = hunk.filter((o) => o.t !== "-").length;
    const oldStart = oldCount === 0 ? oldPos[start] - 1 : oldPos[start];
    const newStart = newCount === 0 ? newPos[start] - 1 : newPos[start];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(op.t + op.line);
  }
  return out.join("\n");
}
