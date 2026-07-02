import { describe, expect, test, beforeEach } from "bun:test";
import { autoApproveHandler, InteractiveApprovalHandler } from "./approvals";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CommandApprovalRequest, FileChangeApprovalRequest } from "./types";

const TEST_APPROVALS_DIR = join(tmpdir(), "codex-collab-test-approvals");

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
      { pollIntervalMs: 100 }, // fast poll for testing
    );

    // Write decision file after a short delay
    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("accept");
    expect(lines.some((l) => l.includes("APPROVAL NEEDED"))).toBe(true);
    // Request file should be cleaned up
    expect(existsSync(join(TEST_APPROVALS_DIR, "appr-001.json"))).toBe(false);
    // Decision file should be cleaned up
    expect(existsSync(join(TEST_APPROVALS_DIR, "appr-001.decision"))).toBe(false);
  });

  test("returns decline when decision file says decline", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, { pollIntervalMs: 100 });

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "decline");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("decline");
  });

  test("handles file change approval requests", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      { pollIntervalMs: 100 },
    );

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "item2.decision"), "accept");
    }, 200);

    const decision = await handler.handleFileChangeApproval(mockFileChangeRequest);
    expect(decision).toBe("accept");
    expect(lines.some((l) => l.includes("file change"))).toBe(true);
    // Cleanup happened
    expect(existsSync(join(TEST_APPROVALS_DIR, "item2.json"))).toBe(false);
  });

  test("uses itemId as fallback when approvalId is null", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, { pollIntervalMs: 100 });

    const reqWithNullApprovalId: CommandApprovalRequest = {
      ...mockCommandRequest,
      approvalId: null,
    };

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "item1.decision"), "accept");
    }, 200);

    const decision = await handler.handleCommandApproval(reqWithNullApprovalId);
    expect(decision).toBe("accept");
  });

  test("writes request file with correct content", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, { pollIntervalMs: 100 });

    // Start the approval but write decision after verifying request file
    setTimeout(() => {
      const requestPath = join(TEST_APPROVALS_DIR, "appr-001.json");
      expect(existsSync(requestPath)).toBe(true);
      const content = JSON.parse(readFileSync(requestPath, "utf-8"));
      expect(content.type).toBe("commandExecution");
      expect(content.command).toBe("curl https://example.com");
      expect(content.cwd).toBe("/project");
      expect(content.reason).toBe("network access");
      expect(content.threadId).toBe("t1");
      expect(content.turnId).toBe("turn1");
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    }, 150);

    await handler.handleCommandApproval(mockCommandRequest);
  });

  test("creates approvalsDir if it does not exist", async () => {
    const nestedDir = join(TEST_APPROVALS_DIR, "nested", "deep");
    const handler = new InteractiveApprovalHandler(nestedDir, () => {}, { pollIntervalMs: 100 });

    expect(existsSync(nestedDir)).toBe(true);
  });

  test("progress callback includes command text", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      { pollIntervalMs: 100 },
    );

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    }, 200);

    await handler.handleCommandApproval(mockCommandRequest);
    expect(lines.some((l) => l.includes("curl https://example.com"))).toBe(true);
    expect(lines.some((l) => l.includes("network access"))).toBe(true);
  });

  test("progress callback includes workspace-aware approve commands", async () => {
    const lines: string[] = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      { workspaceDir: "/project with spaces", pollIntervalMs: 100 },
    );

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    }, 200);

    await handler.handleCommandApproval(mockCommandRequest);
    expect(lines).toContain("  Approve: codex-collab approve appr-001 -d '/project with spaces'");
    expect(lines).toContain("  Decline: codex-collab decline appr-001 -d '/project with spaces'");
  });

  test("progress callback shell-quotes workspace paths without expansion", async () => {
    const lines: string[] = [];
    const workspace = "/tmp/$USER/$(echo bad)/a'b";
    const quotedWorkspace = process.platform === "win32"
      ? "'/tmp/$USER/$(echo bad)/a''b'"
      : "'/tmp/$USER/$(echo bad)/a'\\''b'";
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      (line) => lines.push(line),
      { workspaceDir: workspace, pollIntervalMs: 100 },
    );

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    }, 200);

    await handler.handleCommandApproval(mockCommandRequest);
    expect(lines).toContain(`  Approve: codex-collab approve appr-001 -d ${quotedWorkspace}`);
    expect(lines).toContain(`  Decline: codex-collab decline appr-001 -d ${quotedWorkspace}`);
  });

  test("cleans up request file on abort", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, { pollIntervalMs: 100 });
    const controller = new AbortController();

    // Abort after request file is written
    setTimeout(() => controller.abort(), 200);

    await expect(
      handler.handleCommandApproval(mockCommandRequest, controller.signal),
    ).rejects.toThrow("cancelled");

    expect(existsSync(join(TEST_APPROVALS_DIR, "appr-001.json"))).toBe(false);
  });

  test("treats unknown decision text as decline", async () => {
    const handler = new InteractiveApprovalHandler(TEST_APPROVALS_DIR, () => {}, { pollIntervalMs: 100 });

    setTimeout(() => {
      writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "garbage");
    }, 200);

    const decision = await handler.handleCommandApproval(mockCommandRequest);
    expect(decision).toBe("decline");
  });
});

describe("pending-approval observer (onPending)", () => {
  test("fires with the request on block and null on resolution", async () => {
    const events: Array<unknown> = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      () => {},
      { pollIntervalMs: 20, onPending: (p) => events.push(p) },
    );

    const decisionPath = join(TEST_APPROVALS_DIR, "appr-001.decision");
    const pending = handler.handleCommandApproval(mockCommandRequest);
    // Wait until the request file exists, then answer it
    while (!existsSync(join(TEST_APPROVALS_DIR, "appr-001.json"))) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "appr-001",
      kind: "commandExecution",
      summary: "curl https://example.com",
    });

    writeFileSync(decisionPath, "accept");
    await pending;
    expect(events).toHaveLength(2);
    expect(events[1]).toBeNull();
  });

  test("fires null on abort so the run record flag can't stick", async () => {
    const events: Array<unknown> = [];
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      () => {},
      { pollIntervalMs: 20, onPending: (p) => events.push(p) },
    );

    const abort = new AbortController();
    const pending = handler.handleCommandApproval(mockCommandRequest, abort.signal);
    while (!existsSync(join(TEST_APPROVALS_DIR, "appr-001.json"))) {
      await new Promise((r) => setTimeout(r, 5));
    }
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(events).toHaveLength(2);
    expect(events[1]).toBeNull();
  });

  test("observer exceptions do not break the approval flow", async () => {
    const handler = new InteractiveApprovalHandler(
      TEST_APPROVALS_DIR,
      () => {},
      { pollIntervalMs: 20, onPending: () => { throw new Error("observer boom"); } },
    );

    const pending = handler.handleCommandApproval(mockCommandRequest);
    while (!existsSync(join(TEST_APPROVALS_DIR, "appr-001.json"))) {
      await new Promise((r) => setTimeout(r, 5));
    }
    writeFileSync(join(TEST_APPROVALS_DIR, "appr-001.decision"), "accept");
    expect(await pending).toBe("accept");
  });
});
