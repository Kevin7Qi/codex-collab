import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { getDefaultBranch } from "./git";

describe("getDefaultBranch", () => {
  test("returns 'main' for this repo", () => {
    // This project uses 'main' as its default branch
    expect(getDefaultBranch(process.cwd())).toBe("main");
  });

  test("returns a non-empty string", () => {
    const branch = getDefaultBranch(process.cwd());
    expect(branch.length).toBeGreaterThan(0);
  });

  test("preserves slashes in default branch names like release/2026", () => {
    // symbolic-ref returns the full refname; splitting on "/" and taking the
    // last segment loses everything before the slash for branches whose
    // names contain "/". Real users have release/<year>, hotfix/<id>,
    // feature/<topic> conventions — review would otherwise compare against
    // "2026" instead of "release/2026".
    const tmp = join(process.env.TMPDIR ?? "/tmp", `git-test-slashy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    try {
      spawnSync("git", ["init", "-q", tmp]);
      // Stage a symbolic-ref file directly so we don't need a populated
      // remote tracking branch — getDefaultBranch only inspects the ref.
      const refDir = join(tmp, ".git", "refs", "remotes", "origin");
      mkdirSync(refDir, { recursive: true });
      writeFileSync(join(refDir, "HEAD"), "ref: refs/remotes/origin/release/2026\n");
      expect(getDefaultBranch(tmp)).toBe("release/2026");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
