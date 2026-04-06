import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  isInsideGitRepo,
  getDefaultBranch,
  getDiffStats,
  getUntrackedFiles,
  resolveReviewTarget,
} from "./git";

// ─── isInsideGitRepo ───────────────────────────────────────────────────────

describe("isInsideGitRepo", () => {
  test("returns true for the current repo", () => {
    expect(isInsideGitRepo(process.cwd())).toBe(true);
  });

  test("returns true for a subdirectory of the repo", () => {
    expect(isInsideGitRepo(join(process.cwd(), "src"))).toBe(true);
  });

  test("returns false for a temp dir outside any git repo", () => {
    const tmp = join(process.env.TMPDIR ?? "/tmp", "git-test-no-repo");
    mkdirSync(tmp, { recursive: true });
    try {
      expect(isInsideGitRepo(tmp)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── getDefaultBranch ──────────────────────────────────────────────────────

describe("getDefaultBranch", () => {
  test("returns 'main' for this repo", () => {
    // This project uses 'main' as its default branch
    expect(getDefaultBranch(process.cwd())).toBe("main");
  });

  test("returns a non-empty string", () => {
    const branch = getDefaultBranch(process.cwd());
    expect(branch.length).toBeGreaterThan(0);
  });
});

// ─── getDiffStats ──────────────────────────────────────────────────────────

describe("getDiffStats", () => {
  test("returns an object with numeric fields", () => {
    const stats = getDiffStats(process.cwd());
    expect(typeof stats.files).toBe("number");
    expect(typeof stats.insertions).toBe("number");
    expect(typeof stats.deletions).toBe("number");
  });

  test("all values are non-negative", () => {
    const stats = getDiffStats(process.cwd());
    expect(stats.files).toBeGreaterThanOrEqual(0);
    expect(stats.insertions).toBeGreaterThanOrEqual(0);
    expect(stats.deletions).toBeGreaterThanOrEqual(0);
  });

  test("accepts an optional ref argument", () => {
    const stats = getDiffStats(process.cwd(), "HEAD~1");
    expect(typeof stats.files).toBe("number");
    expect(typeof stats.insertions).toBe("number");
    expect(typeof stats.deletions).toBe("number");
  });

  test("returns zeros when there are no diffs for a ref that matches HEAD", () => {
    const stats = getDiffStats(process.cwd(), "HEAD");
    expect(stats.files).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
  });
});

// ─── getUntrackedFiles ─────────────────────────────────────────────────────

describe("getUntrackedFiles", () => {
  const tmpDir = join(process.env.TMPDIR ?? "/tmp", "git-test-untracked");
  let repoDir: string;

  beforeAll(() => {
    // Create a temporary git repo with some untracked files
    repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const { spawnSync } = require("child_process");
    spawnSync("git", ["init"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    // Create a committed file so we have a base
    writeFileSync(join(repoDir, "committed.txt"), "committed");
    spawnSync("git", ["add", "."], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repoDir });
    // Create untracked files
    writeFileSync(join(repoDir, "small.txt"), "hello");
    writeFileSync(join(repoDir, "large.bin"), Buffer.alloc(30000, 0x41)); // 30KB > 24KB default
    // Create a binary file with null bytes (< 24KB so size check passes)
    const binaryContent = Buffer.alloc(100);
    binaryContent[50] = 0; // null byte
    binaryContent.fill(0x41, 0, 50);
    binaryContent.fill(0x42, 51);
    writeFileSync(join(repoDir, "binary.dat"), binaryContent);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns an array of strings", () => {
    const files = getUntrackedFiles(process.cwd());
    expect(Array.isArray(files)).toBe(true);
    for (const f of files) {
      expect(typeof f).toBe("string");
    }
  });

  test("includes small text files", () => {
    const files = getUntrackedFiles(repoDir);
    expect(files).toContain("small.txt");
  });

  test("excludes files larger than maxSize", () => {
    const files = getUntrackedFiles(repoDir);
    expect(files).not.toContain("large.bin");
  });

  test("excludes binary files (files with null bytes)", () => {
    const files = getUntrackedFiles(repoDir);
    expect(files).not.toContain("binary.dat");
  });

  test("respects custom maxSize", () => {
    // With a very large maxSize, the large file should be included
    // (it's all 0x41 bytes, no nulls, so it's not binary)
    const files = getUntrackedFiles(repoDir, 100_000);
    expect(files).toContain("large.bin");
  });
});

// ─── resolveReviewTarget ───────────────────────────────────────────────────

describe("resolveReviewTarget", () => {
  test("mode 'pr' returns baseBranch target", () => {
    const target = resolveReviewTarget(process.cwd(), { mode: "pr" });
    expect(target.type).toBe("baseBranch");
    if (target.type === "baseBranch") {
      expect(typeof target.branch).toBe("string");
      expect(target.branch.length).toBeGreaterThan(0);
    }
  });

  test("undefined mode defaults to baseBranch (pr)", () => {
    const target = resolveReviewTarget(process.cwd(), {});
    expect(target.type).toBe("baseBranch");
  });

  test("mode 'uncommitted' returns uncommittedChanges target", () => {
    const target = resolveReviewTarget(process.cwd(), { mode: "uncommitted" });
    expect(target).toEqual({ type: "uncommittedChanges" });
  });

  test("mode 'commit' with no ref defaults to HEAD", () => {
    const target = resolveReviewTarget(process.cwd(), { mode: "commit" });
    expect(target).toEqual({ type: "commit", sha: "HEAD" });
  });

  test("mode 'commit' with explicit ref uses that ref", () => {
    const target = resolveReviewTarget(process.cwd(), { mode: "commit", ref: "abc123" });
    expect(target).toEqual({ type: "commit", sha: "abc123" });
  });

  test("mode 'custom' with instructions returns custom target", () => {
    const target = resolveReviewTarget(process.cwd(), {
      mode: "custom",
      instructions: "Check for security issues",
    });
    expect(target).toEqual({ type: "custom", instructions: "Check for security issues" });
  });

  test("instructions provided without mode returns custom target", () => {
    const target = resolveReviewTarget(process.cwd(), {
      instructions: "Focus on performance",
    });
    expect(target).toEqual({ type: "custom", instructions: "Focus on performance" });
  });

  test("throws for unknown mode", () => {
    expect(() => resolveReviewTarget(process.cwd(), { mode: "bogus" })).toThrow(
      /unknown review mode/i,
    );
  });
});
