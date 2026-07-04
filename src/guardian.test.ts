// src/guardian.test.ts — Guardian denial persistence + override-event mapping

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildGuardianOverrideEvent,
  describeGuardianAction,
  listGuardianDenials,
  mapGuardianAction,
  markGuardianDenialOverridden,
  resolveGuardianDenial,
  saveGuardianDenial,
} from "./guardian";
import type { AutoApprovalReviewParams, GuardianDenialRecord } from "./types";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guardian-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deniedNotification(overrides: Partial<AutoApprovalReviewParams> = {}): AutoApprovalReviewParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    reviewId: "rev-abc123",
    targetItemId: "call_1",
    startedAtMs: 1000,
    completedAtMs: 2000,
    decisionSource: "agent",
    review: { status: "denied", riskLevel: "medium", userAuthorization: "low", rationale: "not asked for" },
    action: { type: "command", source: "unifiedExec", command: "touch /tmp/x", cwd: "/tmp" },
    ...overrides,
  };
}

function record(overrides: Partial<AutoApprovalReviewParams> = {}): GuardianDenialRecord {
  return {
    reviewId: "rev-abc123",
    threadId: "thread-1",
    receivedAt: "2026-07-04T00:00:00.000Z",
    notification: deniedNotification(overrides),
  };
}

describe("saveGuardianDenial / listGuardianDenials", () => {
  test("persists and lists a denial", () => {
    const path = saveGuardianDenial(dir, deniedNotification());
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    const listed = listGuardianDenials(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0].reviewId).toBe("rev-abc123");
    expect(listed[0].threadId).toBe("thread-1");
    expect(listed[0].overriddenAt).toBeUndefined();
  });

  test("rejects payloads without a usable reviewId or threadId", () => {
    expect(saveGuardianDenial(dir, deniedNotification({ reviewId: undefined }))).toBeNull();
    expect(saveGuardianDenial(dir, deniedNotification({ threadId: undefined }))).toBeNull();
    // Path-traversal-shaped IDs must not become file paths.
    expect(saveGuardianDenial(dir, deniedNotification({ reviewId: "../evil" }))).toBeNull();
    expect(listGuardianDenials(dir)).toHaveLength(0);
  });

  test("skips corrupt files", () => {
    saveGuardianDenial(dir, deniedNotification());
    Bun.spawnSync(["sh", "-c", `echo garbage > "${join(dir, "broken.json")}"`]);
    expect(listGuardianDenials(dir)).toHaveLength(1);
  });
});

describe("resolveGuardianDenial", () => {
  test("resolves by exact ID and by prefix", () => {
    saveGuardianDenial(dir, deniedNotification());
    expect(resolveGuardianDenial(dir, "rev-abc123")?.reviewId).toBe("rev-abc123");
    expect(resolveGuardianDenial(dir, "rev-a")?.reviewId).toBe("rev-abc123");
    expect(resolveGuardianDenial(dir, "nope")).toBeNull();
  });

  test("throws on ambiguous prefix, prefers exact match", () => {
    saveGuardianDenial(dir, deniedNotification({ reviewId: "rev-1" }));
    saveGuardianDenial(dir, deniedNotification({ reviewId: "rev-12" }));
    expect(() => resolveGuardianDenial(dir, "rev")).toThrow(/Ambiguous/);
    expect(resolveGuardianDenial(dir, "rev-1")?.reviewId).toBe("rev-1");
  });
});

describe("markGuardianDenialOverridden", () => {
  test("stamps the record and survives a reload", () => {
    saveGuardianDenial(dir, deniedNotification());
    markGuardianDenialOverridden(dir, "rev-abc123");
    const reloaded = JSON.parse(readFileSync(join(dir, "rev-abc123.json"), "utf8"));
    expect(typeof reloaded.overriddenAt).toBe("string");
  });
});

