import { describe, expect, test, beforeEach } from "bun:test";
import { EventDispatcher, inferPhaseFromLog } from "./events";
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

describe("phase dedup", () => {
  test("emits first progress for a phase", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-phase1", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.emitProgress("Starting thread abc", { phase: "starting", threadId: "t1" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Starting thread abc");
  });

  test("skips consecutive same phase for same thread", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-phase2", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.emitProgress("Starting thread abc", { phase: "starting", threadId: "t1" });
    dispatcher.emitProgress("Starting another thing", { phase: "starting", threadId: "t1" });

    expect(lines).toHaveLength(1);
  });

  test("emits when phase changes", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-phase3", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.emitProgress("Starting thread", { phase: "starting", threadId: "t1" });
    dispatcher.emitProgress("Editing files", { phase: "editing", threadId: "t1" });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Starting thread");
    expect(lines[1]).toContain("Editing files");
  });

  test("different threads are tracked independently", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-phase4", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.emitProgress("Starting thread", { phase: "starting", threadId: "t1" });
    dispatcher.emitProgress("Starting thread", { phase: "starting", threadId: "t2" });

    expect(lines).toHaveLength(2);
  });

  test("emits without dedup when no phase/threadId provided", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher("test-phase5", TEST_LOG_DIR, (line) => lines.push(line));

    dispatcher.emitProgress("Some progress line");
    dispatcher.emitProgress("Some progress line");

    expect(lines).toHaveLength(2);
  });
});

describe("inferPhaseFromLog", () => {
  test("infers starting", () => {
    expect(inferPhaseFromLog("[codex] Starting thread")).toBe("starting");
    expect(inferPhaseFromLog("[codex] Thread abc started")).toBe("starting");
  });

  test("infers reviewing", () => {
    expect(inferPhaseFromLog("[codex] Reviewing changes")).toBe("reviewing");
    expect(inferPhaseFromLog("[codex] Code review in progress")).toBe("reviewing");
  });

  test("infers editing", () => {
    expect(inferPhaseFromLog("[codex] Editing src/foo.ts")).toBe("editing");
    expect(inferPhaseFromLog("[codex] File edited successfully")).toBe("editing");
  });

  test("infers verifying", () => {
    expect(inferPhaseFromLog("[codex] Verifying output")).toBe("verifying");
    expect(inferPhaseFromLog("[codex] Checking results")).toBe("verifying");
  });

  test("infers running", () => {
    expect(inferPhaseFromLog("[codex] Running: npm test")).toBe("running");
    expect(inferPhaseFromLog("[codex] Executing command")).toBe("running");
    expect(inferPhaseFromLog("[codex] Execute build step")).toBe("running");
  });

  test("infers investigating", () => {
    expect(inferPhaseFromLog("[codex] Investigating error")).toBe("investigating");
    expect(inferPhaseFromLog("[codex] Investigate the root cause")).toBe("investigating");
  });

  test("infers finalizing", () => {
    expect(inferPhaseFromLog("[codex] Turn completed")).toBe("finalizing");
    expect(inferPhaseFromLog("[codex] Finalizing output")).toBe("finalizing");
    expect(inferPhaseFromLog("[codex] Task complete")).toBe("finalizing");
  });

  test("returns null for unrecognized lines", () => {
    expect(inferPhaseFromLog("[codex] some random output")).toBeNull();
    expect(inferPhaseFromLog("")).toBeNull();
  });
});
