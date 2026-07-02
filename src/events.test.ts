import { describe, expect, test, beforeEach } from "bun:test";
import { EventDispatcher } from "./events";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_LOG_DIR = join(tmpdir(), "codex-collab-test-logs");

beforeEach(() => {
  if (existsSync(TEST_LOG_DIR)) rmSync(TEST_LOG_DIR, { recursive: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

describe("EventDispatcher", () => {
  test("accumulates agent message deltas", () => {
    const dispatcher = new EventDispatcher("test1", TEST_LOG_DIR);
    dispatcher.handleDelta("item/agentMessage/delta", {
      threadId: "t1", turnId: "turn1", itemId: "item1", delta: "Hello ",
    });
    dispatcher.handleDelta("item/agentMessage/delta", {
      threadId: "t1", turnId: "turn1", itemId: "item1", delta: "world",
    });
    expect(dispatcher.getAccumulatedOutput()).toBe("Hello world");
  });

  test("formats progress line for command execution", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test2", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleItemStarted({
      item: { type: "commandExecution", id: "i1", command: "npm test", cwd: "/proj", status: "inProgress", processId: null, commandActions: [] },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Running: npm test");
  });

  test("formats progress line for file change", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test3", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleItemCompleted({
      item: {
        type: "fileChange",
        id: "i1",
        changes: [{ path: "src/auth.ts", kind: { type: "update", move_path: null }, diff: "+15,-3" }],
        status: "completed",
      },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("src/auth.ts");
  });

  test("writes events to log file", () => {
    const dispatcher = new EventDispatcher("test4", TEST_LOG_DIR);
    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: "echo hello", cwd: "/tmp",
        status: "completed", exitCode: 0, durationMs: 100, processId: null, commandActions: [],
      },
      threadId: "t1",
      turnId: "turn1",
    });
    dispatcher.flush();

    const logPath = join(TEST_LOG_DIR, "test4.log");
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("echo hello");
  });

  test("captures review output from exitedReviewMode item/completed", () => {
    const dispatcher = new EventDispatcher("test-review", TEST_LOG_DIR);

    dispatcher.handleItemCompleted({
      item: { type: "exitedReviewMode", id: "review-1", review: "Code looks great" },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(dispatcher.getAccumulatedOutput()).toBe("Code looks great");
  });

  test("review output survives a terminal final_answer sign-off", () => {
    // Real reviews end with both the structured review (an exitedReviewMode
    // item carrying the full body) AND a short final_answer agentMessage
    // ("Bottom line: …"). Pre-fix, getTurnOutput() preferred the short
    // final_answer over the full review — the entire review body was dropped
    // from TurnResult.output (and thus from the run-ledger output field and
    // the CLI's stdout under --content-only). The full review must win.
    const dispatcher = new EventDispatcher("test-review-finalanswer", TEST_LOG_DIR);
    const fullReview = Array.from({ length: 40 }, (_, i) =>
      `Finding ${i + 1}: detailed substantive review content.`).join("\n");

    dispatcher.handleItemCompleted({
      item: { type: "exitedReviewMode", id: "review-1", review: fullReview },
      threadId: "t1",
      turnId: "turn1",
    });
    dispatcher.handleItemCompleted({
      item: { type: "agentMessage", id: "fa-1", phase: "final_answer", text: "Bottom line: looks good overall." },
      threadId: "t1",
      turnId: "turn1",
    });

    const output = dispatcher.getTurnOutput();
    expect(output).toContain("Finding 20");
    expect(output.length).toBeGreaterThanOrEqual(fullReview.length);
  });

  test("handles mid-turn error notifications", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-error", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleError({
      error: { message: "Rate limit exceeded" },
      willRetry: true,
      threadId: "t1",
      turnId: "turn1",
    });

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("Rate limit exceeded");
    expect(lines[0]).toContain("will retry");
  });

  test("does not count declined command in commandsRun", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-declined-cmd", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: "rm -rf /",
        cwd: "/proj", status: "declined", processId: null, commandActions: [],
      },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(dispatcher.getCommandsRun()).toHaveLength(0);
    expect(lines.some(l => l.includes("declined"))).toBe(true);
  });

  test("does not count failed file change in filesChanged", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-failed-fc", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleItemCompleted({
      item: {
        type: "fileChange", id: "i1",
        changes: [{ path: "src/secret.ts", kind: { type: "update", move_path: null }, diff: "" }],
        status: "failed",
      },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(dispatcher.getFilesChanged()).toHaveLength(0);
    expect(lines.some(l => l.includes("failed"))).toBe(true);
    expect(lines.some(l => l.includes("src/secret.ts"))).toBe(true);
  });

  test("progress events auto-flush to log file", () => {
    const dispatcher = new EventDispatcher("test-autoflush", TEST_LOG_DIR);
    const logPath = join(TEST_LOG_DIR, "test-autoflush.log");

    // Trigger a progress event (command started) — should auto-flush without explicit flush() call
    dispatcher.handleItemStarted({
      item: { type: "commandExecution", id: "i1", command: "echo flush-test", cwd: "/proj", status: "inProgress", processId: null, commandActions: [] },
      threadId: "t1",
      turnId: "turn1",
    });

    // Log file should exist immediately due to auto-flush in progress()
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("echo flush-test");
  });

  test("collects file changes and commands", () => {
    const dispatcher = new EventDispatcher("test5", TEST_LOG_DIR);

    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: "npm test", cwd: "/proj",
        status: "completed", exitCode: 0, durationMs: 4200, processId: null, commandActions: [],
      },
      threadId: "t1",
      turnId: "turn1",
    });

    dispatcher.handleItemCompleted({
      item: {
        type: "fileChange", id: "i2",
        changes: [{ path: "src/auth.ts", kind: { type: "update", move_path: null }, diff: "" }],
        status: "completed",
      },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(dispatcher.getCommandsRun()).toHaveLength(1);
    expect(dispatcher.getFilesChanged()).toHaveLength(1);
  });
});

