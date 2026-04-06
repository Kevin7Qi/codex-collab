import { describe, expect, test } from "bun:test";
import {
  validateNativeReviewTarget,
  parseStructuredReviewOutput,
  formatReviewOutput,
} from "./reviews";
import type { ReviewTarget, StructuredReviewOutput } from "./types";

// ─── validateNativeReviewTarget ───────────────────────────────────────────

describe("validateNativeReviewTarget", () => {
  test("accepts uncommittedChanges", () => {
    expect(() =>
      validateNativeReviewTarget({ type: "uncommittedChanges" }),
    ).not.toThrow();
  });

  test("accepts baseBranch", () => {
    expect(() =>
      validateNativeReviewTarget({ type: "baseBranch", branch: "main" }),
    ).not.toThrow();
  });

  test("accepts commit", () => {
    expect(() =>
      validateNativeReviewTarget({ type: "commit", sha: "abc123" }),
    ).not.toThrow();
  });

  test("rejects custom", () => {
    expect(() =>
      validateNativeReviewTarget({ type: "custom", instructions: "anything" }),
    ).toThrow("Custom instructions are not compatible with native review mode");
  });
});

// ─── parseStructuredReviewOutput ──────────────────────────────────────────

const VALID_OUTPUT: StructuredReviewOutput = {
  verdict: "needs-attention",
  summary: "Found a potential race condition in the cache layer.",
  findings: [
    {
      severity: "high",
      file: "src/cache.ts",
      lineStart: 42,
      lineEnd: 58,
      confidence: 0.85,
      description: "Cache invalidation is not atomic with the write.",
      recommendation: "Wrap the read-modify-write in a mutex or use compare-and-swap.",
    },
  ],
  nextSteps: ["Add a lock around cache writes", "Add regression test for concurrent access"],
};

