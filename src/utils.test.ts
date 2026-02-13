// Unit tests for pure utility functions (no tmux needed)

import { describe, it, expect } from "bun:test";
import {
  stripAnsiCodes,
  extractContent,
  wrapLine,
  formatDuration,
  processOutput,
} from "./utils.ts";

// ---------------------------------------------------------------------------
// stripAnsiCodes
// ---------------------------------------------------------------------------

describe("stripAnsiCodes", () => {
  it("removes ANSI color escape codes", () => {
    expect(stripAnsiCodes("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes SGR codes with multiple parameters", () => {
    expect(stripAnsiCodes("\x1b[1;32;40mbold green\x1b[0m")).toBe("bold green");
  });

  it("removes OSC sequences (e.g. terminal title)", () => {
    expect(stripAnsiCodes("\x1b]0;title\x07content")).toBe("content");
  });

  it("removes carriage returns", () => {
    expect(stripAnsiCodes("line1\r\nline2")).toBe("line1\nline2");
  });

  it("removes control characters (\\x00-\\x08, \\x0b, \\x0c, \\x0e-\\x1f)", () => {
    expect(stripAnsiCodes("a\x01b\x02c\x0bd")).toBe("abcd");
  });

  it("preserves newlines and tabs", () => {
    // \n = 0x0a, \t = 0x09 — both should survive
    expect(stripAnsiCodes("a\tb\nc")).toBe("a\tb\nc");
  });

  it("passes through clean text unchanged", () => {
    const clean = "Hello, world! 123";
    expect(stripAnsiCodes(clean)).toBe(clean);
  });

  it("handles combined ANSI + OSC + control chars", () => {
    const messy = "\x1b[1m\x1b]0;t\x07H\x01e\rllo\x1b[0m";
    expect(stripAnsiCodes(messy)).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// extractContent
// ---------------------------------------------------------------------------

describe("extractContent", () => {
  it("strips banner block (╭ through ╰)", () => {
    const input = [
      "╭─ OpenAI Codex ─╮",
      "│ model: gpt-5    │",
      "╰─────────────────╯",
      "Actual content here",
    ].join("\n");
    expect(extractContent(input, 120)).toBe("Actual content here");
  });

  it("strips tip lines and their continuations", () => {
    const input = [
      "Tip: You can use /review for code review",
      "  and it supports multiple modes",
      "Content after tip",
    ].join("\n");
    expect(extractContent(input, 120)).toBe("Content after tip");
  });

  it("stops skipping tip continuation at content markers", () => {
    const input = [
      "Tip: some tip text",
      "  continuation line",
      "› prompt line",
      "Real content",
    ].join("\n");
    // "› prompt line" triggers inTip=false and is kept (not trailing)
    expect(extractContent(input, 120)).toBe("› prompt line\nReal content");
  });

  it("strips shortcuts/context line", () => {
    const input = [
      "Some content",
      "? for shortcuts  85% context left",
      "More content",
    ].join("\n");
    expect(extractContent(input, 120)).toBe("Some content\nMore content");
  });

  it("removes trailing idle prompt (›) and blank lines", () => {
    const input = [
      "Content",
      "",
      "  ›",
      "",
    ].join("\n");
    expect(extractContent(input, 120)).toBe("Content");
  });

  it("removes leading blank lines", () => {
    const input = "\n\n\nContent\n";
    expect(extractContent(input, 120)).toBe("Content");
  });

  it("passes through clean content unchanged", () => {
    const input = "Line 1\nLine 2\nLine 3";
    expect(extractContent(input, 120)).toBe(input);
  });

  it("handles a full TUI-like output", () => {
    const input = [
      "╭─────────────────────╮",
      "│  OpenAI Codex gpt-5 │",
      "╰─────────────────────╯",
      "Tip: Use /review for reviews",
      "  continuation of tip",
      "",
      "? for shortcuts  42% context left",
      "",
      "Here is my analysis of the code:",
      "The function does X and Y.",
      "",
      "  ›",
      "",
    ].join("\n");
    expect(extractContent(input, 120)).toBe(
      "Here is my analysis of the code:\nThe function does X and Y."
    );
  });
});

// ---------------------------------------------------------------------------
// wrapLine
// ---------------------------------------------------------------------------

describe("wrapLine", () => {
  it("returns short lines unchanged", () => {
    expect(wrapLine("short line", 80)).toBe("short line");
  });

  it("wraps long lines at word boundaries", () => {
    const line = "word1 word2 word3 word4 word5";
    const wrapped = wrapLine(line, 15);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(15);
    }
  });

  it("preserves leading indentation on wrapped lines", () => {
    const line = "    indented word1 word2 word3 word4 word5";
    const wrapped = wrapLine(line, 20);
    const lines = wrapped.split("\n");
    for (const l of lines) {
      expect(l).toMatch(/^    /);
    }
  });

  it("does not wrap structural/box-drawing lines", () => {
    const line = "│ this is a very long box drawing line that exceeds the width limit significantly";
    expect(wrapLine(line, 30)).toBe(line);
  });

  it("does not wrap lines starting with tree connectors", () => {
    const line = "└── very long tree line that goes beyond the wrap width by a lot of characters";
    expect(wrapLine(line, 30)).toBe(line);
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("formats hours and minutes", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("formats seconds only", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats sub-second as 0s", () => {
    expect(formatDuration(500)).toBe("0s");
  });

  it("formats exact hours", () => {
    expect(formatDuration(7_200_000)).toBe("2h 0m");
  });

  it("formats exact minutes", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });
});

// ---------------------------------------------------------------------------
// processOutput
// ---------------------------------------------------------------------------

describe("processOutput", () => {
  it("returns raw output when no flags set", () => {
    const output = "\x1b[31mred\x1b[0m text";
    expect(processOutput(output, { contentOnly: false, stripAnsi: false })).toBe(output);
  });

  it("strips ANSI when stripAnsi is true", () => {
    expect(processOutput("\x1b[31mred\x1b[0m", { contentOnly: false, stripAnsi: true })).toBe("red");
  });

  it("strips TUI chrome and ANSI when contentOnly is true", () => {
    const input = [
      "╭─ banner ─╮",
      "│ stuff     │",
      "╰───────────╯",
      "\x1b[32mContent\x1b[0m",
    ].join("\n");
    expect(processOutput(input, { contentOnly: true, stripAnsi: false })).toBe("Content");
  });

  it("contentOnly takes priority over stripAnsi", () => {
    // Both flags set — contentOnly path runs extractContent(stripAnsiCodes(output))
    const input = "\x1b[31m╭─╮\n│x│\n╰─╯\nReal\x1b[0m";
    const result = processOutput(input, { contentOnly: true, stripAnsi: true });
    expect(result).toBe("Real");
  });
});
