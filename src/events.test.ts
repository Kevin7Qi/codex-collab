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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test1.log"));
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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test2.log"), (line) => lines.push(line));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test3.log"), (line) => lines.push(line));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test4.log"));
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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-review.log"));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-review-finalanswer.log"));
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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-error.log"), (line) => lines.push(line));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-declined-cmd.log"), (line) => lines.push(line));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-failed-fc.log"), (line) => lines.push(line));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test-autoflush.log"));
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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "test5.log"));

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
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian1.log"), (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/started", {
      threadId: "t1", turnId: "turn1", itemId: "i1", command: "touch /tmp/file",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian reviewing");
    expect(lines[0]).toContain("touch /tmp/file");
  });

  test("completed event renders the decision", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian2.log"), (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", itemId: "i1", decision: "approved", command: "touch /tmp/file",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian approved");
    expect(lines[0]).toContain("touch /tmp/file");
  });

  test("observed 0.142 shape: action.command + review.status/riskLevel", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian-live.log"), (line) => lines.push(line));

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

  test("denied review is persisted for override when guardianDir is set", () => {
    const lines: string[] = [];
    const guardianDir = join(TEST_LOG_DIR, "guardian");
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian-deny.log"), (line) => lines.push(line), guardianDir);

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", reviewId: "rev-denied-1", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: "out of scope" },
      action: { type: "command", source: "shell", command: "rm -rf /tmp/y", cwd: "/tmp" },
    });

    const persisted = JSON.parse(readFileSync(join(guardianDir, "rev-denied-1.json"), "utf8"));
    expect(persisted.reviewId).toBe("rev-denied-1");
    expect(persisted.threadId).toBe("t1");
    expect(lines.some((l) => l.includes("approve --guardian rev-deni"))).toBe(true);
  });

  test("approvals and denials without guardianDir are not persisted", () => {
    const guardianDir = join(TEST_LOG_DIR, "guardian");
    const withDir = new EventDispatcher(join(TEST_LOG_DIR, "guardian-ok.log"), () => {}, guardianDir);
    withDir.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", reviewId: "rev-approved-1",
      review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: null },
      action: { type: "command", source: "shell", command: "ls", cwd: "/tmp" },
    });
    expect(existsSync(join(guardianDir, "rev-approved-1.json"))).toBe(false);

    const withoutDir = new EventDispatcher(join(TEST_LOG_DIR, "guardian-nodir.log"), () => {});
    withoutDir.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      threadId: "t1", turnId: "turn1", reviewId: "rev-denied-2",
      review: { status: "denied", riskLevel: "high", userAuthorization: "low", rationale: null },
      action: { type: "command", source: "shell", command: "ls", cwd: "/tmp" },
    });
    expect(existsSync(join(guardianDir, "rev-denied-2.json"))).toBe(false);
  });

  test("enum-shaped decision objects use their type discriminant", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian3.log"), (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      decision: { type: "rejected" },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian rejected");
  });

  test("degrades to a generic line on an unrecognized payload (UNSTABLE protocol)", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian4.log"), (line) => lines.push(line));

    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/started", {});
    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {});

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Guardian reviewing approval request");
    expect(lines[1]).toContain("Guardian review completed");
  });

  test("full payload is written to the log for auditability", () => {
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "guardian5.log"));
    dispatcher.handleAutoApprovalReview("item/autoApprovalReview/completed", {
      decision: "approved", command: "rm -rf node_modules",
    });
    dispatcher.flush();

    const log = readFileSync(join(TEST_LOG_DIR, "guardian5.log"), "utf-8");
    expect(log).toContain("guardian review completed");
    expect(log).toContain("rm -rf node_modules");
  });
});

describe("guardianWarning", () => {
  test("renders the warning message as a Guardian progress line", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "gw1.log"), (line) => lines.push(line));

    dispatcher.handleGuardianWarning({
      message: "Automatic approval review approved (risk: medium, authorization: high): persistent modification to /etc/hosts.",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Guardian warning: Automatic approval review approved (risk: medium, authorization: high): persistent modification to /etc/hosts.");
  });

  test("degrades gracefully when the UNSTABLE payload has no message", () => {
    const lines: string[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "gw2.log"), (line) => lines.push(line));
    dispatcher.handleGuardianWarning({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Guardian issued a warning");
  });
});

