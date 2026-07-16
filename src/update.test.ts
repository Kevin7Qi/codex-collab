import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  REPO_SLUG,
  compareVersions,
  loadUpdateState,
  saveUpdateState,
  shouldNotifyRelease,
} from "./update";

// ─── REPO_SLUG ──────────────────────────────────────────────────────────────

describe("REPO_SLUG", () => {
  test("parsed from package.json repository URL", () => {
    expect(REPO_SLUG).toBe("Kevin7Qi/codex-collab");
  });
});

// ─── compareVersions ────────────────────────────────────────────────────────

describe("compareVersions", () => {
  test("orders numerically per segment", () => {
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareVersions("0.2.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  test("tolerates v prefix and missing segments", () => {
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.3", "0.3.1")).toBe(-1);
    expect(compareVersions("1", "0.9")).toBe(1);
  });

  test("non-numeric segments count as 0", () => {
    expect(compareVersions("0.x.1", "0.0.1")).toBe(0);
  });
});

// ─── update state ───────────────────────────────────────────────────────────

describe("update state", () => {
  test("roundtrips through a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-test-"));
    const file = join(dir, "nested", "update-check.json");
    try {
      expect(loadUpdateState(file)).toEqual({});
      saveUpdateState({ latestVersion: "0.3.0", mutedVersion: "0.2.5" }, file);
      expect(loadUpdateState(file)).toEqual({ latestVersion: "0.3.0", mutedVersion: "0.2.5" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt or non-object state degrades to empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "update-test-"));
    const file = join(dir, "update-check.json");
    try {
      writeFileSync(file, "not json{");
      expect(loadUpdateState(file)).toEqual({});
      writeFileSync(file, "[1,2]");
      expect(loadUpdateState(file)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── shouldNotifyRelease ────────────────────────────────────────────────────

describe("shouldNotifyRelease", () => {
  test("no known release → quiet", () => {
    expect(shouldNotifyRelease("0.2.1", {})).toBe(false);
  });

  test("same or older release → quiet", () => {
    expect(shouldNotifyRelease("0.2.1", { latestVersion: "0.2.1" })).toBe(false);
    expect(shouldNotifyRelease("0.2.1", { latestVersion: "0.2.0" })).toBe(false);
  });

  test("newer release → notify", () => {
    expect(shouldNotifyRelease("0.2.1", { latestVersion: "0.3.0" })).toBe(true);
  });

  test("muted version silences it, later release re-notifies", () => {
    expect(shouldNotifyRelease("0.2.1", { latestVersion: "0.3.0", mutedVersion: "0.3.0" })).toBe(false);
    expect(shouldNotifyRelease("0.2.1", { latestVersion: "0.3.1", mutedVersion: "0.3.0" })).toBe(true);
  });
});
