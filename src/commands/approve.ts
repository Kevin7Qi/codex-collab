// src/commands/approve.ts — approve + decline command handlers

import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import {
  die,
  parseOptions,
  validateIdOrDie,
  getWorkspacePaths,
} from "./shared";

function findApprovalRequest(currentPath: string, approvalId: string): string | null {
  if (existsSync(currentPath)) return currentPath;

  const workspacesDir = join(config.dataDir, "workspaces");
  if (!existsSync(workspacesDir)) return null;

  const matches: string[] = [];
  for (const workspaceName of readdirSync(workspacesDir)) {
    const candidate = join(workspacesDir, workspaceName, "approvals", `${approvalId}.json`);
    if (existsSync(candidate)) matches.push(candidate);
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    die(`Approval ID ${approvalId} exists in multiple workspaces. Re-run from the workspace directory or pass -d <workspace>.`);
  }
  return matches[0];
}

export async function handleApprove(args: string[]): Promise<void> {
  return handleApproveOrDecline("accept", args);
}

export async function handleDecline(args: string[]): Promise<void> {
  return handleApproveOrDecline("decline", args);
}

async function handleApproveOrDecline(
  decision: "accept" | "decline",
  args: string[],
): Promise<void> {
  const { positional, options } = parseOptions(args);
  const ws = getWorkspacePaths(options.dir);
  const approvalId = positional[0];
  const verb = decision === "accept" ? "approve" : "decline";
  if (!approvalId) die(`Usage: codex-collab ${verb} <approval-id>`);
  validateIdOrDie(approvalId);

  const requestPath = findApprovalRequest(join(ws.approvalsDir, `${approvalId}.json`), approvalId);
  if (!requestPath)
    die(`No pending approval: ${approvalId}`);

  const decisionPath = requestPath.replace(/\.json$/, ".decision");
  try {
    writeFileSync(decisionPath, decision, { mode: 0o600 });
  } catch (e) {
    die(`Failed to write approval decision: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(
    `${decision === "accept" ? "Approved" : "Declined"}: ${approvalId}`,
  );
}
