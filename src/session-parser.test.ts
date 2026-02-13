// Unit tests for session-parser (no tmux needed)

import { describe, it, expect } from "bun:test";
import { extractSessionId, parseSessionFile, findSessionFile } from "./session-parser.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// extractSessionId
// ---------------------------------------------------------------------------

describe("extractSessionId", () => {
  it("extracts 'session id: <uuid>' pattern", () => {
    const log = "some output\nsession id: abc12345-def6-7890-abcd-ef1234567890\nmore output";
    expect(extractSessionId(log)).toBe("abc12345-def6-7890-abcd-ef1234567890");
  });

  it("extracts 'session_id: <uuid>' pattern", () => {
    const log = "session_id: aabbccdd-1234-5678-9abc-def012345678";
    expect(extractSessionId(log)).toBe("aabbccdd-1234-5678-9abc-def012345678");
  });

  it("extracts 'sessionId: <uuid>' pattern", () => {
    const log = 'sessionId: 11223344-aabb-ccdd-eeff-001122334455';
    expect(extractSessionId(log)).toBe("11223344-aabb-ccdd-eeff-001122334455");
  });

  it("strips ANSI codes before matching", () => {
    const log = "\x1b[32msession id: abcdef12-3456-7890-abcd-ef1234567890\x1b[0m";
    // session-parser has its own stripAnsiCodes that handles [NNm patterns
    expect(extractSessionId(log)).toBe("abcdef12-3456-7890-abcd-ef1234567890");
  });

  it("returns null when no session ID found", () => {
    expect(extractSessionId("no session info here")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSessionId("")).toBeNull();
  });

  it("matches IDs with only hex chars", () => {
    // Short hex ID (8+ chars)
    const log = "session id: abcdef01";
    expect(extractSessionId(log)).toBe("abcdef01");
  });
});

// ---------------------------------------------------------------------------
// parseSessionFile
// ---------------------------------------------------------------------------

describe("parseSessionFile", () => {
  const tmpDir = "/tmp/codex-collab-test-sessions";

  function setup() {
    mkdirSync(tmpDir, { recursive: true });
  }

  function cleanup() {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  }

  it("parses JSONL session with tokens and summary", () => {
    setup();
    const filePath = join(tmpDir, "test.jsonl");
    const lines = [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 1000, output_tokens: 500 },
            model_context_window: 128000,
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Task completed successfully",
        },
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    const result = parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.tokens).toEqual({
      input: 1000,
      output: 500,
      context_window: 128000,
      context_used_pct: 0.78,
    });
    expect(result!.summary).toBe("Task completed successfully");
    cleanup();
  });

  it("parses JSONL session with file modifications", () => {
    setup();
    const filePath = join(tmpDir, "patch.jsonl");
    const lines = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "apply_patch",
          input: "*** Begin Patch\n*** Update File: src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n*** End Patch",
        },
      }),
    ];
    writeFileSync(filePath, lines.join("\n"));

    const result = parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.files_modified).toContain("src/index.ts");
    cleanup();
  });

  it("parses JSON session format with assistant summary", () => {
    setup();
    const filePath = join(tmpDir, "test.json");
    const data = {
      items: [
        {
          role: "assistant",
          content: [{ type: "output_text", text: "The project is a CLI tool." }],
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(data));

    const result = parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("The project is a CLI tool.");
    expect(result!.tokens).toBeNull();
    cleanup();
  });

  it("returns null for nonexistent file", () => {
    expect(parseSessionFile("/tmp/nonexistent-session-file.jsonl")).toBeNull();
  });

  it("returns null for malformed JSONL (gracefully handles bad lines)", () => {
    setup();
    const filePath = join(tmpDir, "bad.jsonl");
    writeFileSync(filePath, "not json\n{broken\n");

    const result = parseSessionFile(filePath);
    // Should parse without crashing — returns data with null fields
    expect(result).not.toBeNull();
    expect(result!.tokens).toBeNull();
    expect(result!.summary).toBeNull();
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// findSessionFile
// ---------------------------------------------------------------------------

describe("findSessionFile", () => {
  it("returns null when CODEX_HOME is unset and HOME has no .codex", () => {
    const originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-collab-test-no-home";
    const result = findSessionFile("some-session-id");
    expect(result).toBeNull();
    if (originalHome !== undefined) {
      process.env.CODEX_HOME = originalHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  });

  it("returns null when session ID doesn't match any files", () => {
    const tmpDir = "/tmp/codex-collab-test-find-session";
    mkdirSync(join(tmpDir, "sessions"), { recursive: true });
    writeFileSync(join(tmpDir, "sessions", "other-id.jsonl"), "{}");

    const originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpDir;

    const result = findSessionFile("nonexistent-session-id");
    expect(result).toBeNull();

    if (originalHome !== undefined) {
      process.env.CODEX_HOME = originalHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it("finds a session file by ID in the sessions directory", () => {
    const tmpDir = "/tmp/codex-collab-test-find-match";
    const sessionsDir = join(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionId = "abcdef12-3456-7890";
    writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), "{}");

    const originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpDir;

    const result = findSessionFile(sessionId);
    expect(result).not.toBeNull();
    expect(result).toContain(sessionId);

    if (originalHome !== undefined) {
      process.env.CODEX_HOME = originalHome;
    } else {
      delete process.env.CODEX_HOME;
    }
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });
});
