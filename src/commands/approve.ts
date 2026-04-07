// src/commands/approve.ts — approve + decline command handlers

import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  die,
  parseOptions,
  validateIdOrDie,
  getWorkspacePaths,
} from "./shared";

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

  const requestPath = join(ws.approvalsDir, `${approvalId}.json`);
  if (!existsSync(requestPath))
    die(`No pending approval: ${approvalId}`);

  const decisionPath = join(ws.approvalsDir, `${approvalId}.decision`);
  try {
    writeFileSync(decisionPath, decision, { mode: 0o600 });
  } catch (e) {
    die(`Failed to write approval decision: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(
    `${decision === "accept" ? "Approved" : "Declined"}: ${approvalId}`,
  );
}
