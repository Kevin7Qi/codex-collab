import { describe, expect, test, beforeEach } from "bun:test";
import { autoApproveHandler, InteractiveApprovalHandler } from "./approvals";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import type { CommandApprovalRequest, FileChangeApprovalRequest } from "./types";

const TEST_APPROVALS_DIR = `${process.env.TMPDIR || "/tmp/claude-1000"}/codex-collab-test-approvals`;

beforeEach(() => {
  if (existsSync(TEST_APPROVALS_DIR)) rmSync(TEST_APPROVALS_DIR, { recursive: true });
  mkdirSync(TEST_APPROVALS_DIR, { recursive: true });
});

const mockCommandRequest: CommandApprovalRequest = {
  threadId: "t1",
  turnId: "turn1",
  itemId: "item1",
  approvalId: "appr-001",
  reason: "network access",
  command: "curl https://example.com",
  cwd: "/project",
};

const mockFileChangeRequest: FileChangeApprovalRequest = {
  threadId: "t1",
  turnId: "turn1",
  itemId: "item2",
  reason: "write to /etc",
  grantRoot: "/etc",
};

describe("autoApproveHandler", () => {
  test("approves command immediately", async () => {
    const decision = await autoApproveHandler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("accept");
  });

  test("approves file change immediately", async () => {
    const decision = await autoApproveHandler.handleFileChangeApproval(mockFileChangeRequest);
    expect(decision).toBe("accept");
  });
});

describe("InteractiveApprovalHandler", () => {
  test("writes request file and resolves when decision file appears", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      100, // 100ms poll interval for testing
    );

    // Write decision file after a short delay
    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/appr-001.decision`, "accept");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("accept");
    expect(lines.some((l) => l.includes("APPROVAL NEEDED"))).toBe(true);
    // Request file should be cleaned up
    expect(existsSync(`${TEST_APPROVALS_DIR}/appr-001.json`)).toBe(false);
    // Decision file should be cleaned up
    expect(existsSync(`${TEST_APPROVALS_DIR}/appr-001.decision`)).toBe(false);
  });

  test("returns decline when decision file says decline", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, 100);

    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/appr-001.decision`, "decline");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("decline");
  });

  test("handles file change approval requests", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      100,
    );

    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/item2.decision`, "accept");
    }, 200);

    const decision = await handler.handleFileChangeApproval(mockFileChangeRequest);
    expect(decision).toBe("accept");
    expect(lines.some((l) => l.includes("file change"))).toBe(true);
    // Cleanup happened
    expect(existsSync(`${TEST_APPROVALS_DIR}/item2.json`)).toBe(false);
  });

  test("uses itemId as fallback when approvalId is null", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, 100);

    const reqWithNullApprovalId: CommandApprovalRequest = {
      ...mockCommandRequest,
      approvalId: null,
    };

    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/item1.decision`, "accept");
    }, 200);

    const decision = await handler.handleCommandApproval(reqWithNullApprovalId);
    expect(decision).toBe("accept");
  });

  test("writes request file with correct content", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, 100);

    // Start the approval but write decision after verifying request file
    setTimeout(() => {
      const requestPath = `${TEST_APPROVALS_DIR}/appr-001.json`;
      expect(existsSync(requestPath)).toBe(true);
      const content = JSON.parse(readFileSync(requestPath, "utf-8"));
      expect(content.type).toBe("commandExecution");
      expect(content.command).toBe("curl https://example.com");
      expect(content.cwd).toBe("/project");
      expect(content.reason).toBe("network access");
      expect(content.threadId).toBe("t1");
      expect(content.turnId).toBe("turn1");
      writeFileSync(`${TEST_APPROVALS_DIR}/appr-001.decision`, "accept");
    }, 150);

    await handler.handleCommandApproval(mockCommandRequest);
  });

  test("creates approvalsDir if it does not exist", async () => {
    const nestedDir = `${TEST_APPROVALS_DIR}/nested/deep`;
    const handler = new InteractiveApprovalHandler(nestedDir, () => {}, 100);

    expect(existsSync(nestedDir)).toBe(true);
  });

  test("progress callback includes command text", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      100,
    );

    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/appr-001.decision`, "accept");
    }, 200);

    await handler.handleCommandApproval(mockCommandRequest);
    expect(lines.some((l) => l.includes("curl https://example.com"))).toBe(true);
    expect(lines.some((l) => l.includes("network access"))).toBe(true);
  });

  test("treats unknown decision text as decline", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, 100);

    setTimeout(() => {
      writeFileSync(`${TEST_APPROVALS_DIR}/appr-001.decision`, "garbage");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("decline");
  });
});
