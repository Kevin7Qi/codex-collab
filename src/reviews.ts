// src/reviews.ts — Review target validation, structured output parsing, and formatting

import type {
  ReviewTarget,
  StructuredReviewOutput,
  ReviewFinding,
  ReviewVerdict,
  ReviewSeverity,
} from "./types";

const VALID_VERDICTS: ReadonlySet<string> = new Set<ReviewVerdict>([
  "approve",
  "needs-attention",
  "request-changes",
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set<ReviewSeverity>([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

/**
 * Validate that a review target is compatible with the native reviewer.
 * Native reviewer supports: uncommittedChanges, baseBranch, commit.
 * Custom instructions are NOT compatible with native review mode.
 * Throws if the combination is invalid.
 */
export function validateNativeReviewTarget(target: ReviewTarget): void {
  if (target.type === "custom") {
    throw new Error(
      "Custom instructions are not compatible with native review mode. Use a task instead.",
    );
  }
}

/**
 * Parse structured review output from Codex's raw response text.
 * The response may contain JSON wrapped in markdown code fences.
 * Returns null if the output can't be parsed or doesn't match the schema.
 */
export function parseStructuredReviewOutput(raw: string): StructuredReviewOutput | null {
  const json = extractJson(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  return validateReviewOutput(parsed);
}

/**
 * Format a structured review output for human-readable display.
 */
export function formatReviewOutput(result: StructuredReviewOutput): string {
  const lines: string[] = [];

  lines.push(`Review: ${result.verdict}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");
  lines.push(`Findings (${result.findings.length}):`);

  for (const f of result.findings) {
    lines.push("");
    const location = formatLocation(f);
    lines.push(`  [${f.severity}] ${location} (confidence: ${f.confidence})`);
    lines.push(`    ${f.description}`);
    lines.push(`    \u2192 ${f.recommendation}`);
  }

  if (result.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next Steps:");
    for (const step of result.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  return lines.join("\n");
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Extract a JSON object string from raw text that may include markdown fences or prose. */
function extractJson(raw: string): string | null {
  // Try markdown code fence with or without language tag
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try to find bare JSON object — locate the first '{' and find its matching '}'
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Validate that a parsed object conforms to the StructuredReviewOutput schema. */
function validateReviewOutput(obj: unknown): StructuredReviewOutput | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const o = obj as Record<string, unknown>;

  // verdict
  if (typeof o.verdict !== "string" || !VALID_VERDICTS.has(o.verdict)) return null;

  // summary
  if (typeof o.summary !== "string" || o.summary.length === 0) return null;

  // findings
  if (!Array.isArray(o.findings)) return null;
  const findings: ReviewFinding[] = [];
  for (const f of o.findings) {
    const validated = validateFinding(f);
    if (validated === null) return null;
    findings.push(validated);
  }

  // nextSteps
  if (!Array.isArray(o.nextSteps)) return null;
  for (const step of o.nextSteps) {
    if (typeof step !== "string") return null;
  }

  return {
    verdict: o.verdict as ReviewVerdict,
    summary: o.summary,
    findings,
    nextSteps: o.nextSteps as string[],
  };
}

/** Validate a single finding object. */
function validateFinding(obj: unknown): ReviewFinding | null {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const f = obj as Record<string, unknown>;

  if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity)) return null;
  if (typeof f.file !== "string" || f.file.length === 0) return null;
  if (typeof f.description !== "string" || f.description.length === 0) return null;
  if (typeof f.recommendation !== "string" || f.recommendation.length === 0) return null;
  if (typeof f.confidence !== "number" || f.confidence < 0 || f.confidence > 1) return null;

  // lineStart and lineEnd are optional (may be null or number)
  const lineStart =
    f.lineStart === null || f.lineStart === undefined
      ? null
      : typeof f.lineStart === "number"
        ? f.lineStart
        : null;
  const lineEnd =
    f.lineEnd === null || f.lineEnd === undefined
      ? null
      : typeof f.lineEnd === "number"
        ? f.lineEnd
        : null;

  // If lineStart or lineEnd was provided but not a valid type, reject
  if (f.lineStart !== null && f.lineStart !== undefined && typeof f.lineStart !== "number")
    return null;
  if (f.lineEnd !== null && f.lineEnd !== undefined && typeof f.lineEnd !== "number") return null;

  return {
    severity: f.severity as ReviewSeverity,
    file: f.file,
    lineStart,
    lineEnd,
    confidence: f.confidence,
    description: f.description,
    recommendation: f.recommendation,
  };
}

/** Format a finding's file location. */
function formatLocation(f: ReviewFinding): string {
  if (f.lineStart !== null && f.lineEnd !== null) {
    return `${f.file}:${f.lineStart}-${f.lineEnd}`;
  }
  return f.file;
}