describe("ask-channel marker stream", () => {
  const { markerPosted, markerAnswered, markerExpired, writeQuestion, generateQuestionId } =
    require("./questions") as typeof import("./questions");

  function mailboxWithQuestion(name: string, id: string, question: string) {
    const mailboxDir = join(TEST_LOG_DIR, name);
    mkdirSync(mailboxDir, { recursive: true });
    writeQuestion(mailboxDir, {
      id,
      question,
      askedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/ws",
      pid: process.pid,
    });
    return mailboxDir;
  }

  function armedDispatcher(name: string, mailboxDir: string) {
    const pendings: unknown[] = [];
    const resolveds: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, `${name}.log`), () => {});
    dispatcher.setQuestionContext({
      mailboxDir,
      workspaceDir: "/tmp/ws",
      onPending: (p) => pendings.push(p),
      onResolved: (r) => resolveds.push(r),
    });
    return { dispatcher, pendings, resolveds };
  }

  const delta = (dispatcher: EventDispatcher, text: string) =>
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1", delta: text,
    });

  // Marker parsing is gated to registered ask command items (spoofing
  // guard), so tests must start an ask item before streaming its deltas.
  const startAsk = (dispatcher: EventDispatcher, itemId = "i1") =>
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: itemId, command: `/bin/zsh -lc 'codex-collab ask "q"'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });

  test("posted marker split across delta chunks fires onPending with the summary", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-split", id, "Drop FKs or dual-write?\nContext here.");
    const { dispatcher, pendings } = armedDispatcher("ask1", mailboxDir);
    startAsk(dispatcher);

    const marker = markerPosted(id, 600) + "\n";
    delta(dispatcher, marker.slice(0, 20));
    expect(pendings).toHaveLength(0); // line not complete yet
    delta(dispatcher, marker.slice(20));

    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ id, summary: "Drop FKs or dual-write?" });
    dispatcher.reset();
  });

  test("answered marker clears pending and records latency", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-ans", id, "Which approach?");
    const { dispatcher, pendings, resolveds } = armedDispatcher("ask2", mailboxDir);
    startAsk(dispatcher);

    delta(dispatcher, markerPosted(id, 600) + "\n" + markerAnswered(id, 161) + "\n");

    expect(pendings).toEqual([
      expect.objectContaining({ id }),
      null,
    ]);
    expect(resolveds).toEqual([
      { id, summary: "Which approach?", outcome: "answered", latencyMs: 161_000 },
    ]);
  });

  test("expired marker resolves with outcome expired and no latency", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-exp", id, "Anyone there?");
    const { dispatcher, resolveds } = armedDispatcher("ask3", mailboxDir);
    startAsk(dispatcher);

    delta(dispatcher, markerPosted(id, 60) + "\n" + markerExpired(id, 60) + "\n");

    expect(resolveds).toEqual([
      { id, summary: "Anyone there?", outcome: "expired" },
    ]);
  });

  test("aggregatedOutput fallback dedupes against the delta path", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-dedupe", id, "Steer me?");
    const { dispatcher, pendings, resolveds } = armedDispatcher("ask4", mailboxDir);
    startAsk(dispatcher);

    const fullOutput = markerPosted(id, 600) + "\nsome output\n" + markerAnswered(id, 30) + "\n";
    delta(dispatcher, fullOutput);
    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: `codex-collab ask "Steer me?"`,
        cwd: "/tmp/ws", status: "completed", processId: null, commandActions: [],
        aggregatedOutput: fullOutput, exitCode: 0, durationMs: 31_000,
      },
      threadId: "t1", turnId: "turn1",
    });

    expect(pendings).toHaveLength(2); // posted + cleared, once each
    expect(resolveds).toHaveLength(1);
  });

  test("aggregatedOutput alone (no deltas delivered) still resolves the question", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-agg", id, "Fallback path?");
    const { dispatcher, pendings, resolveds } = armedDispatcher("ask5", mailboxDir);

    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: `codex-collab ask "Fallback path?"`,
        cwd: "/tmp/ws", status: "completed", processId: null, commandActions: [],
        aggregatedOutput: markerPosted(id, 600) + "\n" + markerAnswered(id, 45) + "\n",
        exitCode: 0, durationMs: 46_000,
      },
      threadId: "t1", turnId: "turn1",
    });

    expect(pendings).toEqual([expect.objectContaining({ id }), null]);
    expect(resolveds).toHaveLength(1);
  });

  test("indented lines (answer echo) never match markers", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-indent", id, "q");
    const { dispatcher, pendings } = armedDispatcher("ask6", mailboxDir);
    startAsk(dispatcher);

    delta(dispatcher, "  " + markerPosted(id, 600) + "\n");
    expect(pendings).toHaveLength(0);
    dispatcher.reset();
  });

  test("without a question context, marker lines are inert", () => {
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "ask7.log"), () => {});
    const id = generateQuestionId();
    // Must not throw or log-crash
    delta(dispatcher, markerPosted(id, 600) + "\n");
  });

  test("a throwing observer does not break the event path", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-throw", id, "q");
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "ask8.log"), () => {});
    dispatcher.setQuestionContext({
      mailboxDir,
      onPending: () => { throw new Error("boom"); },
      onResolved: () => { throw new Error("boom"); },
    });
    startAsk(dispatcher);
    delta(dispatcher, markerPosted(id, 600) + "\n" + markerAnswered(id, 5) + "\n");
    // Reaching here without an exception is the assertion.
    dispatcher.reset();
  });

  test("reset clears the partial-line tail, seen markers, and item registrations", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-reset", id, "q");
    const { dispatcher, pendings } = armedDispatcher("ask9", mailboxDir);
    startAsk(dispatcher);

    const marker = markerPosted(id, 600) + "\n";
    delta(dispatcher, marker.slice(0, 15));
    dispatcher.reset();
    startAsk(dispatcher); // reset dropped the registration too — re-register
    delta(dispatcher, marker.slice(15)); // tail was dropped — no complete marker forms
    expect(pendings).toHaveLength(0);

    delta(dispatcher, marker); // full marker after reset still works
    expect(pendings).toHaveLength(1);
    dispatcher.reset();
  });

  test("marker-shaped output from a NON-ask command is inert (spoofing guard)", () => {
    const id = generateQuestionId();
    const mailboxDir = mailboxWithQuestion("mb-spoof", id, "real question");
    const { dispatcher, pendings, resolveds } = armedDispatcher("ask10", mailboxDir);

    // A cat/grep-style command whose stdout happens to contain marker lines
    // (a log replay, repository test output, prompt-injected file content).
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i9", command: "cat notes.md",
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i9",
      delta: markerPosted(id, 600) + "\n" + markerExpired(id, 600) + "\n",
    });
    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i9", command: "cat notes.md",
        cwd: "/tmp/ws", status: "completed", processId: null, commandActions: [],
        aggregatedOutput: markerPosted(id, 600) + "\n", exitCode: 0, durationMs: 5,
      },
      threadId: "t1", turnId: "turn1",
    });

    expect(pendings).toHaveLength(0);
    expect(resolveds).toHaveLength(0);
  });
});

describe("ask-channel mailbox watch (live path under session-based exec)", () => {
  const { markerPosted, writeQuestion, writeAnswer, generateQuestionId } =
    require("./questions") as typeof import("./questions");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("ask command starting → question surfaced from mailbox → answer resolves it", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-watch");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const resolveds: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "watch1.log"), () => {});
    dispatcher.setQuestionContext({
      mailboxDir,
      onPending: (p) => pendings.push(p),
      onResolved: (r) => resolveds.push(r),
    });

    // A stale question from "another run" — must NOT be attributed here.
    const staleId = generateQuestionId();
    writeQuestion(mailboxDir, {
      id: staleId, question: "old question",
      askedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    });

    // The ask command starts; its question file lands a moment later.
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1",
        command: `/bin/zsh -lc 'codex-collab ask "which way?"'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    const id = generateQuestionId();
    writeQuestion(mailboxDir, {
      id, question: "which way?",
      askedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    });

    await sleep(1300); // one scan tick
    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ id, summary: "which way?" });

    writeAnswer(mailboxDir, id, "this way");
    await sleep(2300); // one resolution tick
    expect(pendings).toEqual([expect.objectContaining({ id }), null]);
    expect(resolveds).toHaveLength(1);
    expect(resolveds[0]).toMatchObject({ id, summary: "which way?", outcome: "answered" });

    // A late marker (aggregated output at command completion) must not double-fire.
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1", delta: markerPosted(id, 600) + "\n",
    });
    expect(pendings).toHaveLength(2);
    dispatcher.reset();
  }, 10_000);
});

