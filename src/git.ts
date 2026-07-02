// src/git.ts — Git operations for review scoping

import { spawnSync } from "child_process";

/** Run a git command synchronously with a 5-second timeout. */
function git(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 5000 });
  return { stdout: (result.stdout ?? "").trim(), status: result.status };
}

/** Get the default branch name (main or master). */
export function getDefaultBranch(cwd: string): string {
  // Try remote HEAD first
  const { stdout, status } = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (status === 0 && stdout) {
    // e.g. "refs/remotes/origin/main" → "main",
    //      "refs/remotes/origin/release/2026" → "release/2026".
    // Strip the prefix instead of taking the last path segment so default
    // branches whose names contain "/" survive intact.
    const prefix = "refs/remotes/origin/";
    if (stdout.startsWith(prefix)) return stdout.slice(prefix.length);
    return stdout;
  }

  // Fall back to checking local branches
  const mainCheck = git(["rev-parse", "--verify", "refs/heads/main"], cwd);
  if (mainCheck.status === 0) return "main";

  const masterCheck = git(["rev-parse", "--verify", "refs/heads/master"], cwd);
  if (masterCheck.status === 0) return "master";

  // Default to main
  return "main";
}
