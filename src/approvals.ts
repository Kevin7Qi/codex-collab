// src/approvals.ts — Approval handler abstraction

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import type {
  ApprovalDecision,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
} from "./types";

export interface ApprovalHandler {
  handleCommandApproval(req: CommandApprovalRequest): Promise<ApprovalDecision>;
  handleFileChangeApproval(req: FileChangeApprovalRequest): Promise<ApprovalDecision>;
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

/** Interactive handler: write request to file, poll for decision file. */
export class InteractiveApprovalHandler implements ApprovalHandler {
  constructor(
    private approvalsDir: string,
    private onProgress: (line: string) => void,
    private pollIntervalMs = 1000,
  ) {
    if (!existsSync(approvalsDir)) mkdirSync(approvalsDir, { recursive: true });
  }

  async handleCommandApproval(req: CommandApprovalRequest): Promise<ApprovalDecision> {
    const id = req.approvalId ?? req.itemId;
    this.onProgress(`[codex] APPROVAL NEEDED`);
    this.onProgress(`[codex]   Command: ${req.command}`);
    if (req.reason) this.onProgress(`[codex]   Reason: ${req.reason}`);
    this.onProgress(`[codex]   Approve: codex-collab approve ${id}`);
    this.onProgress(`[codex]   Decline: codex-collab decline ${id}`);

    this.writeRequestFile(id, {
      type: "commandExecution",
      command: req.command,
      cwd: req.cwd,
      reason: req.reason,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id);
  }

  async handleFileChangeApproval(req: FileChangeApprovalRequest): Promise<ApprovalDecision> {
    const id = req.itemId;
    this.onProgress(`[codex] APPROVAL NEEDED (file change)`);
    if (req.reason) this.onProgress(`[codex]   Reason: ${req.reason}`);
    this.onProgress(`[codex]   Approve: codex-collab approve ${id}`);
    this.onProgress(`[codex]   Decline: codex-collab decline ${id}`);

    this.writeRequestFile(id, {
      type: "fileChange",
      reason: req.reason,
      grantRoot: req.grantRoot,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id);
  }

  private writeRequestFile(id: string, data: unknown): void {
    writeFileSync(`${this.approvalsDir}/${id}.json`, JSON.stringify(data, null, 2));
  }

  private async pollForDecision(id: string): Promise<ApprovalDecision> {
    const decisionPath = `${this.approvalsDir}/${id}.decision`;
    const requestPath = `${this.approvalsDir}/${id}.json`;

    while (true) {
      if (existsSync(decisionPath)) {
        const decision = readFileSync(decisionPath, "utf-8").trim();
        // Clean up both files
        try {
          unlinkSync(decisionPath);
        } catch {}
        try {
          unlinkSync(requestPath);
        } catch {}
        return decision === "accept" ? "accept" : "decline";
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }
}
