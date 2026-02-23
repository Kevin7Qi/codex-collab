// src/approvals.ts — Approval handler abstraction

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import type {
  ApprovalDecision,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
} from "./types";

export interface ApprovalHandler {
  handleCommandApproval(req: CommandApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  handleFileChangeApproval(req: FileChangeApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

/** Validate that an ID is safe for use in file paths. */
function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid approval ID: "${id}"`);
  }
  return id;
}

/** Auto-approve all requests immediately. */
export const autoApproveHandler: ApprovalHandler = {
  async handleCommandApproval() {
    return "accept";
  },
  async handleFileChangeApproval() {
    return "accept";
  },
};

/** File-based IPC approval handler. Writes a .json request file, then polls for
 *  a .decision file created by `codex-collab approve/decline` in a separate process. */
export class InteractiveApprovalHandler implements ApprovalHandler {
  constructor(
    private approvalsDir: string,
    private onProgress: (line: string) => void,
    private pollIntervalMs = 1000,
  ) {
    if (!existsSync(approvalsDir)) mkdirSync(approvalsDir, { recursive: true });
  }

  async handleCommandApproval(req: CommandApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = validateId(req.approvalId ?? req.itemId);
    this.onProgress(`APPROVAL NEEDED`);
    this.onProgress(`  Command: ${req.command ?? "(no command)"}`);
    if (req.reason) this.onProgress(`  Reason: ${req.reason}`);
    this.onProgress(`  Approve: codex-collab approve ${id}`);
    this.onProgress(`  Decline: codex-collab decline ${id}`);

    this.writeRequestFile(id, {
      type: "commandExecution",
      command: req.command,
      cwd: req.cwd,
      reason: req.reason,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id, 3_600_000, signal);
  }

  async handleFileChangeApproval(req: FileChangeApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = validateId(req.itemId);
    this.onProgress(`APPROVAL NEEDED (file change)`);
    if (req.reason) this.onProgress(`  Reason: ${req.reason}`);
    this.onProgress(`  Approve: codex-collab approve ${id}`);
    this.onProgress(`  Decline: codex-collab decline ${id}`);

    this.writeRequestFile(id, {
      type: "fileChange",
      reason: req.reason,
      grantRoot: req.grantRoot,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id, 3_600_000, signal);
  }

  private writeRequestFile(id: string, data: unknown): void {
    try {
      writeFileSync(`${this.approvalsDir}/${id}.json`, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[codex] Failed to write approval request: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  }

  private async pollForDecision(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalDecision> {
    const decisionPath = `${this.approvalsDir}/${id}.decision`;
    const requestPath = `${this.approvalsDir}/${id}.json`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error(`Approval ${id} cancelled`);
      }
      if (existsSync(decisionPath)) {
        let decision: string;
        try {
          decision = readFileSync(decisionPath, "utf-8").trim();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        // Clean up files
        for (const path of [decisionPath, requestPath]) {
          try {
            unlinkSync(path);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
              console.error(`[codex] Warning: Failed to clean up ${path}: ${(e as Error).message}`);
            }
          }
        }
        const validDecisions = new Set(["accept", "acceptForSession", "decline", "cancel"]);
        return validDecisions.has(decision) ? (decision as ApprovalDecision) : "decline";
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    throw new Error(`Approval ${id} timed out waiting for decision after ${timeoutMs / 1000}s`);
  }
}