describe("parseStructuredReviewOutput", () => {
  test("parses valid bare JSON", () => {
    const raw = JSON.stringify(VALID_OUTPUT);
    const result = parseStructuredReviewOutput(raw);
    expect(result).toEqual(VALID_OUTPUT);
  });

  test("parses JSON in markdown code fence with language tag", () => {
    const raw = `Here is my review:\n\n\`\`\`json\n${JSON.stringify(VALID_OUTPUT, null, 2)}\n\`\`\`\n\nLet me know if you have questions.`;
    const result = parseStructuredReviewOutput(raw);
    expect(result).toEqual(VALID_OUTPUT);
  });

  test("parses JSON in markdown code fence without language tag", () => {
    const raw = `\`\`\`\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\``;
    const result = parseStructuredReviewOutput(raw);
    expect(result).toEqual(VALID_OUTPUT);
  });

  test("parses JSON with surrounding whitespace and prose", () => {
    const raw = `Some preamble text.\n\n${JSON.stringify(VALID_OUTPUT)}\n\nSome trailing text.`;
    const result = parseStructuredReviewOutput(raw);
    expect(result).toEqual(VALID_OUTPUT);
  });

  test("returns null for invalid JSON", () => {
    expect(parseStructuredReviewOutput("not json at all")).toBeNull();
    expect(parseStructuredReviewOutput("{broken json")).toBeNull();
    expect(parseStructuredReviewOutput("```json\n{broken}\n```")).toBeNull();
  });

  test("returns null for missing required fields", () => {
    // Missing verdict
    const noVerdict = { summary: "ok", findings: [], nextSteps: [] };
    expect(parseStructuredReviewOutput(JSON.stringify(noVerdict))).toBeNull();

    // Missing summary
    const noSummary = { verdict: "approve", findings: [], nextSteps: [] };
    expect(parseStructuredReviewOutput(JSON.stringify(noSummary))).toBeNull();

    // Missing findings
    const noFindings = { verdict: "approve", summary: "ok", nextSteps: [] };
    expect(parseStructuredReviewOutput(JSON.stringify(noFindings))).toBeNull();

    // Missing nextSteps
    const noNextSteps = { verdict: "approve", summary: "ok", findings: [] };
    expect(parseStructuredReviewOutput(JSON.stringify(noNextSteps))).toBeNull();
  });

  test("returns null for invalid verdict value", () => {
    const bad = { ...VALID_OUTPUT, verdict: "invalid-verdict" };
    expect(parseStructuredReviewOutput(JSON.stringify(bad))).toBeNull();
  });

  test("returns null for empty summary", () => {
    const bad = { ...VALID_OUTPUT, summary: "" };
    expect(parseStructuredReviewOutput(JSON.stringify(bad))).toBeNull();
  });

  test("validates finding structure", () => {
    // Missing severity
    const noSeverity = {
      ...VALID_OUTPUT,
      findings: [{ file: "a.ts", confidence: 0.5, description: "d", recommendation: "r", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(noSeverity))).toBeNull();

    // Missing file
    const noFile = {
      ...VALID_OUTPUT,
      findings: [{ severity: "high", confidence: 0.5, description: "d", recommendation: "r", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(noFile))).toBeNull();

    // Missing description
    const noDesc = {
      ...VALID_OUTPUT,
      findings: [{ severity: "high", file: "a.ts", confidence: 0.5, recommendation: "r", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(noDesc))).toBeNull();

    // Missing recommendation
    const noRec = {
      ...VALID_OUTPUT,
      findings: [{ severity: "high", file: "a.ts", confidence: 0.5, description: "d", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(noRec))).toBeNull();

    // Missing confidence
    const noConf = {
      ...VALID_OUTPUT,
      findings: [{ severity: "high", file: "a.ts", description: "d", recommendation: "r", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(noConf))).toBeNull();

    // Confidence out of range
    const badConf = {
      ...VALID_OUTPUT,
      findings: [{ severity: "high", file: "a.ts", confidence: 1.5, description: "d", recommendation: "r", lineStart: null, lineEnd: null }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(badConf))).toBeNull();
  });

  test("accepts findings with null lineStart/lineEnd", () => {
    const output: StructuredReviewOutput = {
      ...VALID_OUTPUT,
      findings: [
        {
          severity: "medium",
          file: "src/app.ts",
          lineStart: null,
          lineEnd: null,
          confidence: 0.6,
          description: "General concern.",
          recommendation: "Investigate further.",
        },
      ],
    };
    const result = parseStructuredReviewOutput(JSON.stringify(output));
    expect(result).toEqual(output);
  });

  test("accepts approve verdict with no findings", () => {
    const output: StructuredReviewOutput = {
      verdict: "approve",
      summary: "Change looks safe.",
      findings: [],
      nextSteps: [],
    };
    const result = parseStructuredReviewOutput(JSON.stringify(output));
    expect(result).toEqual(output);
  });

  test("accepts all valid severity levels", () => {
    const severities = ["critical", "high", "medium", "low", "info"] as const;
    for (const severity of severities) {
      const output: StructuredReviewOutput = {
        ...VALID_OUTPUT,
        findings: [{ ...VALID_OUTPUT.findings[0], severity }],
      };
      const result = parseStructuredReviewOutput(JSON.stringify(output));
      expect(result).not.toBeNull();
      expect(result!.findings[0].severity).toBe(severity);
    }
  });

  test("returns null for invalid severity value", () => {
    const bad = {
      ...VALID_OUTPUT,
      findings: [{ ...VALID_OUTPUT.findings[0], severity: "catastrophic" }],
    };
    expect(parseStructuredReviewOutput(JSON.stringify(bad))).toBeNull();
  });
});

// ─── formatReviewOutput ───────────────────────────────────────────────────

describe("formatReviewOutput", () => {
  test("formats approve verdict", () => {
    const output: StructuredReviewOutput = {
      verdict: "approve",
      summary: "No issues found.",
      findings: [],
      nextSteps: [],
    };
    const formatted = formatReviewOutput(output);
    expect(formatted).toContain("Review: approve");
    expect(formatted).toContain("No issues found.");
    expect(formatted).toContain("Findings (0)");
  });

  test("formats findings with line numbers", () => {
    const formatted = formatReviewOutput(VALID_OUTPUT);
    expect(formatted).toContain("Review: needs-attention");
    expect(formatted).toContain("src/cache.ts:42-58");
    expect(formatted).toContain("[high]");
    expect(formatted).toContain("confidence: 0.85");
    expect(formatted).toContain("Cache invalidation is not atomic");
    expect(formatted).toContain("Wrap the read-modify-write");
  });

  test("formats findings without line numbers", () => {
    const output: StructuredReviewOutput = {
      ...VALID_OUTPUT,
      findings: [
        {
          severity: "low",
          file: "README.md",
          lineStart: null,
          lineEnd: null,
          confidence: 0.4,
          description: "Docs are outdated.",
          recommendation: "Update the README.",
        },
      ],
    };
    const formatted = formatReviewOutput(output);
    // Should show just the file name without line range
    expect(formatted).toContain("README.md");
    expect(formatted).not.toContain("README.md:");
  });

  test("formats next steps", () => {
    const formatted = formatReviewOutput(VALID_OUTPUT);
    expect(formatted).toContain("Next Steps:");
    expect(formatted).toContain("- Add a lock around cache writes");
    expect(formatted).toContain("- Add regression test for concurrent access");
  });

  test("omits next steps section when empty", () => {
    const output: StructuredReviewOutput = {
      ...VALID_OUTPUT,
      nextSteps: [],
    };
    const formatted = formatReviewOutput(output);
    expect(formatted).not.toContain("Next Steps:");
  });

  test("formats request-changes verdict", () => {
    const output: StructuredReviewOutput = {
      verdict: "request-changes",
      summary: "Critical security flaw.",
      findings: [
        {
          severity: "critical",
          file: "src/auth.ts",
          lineStart: 10,
          lineEnd: 10,
          confidence: 0.95,
          description: "SQL injection vulnerability.",
          recommendation: "Use parameterized queries.",
        },
      ],
      nextSteps: ["Fix the SQL injection"],
    };
    const formatted = formatReviewOutput(output);
    expect(formatted).toContain("Review: request-changes");
    expect(formatted).toContain("[critical]");
    expect(formatted).toContain("src/auth.ts:10-10");
  });
});