describe("Guardian auto-approval review events", () => {
  test("started event renders a progress line with the command", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian1", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/started", {
      threadId: "t1", turnId: "turn1", itemId: "i1", command: "touch /tmp/file",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian reviewing");
    expect(lines[0]).toContain("touch /tmp/file");
  });

  test("completed event renders the decision", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian2", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", itemId: "i1", decision: "approved", command: "touch /tmp/file",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian approved");
    expect(lines[0]).toContain("touch /tmp/file");
  });

  test("observed 0.142 shape: action.command + review.status/riskLevel", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian-live", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/started", {
      threadId: "t1", turnId: "turn1", reviewId: "r1", targetItemId: "call_1",
      review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null },
      action: { type: "command", source: "unifiedExec", command: "/bin/zsh -lc 'touch canary.txt'", cwd: "/tmp" },
    });
    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", reviewId: "r1", targetItemId: "call_1", decisionSource: "agent",
      review: { status: "approved", riskLevel: "low", userAuthorization: "unknown", rationale: "Auto-review returned a low-risk allow decision." },
      action: { type: "command", source: "unifiedExec", command: "/bin/zsh -lc 'touch canary.txt'", cwd: "/tmp" },
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Guardian reviewing approval request: /bin/zsh -lc 'touch canary.txt'");
    expect(lines[1]).toBe("Guardian approved (low risk): /bin/zsh -lc 'touch canary.txt'");
  });

  test("enum-shaped decision objects use their type discriminant", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian3", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      decision: { type: "rejected" },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian rejected");
  });

  test("degrades to a generic line on an unrecognized payload (UNSTABLE protocol)", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("guardian4", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/started", {});
    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {});

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Guardian reviewing approval request");
    expect(lines[1]).toContain("Guardian review completed");
  });

  test("full payload is written to the log for auditability", () => {
    const dispatcher = new EventDispatcher("guardian5", TEST_LOG_DIR);
    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      decision: "approved", command: "rm -rf node_modules",
    });
    dispatcher.flush();

    const log = readFileSync(join(TEST_LOG_DIR, "guardian5.log"), "utf-8");
    expect(log).toContain("guardian review completed");
    expect(log).toContain("rm -rf node_modules");
  });
});