describe("ask-channel multi-question runs", () => {
  const { writeQuestion, writeAnswer, generateQuestionId } =
    require("./questions") as typeof import("./questions");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("two sequential asks in one turn both post and resolve, in order", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-multi");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const resolveds: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "multi1.log"), () => {});
    dispatcher.setQuestionContext({
      mailboxDir,
      onPending: (p) => pendings.push(p),
      onResolved: (r) => resolveds.push(r),
    });

    const startAsk = (n: number) => dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: `i${n}`,
        command: `/bin/zsh -lc 'codex-collab ask "question ${n}?"'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    const post = (id: string, n: number) => writeQuestion(mailboxDir, {
      id, question: `question ${n}?`,
      askedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    });

    // First ask: post → surface → answer → resolve
    const id1 = generateQuestionId();
    startAsk(1);
    post(id1, 1);
    await sleep(1300);
    expect(pendings).toEqual([expect.objectContaining({ id: id1, summary: "question 1?" })]);
    writeAnswer(mailboxDir, id1, "answer 1");
    await sleep(2300);
    expect(resolveds).toEqual([expect.objectContaining({ id: id1, outcome: "answered" })]);

    // Second ask later in the same turn: the scan re-arms, the dedupe set
    // must not swallow the new id, and the trail appends in order.
    const id2 = generateQuestionId();
    startAsk(2);
    post(id2, 2);
    await sleep(1300);
    expect(pendings).toEqual([
      expect.objectContaining({ id: id1 }),
      null,
      expect.objectContaining({ id: id2, summary: "question 2?" }),
    ]);
    writeAnswer(mailboxDir, id2, "answer 2");
    await sleep(2300);
    expect(resolveds).toEqual([
      expect.objectContaining({ id: id1, outcome: "answered" }),
      expect.objectContaining({ id: id2, outcome: "answered" }),
    ]);
    dispatcher.reset();
  }, 15_000);
});

describe("ask-channel concurrent-run attribution", () => {
  const { markerPosted, markerAnswered, writeQuestion, generateQuestionId } =
    require("./questions") as typeof import("./questions");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const post = (mailboxDir: string, id: string, question: string) => writeQuestion(mailboxDir, {
    id, question,
    askedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    workspaceDir: "/tmp/ws", pid: process.pid,
  });

  test("with two in-window questions, the scan picks the one embedded in its own command", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-xattr");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "xattr1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onPending: (p) => pendings.push(p) });

    // The OTHER run's question lands first (older = would win a naive
    // oldest-first pick), then ours.
    const otherId = generateQuestionId();
    post(mailboxDir, otherId, "should the other run drop the cache?");
    const ourId = generateQuestionId();

    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1",
        command: `/bin/zsh -lc 'codex-collab ask "which schema version should I target?"'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    post(mailboxDir, ourId, "which schema version should I target?");

    await sleep(1300);
    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ id: ourId });
    dispatcher.reset();
  }, 10_000);

  test("multiple unmatched candidates are left for the marker path, which attributes exactly", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-ambig");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const resolveds: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "ambig1.log"), () => {});
    dispatcher.setQuestionContext({
      mailboxDir,
      onPending: (p) => pendings.push(p),
      onResolved: (r) => resolveds.push(r),
    });

    // A stdin ask: the command carries no question text, and two questions
    // are pending in-window — guessing would cross-attribute.
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1",
        command: `/bin/zsh -lc 'cat q.md | codex-collab ask -'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    const idA = generateQuestionId();
    const idB = generateQuestionId();
    post(mailboxDir, idA, "question from run A");
    post(mailboxDir, idB, "question from run B");

    await sleep(1300);
    expect(pendings).toHaveLength(0); // ambiguous — correctly declined to guess

    // Command completion delivers the markers: per-command, so attribution
    // is exact even in the ambiguous case.
    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: `/bin/zsh -lc 'cat q.md | codex-collab ask -'`,
        cwd: "/tmp/ws", status: "completed", processId: null, commandActions: [],
        aggregatedOutput: markerPosted(idB, 600) + "\n" + markerAnswered(idB, 12) + "\n",
        exitCode: 0, durationMs: 13_000,
      },
      threadId: "t1", turnId: "turn1",
    });
    expect(pendings).toEqual([expect.objectContaining({ id: idB }), null]);
    expect(resolveds).toEqual([expect.objectContaining({ id: idB, outcome: "answered" })]);
    dispatcher.reset();
  }, 10_000);
});

describe("ask-channel answer hint quoting", () => {
  const { markerPosted, writeQuestion, generateQuestionId } =
    require("./questions") as typeof import("./questions");

  test("a workspace path containing a single quote is shell-quoted in the hint", () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-quote");
    mkdirSync(mailboxDir, { recursive: true });
    const id = generateQuestionId();
    writeQuestion(mailboxDir, {
      id, question: "q",
      askedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/it's ws", pid: process.pid,
    });

    const logPath = join(TEST_LOG_DIR, "quote1.log");
    const dispatcher = new EventDispatcher(logPath, () => {});
    dispatcher.setQuestionContext({ mailboxDir, workspaceDir: "/tmp/it's ws" });
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1", command: `codex-collab ask "q"`,
        cwd: "/tmp/it's ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1", delta: markerPosted(id, 600) + "\n",
    });
    dispatcher.reset();

    const log = readFileSync(logPath, "utf-8");
    // POSIX escaping: '…it'\''s ws' — the raw -d '/tmp/it's ws' form must not appear.
    expect(log).toContain(`-d '/tmp/it'\\''s ws'`);
    expect(log).not.toContain(`-d '/tmp/it's ws'`);
  });
});

