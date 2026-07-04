// src/commands/approve.ts — approve + decline command handlers

import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../config";
import {
  die,
  parseOptions,
  validateIdOrDie,
  getWorkspacePaths,
  withClient,
} from "./shared";
import {
  buildGuardianOverrideEvent,
  describeGuardianAction,
  listGuardianDenials,
  markGuardianDenialOverridden,
  resolveGuardianDenial,
} from "../guardian";
import { findShortId } from "../threads";

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
  if (options.guardian) {
    if (decision !== "accept") die("--guardian is only valid with approve (Guardian denials are already declines)");
    return handleGuardianOverride(ws.stateDir, ws.guardianDir, approvalId);
  }
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

/** Override a Guardian denial: send thread/approveGuardianDeniedAction with
 *  the persisted denial event. The server injects a developer message
 *  approving that exact action into the thread (no turn starts); the agent
 *  acts on it the next time the thread runs. With no ID, list pending
 *  denials instead. */
async function handleGuardianOverride(
  stateDir: string,
  guardianDir: string,
  idOrPrefix: string | undefined,
): Promise<void> {
  const pending = listGuardianDenials(guardianDir).filter((r) => !r.overriddenAt);

  if (!idOrPrefix) {
    if (pending.length === 0) {
      console.log("No pending Guardian denials.");
      return;
    }
    console.log("Pending Guardian denials:");
    for (const r of pending) {
      const thread = findShortId(stateDir, r.threadId) ?? r.threadId;
      console.log(`  ${r.reviewId}  thread ${thread}  ${r.receivedAt}  ${describeGuardianAction(r)}`);
    }
    console.log("\nOverride one with: codex-collab approve --guardian <review-id>");
    return;
  }

  let record;
  try {
    record = resolveGuardianDenial(guardianDir, idOrPrefix);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
  if (!record) die(`No Guardian denial found for: ${idOrPrefix}`);
  if (record.overriddenAt) die(`Denial ${record.reviewId} was already overridden at ${record.overriddenAt}`);

  let event;
  try {
    event = buildGuardianOverrideEvent(record);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  const threadId = record.threadId;
  await withClient(async (client) => {
    // The RPC needs the thread loaded in the app-server; a minimal resume
    // loads it without starting a turn or changing settings.
    await client.request("thread/resume", { threadId, persistExtendedHistory: false });
    await client.request("thread/approveGuardianDeniedAction", { threadId, event });
  });

  markGuardianDenialOverridden(guardianDir, record.reviewId);
  const thread = findShortId(stateDir, threadId) ?? threadId;
  console.log(`Guardian denial overridden: ${describeGuardianAction(record)}`);
  console.log(
    `The approval was recorded in thread ${thread}; it takes effect on the next run (e.g. codex-collab run --resume ${thread} "continue").`,
  );
}
