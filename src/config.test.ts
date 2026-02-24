import { describe, expect, test } from "bun:test";
import { config } from "./config";

describe("config", () => {
  test("has app server paths", () => {
    expect(config.threadsFile).toContain("threads.json");
    expect(config.logsDir).toContain("logs");
    expect(config.approvalsDir).toContain("approvals");
  });

  test("does not reference tmux", () => {
    const json = JSON.stringify(config);
    expect(json).not.toContain("tmux");
  });

  test("has protocol timeout", () => {
    expect(config.requestTimeout).toBeGreaterThan(0);
    expect(config.defaultTimeout).toBeGreaterThan(0);
  });
});