describe("ask-channel invocation gating (mention vs invocation)", () => {
  const { markerPosted, markerAnswered, writeQuestion, generateQuestionId } =
    require("./questions") as typeof import("./questions");

  test("a command that merely MENTIONS codex-collab ask cannot feed marker state", () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-mention");
    mkdirSync(mailboxDir, { recursive: true });
    const id = generateQuestionId();
    writeQuestion(mailboxDir, {
      id, question: "real pending question",
      askedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    });
    const pendings: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "mention1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onPending: (p) => pendings.push(p) });

    // grep over docs/logs — contains the literal, emits marker-shaped lines.
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1", command: `grep -rh "codex-collab ask" logs/`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1", delta: markerPosted(id, 600) + "\n",
    });
    dispatcher.handleItemCompleted({
      item: {
        type: "commandExecution", id: "i1", command: `grep -rh "codex-collab ask" logs/`,
        cwd: "/tmp/ws", status: "completed", processId: null, commandActions: [],
        aggregatedOutput: markerPosted(id, 600) + "\n", exitCode: 0, durationMs: 5,
      },
      threadId: "t1", turnId: "turn1",
    });

    expect(pendings).toHaveLength(0); // not registered, scan not armed by a mention
    dispatcher.reset();
  });

  test("a resolution marker for a question never posted this turn is inert", () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-lone");
    mkdirSync(mailboxDir, { recursive: true });
    const resolveds: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "lone1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onResolved: (r) => resolveds.push(r) });

    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1", command: `codex-collab ask "q"`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1",
      delta: markerAnswered(generateQuestionId(), 5) + "\n", // never posted
    });

    expect(resolveds).toHaveLength(0);
    dispatcher.reset();
  });
});

