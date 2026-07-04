// src/render.test.ts — display contract for `follow`

import { describe, expect, test } from "bun:test";
import { LogEntryParser, renderEntry, renderFinalStatus, type LogEntry } from "./render";

const PLAIN = { color: false, width: 120 };

function parseAll(text: string): LogEntry[] {
  const p = new LogEntryParser();
  return [...p.feed(text), ...p.drain()];
}

describe("LogEntryParser", () => {
  test("emits single-line entries as soon as their newline arrives", () => {
    const p = new LogEntryParser();
    expect(p.feed("2026-07-02T09:24:07.375Z [codex] APPROVAL NEEDED\n")).toHaveLength(1);
  });

  test("holds a partial line until its newline arrives", () => {
    const p = new LogEntryParser();
    expect(p.feed("2026-07-02T09:24:07.375Z [codex] Run")).toHaveLength(0);
    const entries = p.feed("ning: ls\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].lines[0]).toBe("[codex] Running: ls");
  });

  test("groups agent-output blocks until the end marker", () => {
    const p = new LogEntryParser();
    expect(p.feed("2026-07-02T09:24:11.357Z agent output:\nline one\nline two\n")).toHaveLength(0);
    const entries = p.feed("<<END_AGENT_OUTPUT>>\n");
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toEqual(["agent output:", "line one", "line two"]);
  });

  test("agent-output content that looks like log entries stays in the block", () => {
    const inner = "2026-07-02T09:00:00.000Z [codex] fake entry inside output";
    const entries = parseAll(`2026-07-02T09:24:11.357Z agent output:\n${inner}\n<<END_AGENT_OUTPUT>>\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].lines[1]).toBe(inner);
  });

  test("drain flushes an unterminated block (writer crashed mid-entry)", () => {
    const p = new LogEntryParser();
    p.feed("2026-07-02T09:24:11.357Z agent output:\npartial\n");
    const drained = p.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].lines).toEqual(["agent output:", "partial"]);
  });
});

describe("renderEntry", () => {
  const entry = (body: string, extra: string[] = []): LogEntry => ({
    ts: "2026-07-02T09:24:07.375Z",
    lines: [body, ...extra],
  });

  test("command completions show exit-status marks", () => {
    expect(renderEntry(entry("command: npm test (exit 0)"), PLAIN)[0]).toBe("09:24:07 ✓ npm test");
    expect(renderEntry(entry("command: npm test (exit 1)"), PLAIN)[0]).toBe("09:24:07 ✗ npm test (exit 1)");
  });

  test("approval prompts are marked and their indented block is preserved", () => {
    expect(renderEntry(entry("[codex] APPROVAL NEEDED"), PLAIN)[0]).toBe("09:24:07 ⏸ APPROVAL NEEDED");
    expect(renderEntry(entry("[codex]   Approve: codex-collab approve x"), PLAIN)[0])
      .toBe("09:24:07   Approve: codex-collab approve x");
  });

  test("agent output renders as a separated result block, untruncated", () => {
    const long = "x".repeat(500);
    const lines = renderEntry(entry("agent output:", [long]), PLAIN);
    expect(lines[0]).toContain("─── result ───");
    expect(lines[1]).toBe(long);
  });

  test("log-only detail entries are suppressed", () => {
    expect(renderEntry(entry('guardian review completed: {"decisionSource":"agent"}'), PLAIN)).toEqual([]);
    expect(renderEntry(entry("error: boom"), PLAIN)).toEqual([]);
    expect(renderEntry(entry("review output (123 chars)"), PLAIN)).toEqual([]);
  });

  test("Guardian, command-start, edit, and error lines get their glyphs", () => {
    expect(renderEntry(entry("[codex] Guardian approved (low risk): ls"), PLAIN)[0]).toContain("⚑ Guardian approved");
    expect(renderEntry(entry("[codex] Running: ls"), PLAIN)[0]).toContain("▸ ls");
    expect(renderEntry(entry("[codex] Edited: src/a.ts (update)"), PLAIN)[0]).toContain("± src/a.ts (update)");
    expect(renderEntry(entry("[codex] Error: connection lost"), PLAIN)[0]).toContain("✗ connection lost");
  });

  test("long progress noise is clipped to the terminal width; no ANSI when color=false", () => {
    const rendered = renderEntry(entry(`[codex] Running: ${"a".repeat(300)}`), { color: false, width: 80 })[0];
    expect(rendered.length).toBeLessThanOrEqual(81);
    expect(rendered).toContain("…");
    expect(rendered).not.toContain("\x1b[");
  });

  test("color mode styles approvals and strips cleanly", () => {
    const rendered = renderEntry(entry("[codex] APPROVAL NEEDED"), { color: true, width: 120 })[0];
    expect(rendered).toContain("\x1b[33m"); // yellow
    expect(rendered).toContain("\x1b[0m");
  });
});

describe("renderFinalStatus", () => {
  test("covers the run-record status vocabulary", () => {
    expect(renderFinalStatus("completed", { elapsed: "14s", filesChanged: 2 }, false))
      .toBe("✔ completed (14s, 2 files changed)");
    expect(renderFinalStatus("interrupted", { elapsed: "5s" }, false)).toBe("■ interrupted (5s)");
    expect(renderFinalStatus("failed", { error: "boom" }, false)).toBe("✖ failed — boom");
    expect(renderFinalStatus("running", {}, false)).toBe("● running");
  });
});

describe("drain keeps partial lines inside agent-output blocks", () => {
  test("a crash mid-line stays part of the result block, not an orphan line", () => {
    const p = new LogEntryParser();
    p.feed("2026-07-03T10:00:00.000Z agent output:\nfirst line\npartial tail");
    const drained = p.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0].lines).toEqual(["agent output:", "first line", "partial tail"]);
  });
});