describe("mapGuardianAction", () => {
  // Casings verified against codex-rs 0.142 source: the core
  // GuardianAssessmentAction is snake_case-tagged with snake_case enum
  // values, the v2 notification camelCases both.
  test("command / execve pass through with source value converted", () => {
    expect(mapGuardianAction({ type: "command", source: "unifiedExec", command: "ls", cwd: "/" }))
      .toEqual({ type: "command", source: "unified_exec", command: "ls", cwd: "/" });
    expect(mapGuardianAction({ type: "execve", source: "shell", program: "ls", argv: ["-l"], cwd: "/" }))
      .toEqual({ type: "execve", source: "shell", program: "ls", argv: ["-l"], cwd: "/" });
  });

  test("tag values convert camelCase → snake_case", () => {
    expect(mapGuardianAction({ type: "applyPatch", cwd: "/", files: ["/a"] }).type).toBe("apply_patch");
    expect(mapGuardianAction({ type: "networkAccess", target: "t", host: "h", protocol: "socks5Tcp", port: 80 }))
      .toEqual({ type: "network_access", target: "t", host: "h", protocol: "socks5_tcp", port: 80 });
    expect(mapGuardianAction({ type: "requestPermissions", reason: null, permissions: { network: null, file_system: null } }))
      .toEqual({ type: "request_permissions", reason: null, permissions: { network: null, file_system: null } });
  });

  test("mcpToolCall keys convert to snake_case", () => {
    expect(mapGuardianAction({
      type: "mcpToolCall", server: "s", toolName: "t", connectorId: null, connectorName: null, toolTitle: "T",
    })).toEqual({
      type: "mcp_tool_call", server: "s", tool_name: "t", connector_id: null, connector_name: null, tool_title: "T",
    });
  });
});

describe("buildGuardianOverrideEvent", () => {
  test("maps the full notification to the core snake_case event", () => {
    expect(buildGuardianOverrideEvent(record())).toEqual({
      id: "rev-abc123",
      turn_id: "turn-1",
      status: "denied",
      target_item_id: "call_1",
      started_at_ms: 1000,
      completed_at_ms: 2000,
      risk_level: "medium",
      user_authorization: "low",
      rationale: "not asked for",
      decision_source: "agent",
      action: { type: "command", source: "unified_exec", command: "touch /tmp/x", cwd: "/tmp" },
    });
  });

  test("omits optional fields the notification lacks", () => {
    const event = buildGuardianOverrideEvent(record({
      targetItemId: null,
      startedAtMs: undefined,
      completedAtMs: undefined,
      decisionSource: undefined,
      review: { status: "denied", riskLevel: null, userAuthorization: null, rationale: null },
    }));
    expect(event).toEqual({
      id: "rev-abc123",
      turn_id: "turn-1",
      status: "denied",
      action: { type: "command", source: "unified_exec", command: "touch /tmp/x", cwd: "/tmp" },
    });
  });

  test("accepts the enum-shaped status the dispatcher tolerates", () => {
    const event = buildGuardianOverrideEvent(record({
      review: { status: { type: "denied" }, riskLevel: null, userAuthorization: null, rationale: null },
    }));
    expect(event.status).toBe("denied");
  });

  test("rejects non-denials and missing actions", () => {
    expect(() => buildGuardianOverrideEvent(record({
      review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: null },
    }))).toThrow(/not a denial/);
    expect(() => buildGuardianOverrideEvent(record({ action: undefined }))).toThrow(/no action/);
  });
});

describe("describeGuardianAction", () => {
  test("summarizes each action type", () => {
    expect(describeGuardianAction(record())).toBe("command: touch /tmp/x");
    expect(describeGuardianAction(record({ action: { type: "networkAccess", target: "t", host: "example.com", protocol: "https", port: 443 } })))
      .toBe("network: example.com:443");
    expect(describeGuardianAction(record({ action: { type: "mcpToolCall", server: "srv", toolName: "fetch" } })))
      .toBe("mcp tool: srv/fetch");
  });
});