describe("ask-channel review-hardening regressions", () => {
  const { writeQuestion, writeAnswer, generateQuestionId, markerPosted, markerAnswered } =
    require("./questions") as typeof import("./questions");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const post = (mailboxDir: string, id: string, question: string, askedAtMs = Date.now()) =>
    writeQuestion(mailboxDir, {
      id, question,
      askedAt: new Date(askedAtMs).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    });

  test("a text-bearing ask never claims a non-matching sole candidate; it waits for its own file", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-nosteal");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "nosteal1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onPending: (p) => pendings.push(p) });

    // A concurrent run's question is already there when our ask starts…
    const otherId = generateQuestionId();
    post(mailboxDir, otherId, "the other run's question");
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1",
        command: `/bin/zsh -lc 'codex-collab ask "our own question"'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    await sleep(1300); // a tick with only the foreign candidate visible
    expect(pendings).toHaveLength(0); // not stolen, scan still armed

    // …then our own file lands and gets picked by text.
    const ourId = generateQuestionId();
    post(mailboxDir, ourId, "our own question");
    await sleep(1300);
    expect(pendings).toEqual([expect.objectContaining({ id: ourId })]);
    dispatcher.reset();
  }, 10_000);

  test("a stdin ask's fallback only trusts questions posted after the command started", async () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-stdinwin");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "stdinwin1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onPending: (p) => pendings.push(p) });

    // Posted 1s BEFORE the stdin ask starts — inside the backdated window,
    // but before armedAt: must not be claimed.
    const beforeId = generateQuestionId();
    post(mailboxDir, beforeId, "posted before arming", Date.now() - 1000);
    dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: "i1",
        command: `/bin/zsh -lc 'cat q.md | codex-collab ask -'`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    await sleep(1300);
    expect(pendings).toHaveLength(0);

    const ownId = generateQuestionId();
    post(mailboxDir, ownId, "stdin question body"); // now the sole post-arming candidate… plus the stale one
    await sleep(1300);
    expect(pendings).toEqual([expect.objectContaining({ id: ownId })]);
    dispatcher.reset();
  }, 10_000);

  test("resolving one question keeps the mirror on the other still-live question", () => {
    const mailboxDir = join(TEST_LOG_DIR, "mb-overlap");
    mkdirSync(mailboxDir, { recursive: true });
    const pendings: unknown[] = [];
    const dispatcher = new EventDispatcher(join(TEST_LOG_DIR, "overlap1.log"), () => {});
    dispatcher.setQuestionContext({ mailboxDir, onPending: (p) => pendings.push(p) });
    const startAsk = (itemId: string) => dispatcher.handleItemStarted({
      item: {
        type: "commandExecution", id: itemId, command: `codex-collab ask "q"`,
        cwd: "/tmp/ws", status: "inProgress", processId: null, commandActions: [],
      },
      threadId: "t1", turnId: "turn1",
    });
    const idA = generateQuestionId();
    const idB = generateQuestionId();
    post(mailboxDir, idA, "question A");
    post(mailboxDir, idB, "question B");
    startAsk("i1");
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1",
      delta: markerPosted(idA, 600) + "\n",
    });
    startAsk("i2");
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i2",
      delta: markerPosted(idB, 600) + "\n",
    });
    // A resolves while B is still live: the mirror must land on B, not null.
    dispatcher.handleDelta("item/commandExecution/outputDelta", {
      threadId: "t1", turnId: "turn1", itemId: "i1",
      delta: markerAnswered(idA, 5) + "\n",
    });
    expect(pendings[pendings.length - 1]).toMatchObject({ id: idB });
    dispatcher.reset();
  });
});
