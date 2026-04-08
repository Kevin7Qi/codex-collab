// src/git.ts — Git operations for review scoping

import { spawnSync } from "child_process";
import { statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import type { ReviewTarget } from "./types";

const DEFAULT_MAX_SIZE = 24_576; // 24KB

/** Run a git command synchronously with a 5-second timeout. */
function git(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 5000 });
  return { stdout: (result.stdout ?? "").trim(), status: result.status };
}

/** Check if a directory is inside a git repo. */
export function isInsideGitRepo(cwd: string): boolean {
  const { stdout, status } = git(["rev-parse", "--is-inside-work-tree"], cwd);
  return status === 0 && stdout === "true";
}

/** Get the default branch name (main or master). */
export function getDefaultBranch(cwd: string): string {
  // Try remote HEAD first
  const { stdout, status } = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  if (status === 0 && stdout) {
    // e.g. "refs/remotes/origin/main" → "main"
    const parts = stdout.split("/");
    return parts[parts.length - 1];
  }

  // Fall back to checking local branches
  const mainCheck = git(["rev-parse", "--verify", "refs/heads/main"], cwd);
  if (mainCheck.status === 0) return "main";

  const masterCheck = git(["rev-parse", "--verify", "refs/heads/master"], cwd);
  if (masterCheck.status === 0) return "master";

  // Default to main
  return "main";
}

/** Get diff stats (files changed, insertions, deletions). */
export function getDiffStats(
  cwd: string,
  ref?: string,
): { files: number; insertions: number; deletions: number } {
  const args = ["diff", "--shortstat"];
  if (ref) args.push(ref);

  const { stdout, status } = git(args, cwd);
  if (status !== 0 || !stdout) return { files: 0, insertions: 0, deletions: 0 };

  // Parse lines like: "3 files changed, 10 insertions(+), 5 deletions(-)"
  // Some components may be missing (e.g. no deletions, or only file renames).
  const filesMatch = stdout.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = stdout.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = stdout.match(/(\d+)\s+deletions?\(-\)/);

  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

/** List untracked files, skipping those >maxSize bytes and binary files. */
export function getUntrackedFiles(cwd: string, maxSize: number = DEFAULT_MAX_SIZE): string[] {
  const { stdout } = git(["ls-files", "--others", "--exclude-standard"], cwd);
  if (!stdout) return [];

  const paths = stdout.split("\n").filter(Boolean);
  const result: string[] = [];

  for (const relPath of paths) {
    const absPath = join(cwd, relPath);

    // Skip files larger than maxSize
    try {
      const stat = statSync(absPath);
      if (stat.size > maxSize) continue;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not stat ${relPath}: ${(e as Error).message}`);
      }
      continue;
    }

    // Skip binary files (check first 8KB for null bytes)
    try {
      const fd = openSync(absPath, "r");
      const buf = Buffer.alloc(8192);
      const bytesRead = readSync(fd, buf, 0, 8192, 0);
      closeSync(fd);
      if (buf.subarray(0, bytesRead).includes(0)) continue;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[codex] Warning: could not read ${relPath}: ${(e as Error).message}`);
      }
      continue;
    }

    result.push(relPath);
  }

  return result;
}

/** Resolve review target from CLI options to protocol ReviewTarget. */
export function resolveReviewTarget(
  cwd: string,
  opts: { mode?: string; ref?: string; instructions?: string },
): ReviewTarget {
  const mode = opts.mode;

  // If instructions are provided with no mode or with "custom" mode, return custom target
  if (opts.instructions && (!mode || mode === "custom")) {
    return { type: "custom", instructions: opts.instructions };
  }

  switch (mode) {
    case "pr":
    case undefined:
      return { type: "baseBranch", branch: getDefaultBranch(cwd) };
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "commit":
      return { type: "commit", sha: opts.ref ?? "HEAD" };
    case "custom":
      // Reached only if no instructions were provided
      throw new Error(
        'Custom review mode requires instructions.\nUsage: codex-collab review --mode custom --instructions "..."',
      );
    default:
      throw new Error(
        `Unknown review mode: "${mode}". Valid modes: pr, uncommitted, commit, custom`,
      );
  }
}
