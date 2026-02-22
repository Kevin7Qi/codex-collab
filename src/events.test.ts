import { describe, expect, test, beforeEach } from "bun:test";
import { EventDispatcher } from "./events";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";

const TEST_LOG_DIR = `${process.env.TMPDIR || "/tmp"}/codex-collab-test-logs`;

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
      item: { type: "commandExecution", id: "i1", command: "npm test", cwd: "/proj", status: "inProgress" },
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
        changes: [{ path: "src/auth.ts", kind: { type: "update" }, diff: "+15,-3" }],
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
        status: "completed", exitCode: 0, durationMs: 100,
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

  test("collects file changes and commands", () => {
    const dispatcher = new EventDispatcher("test5", TEST_LOG_DIR);

    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: "npm test", cwd: "/proj",
        status: "completed", exitCode: 0, durationMs: 4200,
      },
      threadId: "t1",
      turnId: "turn1",
    });

    dispatcher.handleItemCompleted({
      item: {
        type: "fileChange", id: "i2",
        changes: [{ path: "src/auth.ts", kind: { type: "update" }, diff: "" }],
        status: "completed",
      },
      threadId: "t1",
      turnId: "turn1",
    });

    expect(dispatcher.getCommandsRun()).toHaveLength(1);
    expect(dispatcher.getFilesChanged()).toHaveLength(1);
  });
});
