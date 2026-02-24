import { describe, expect, test, beforeEach } from "bun:test";
import { EventDispatcher } from "./events";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";

const TEST_LOG_DIR = `${process.env.TMPDIR || "/tmp/claude-1000"}/codex-collab-test-logs`;

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

    const logPath = `${TEST_LOG_DIR}/test4.log`;
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
    const logPath = `${TEST_LOG_DIR}/test-autoflush.log`;

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
