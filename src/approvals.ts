// src/approvals.ts — Approval handler abstraction

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type {
  ApprovalDecision,
  CommandApprovalRequest,
  FileChangeApprovalRequest,
} from "./types";
import { validateId } from "./config";

export interface ApprovalHandler {
  handleCommandApproval(req: CommandApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  handleFileChangeApproval(req: FileChangeApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
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

/** Max time to wait for a human approval decision before giving up. */
const APPROVAL_TIMEOUT_MS = 3_600_000; // 1 hour

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface InteractiveApprovalOptions {
  /** Workspace dir echoed in the approve/decline hint (falls back to the request's cwd). */
  workspaceDir?: string;
  /** Decision-file poll interval in ms (default 1000; tests use small values). */
  pollIntervalMs?: number;
}

/** File-based IPC approval handler. Writes a .json request file, then polls for
 *  a .decision file created by `codex-collab approve/decline` in a separate process. */
export class InteractiveApprovalHandler implements ApprovalHandler {
  private workspaceDir?: string;
  private pollIntervalMs: number;

  constructor(
    private approvalsDir: string,
    private onProgress: (line: string) => void,
    opts?: InteractiveApprovalOptions,
  ) {
    this.workspaceDir = opts?.workspaceDir;
    this.pollIntervalMs = opts?.pollIntervalMs ?? 1000;
    if (!existsSync(approvalsDir)) mkdirSync(approvalsDir, { recursive: true, mode: 0o700 });
  }

  async handleCommandApproval(req: CommandApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = validateId(req.approvalId ?? req.itemId);
    const cwd = this.workspaceDir ?? req.cwd;
    const dirFlag = cwd ? ` -d ${shellQuote(cwd)}` : "";
    this.onProgress(`APPROVAL NEEDED`);
    this.onProgress(`  Command: ${req.command ?? "(no command)"}`);
    if (req.reason) this.onProgress(`  Reason: ${req.reason}`);
    this.onProgress(`  Approve: codex-collab approve ${id}${dirFlag}`);
    this.onProgress(`  Decline: codex-collab decline ${id}${dirFlag}`);

    this.writeRequestFile(id, {
      type: "commandExecution",
      command: req.command,
      cwd: req.cwd,
      workspaceDir: cwd,
      reason: req.reason,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id, APPROVAL_TIMEOUT_MS, signal);
  }

  async handleFileChangeApproval(req: FileChangeApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    const id = validateId(req.itemId);
    const cwd = this.workspaceDir ?? req.grantRoot;
    const dirFlag = cwd ? ` -d ${shellQuote(cwd)}` : "";
    this.onProgress(`APPROVAL NEEDED (file change)`);
    if (req.reason) this.onProgress(`  Reason: ${req.reason}`);
    this.onProgress(`  Approve: codex-collab approve ${id}${dirFlag}`);
    this.onProgress(`  Decline: codex-collab decline ${id}${dirFlag}`);

    this.writeRequestFile(id, {
      type: "fileChange",
      reason: req.reason,
      grantRoot: req.grantRoot,
      workspaceDir: cwd,
      threadId: req.threadId,
      turnId: req.turnId,
    });

    return this.pollForDecision(id, APPROVAL_TIMEOUT_MS, signal);
  }

  private writeRequestFile(id: string, data: unknown): void {
    try {
      writeFileSync(join(this.approvalsDir, `${id}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (e) {
      console.error(`[codex] Failed to write approval request: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  }

  private async pollForDecision(id: string, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalDecision> {
    const decisionPath = join(this.approvalsDir, `${id}.decision`);
    const requestPath = join(this.approvalsDir, `${id}.json`);
    const deadline = Date.now() + timeoutMs;

    const cleanup = () => {
      for (const path of [decisionPath, requestPath]) {
        try {
          unlinkSync(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            console.error(`[codex] Warning: Failed to clean up ${path}: ${(e as Error).message}`);
          }
        }
      }
    };

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        cleanup();
        throw new Error(`Approval ${id} cancelled`);
      }
      if (existsSync(decisionPath)) {
        let decision: string;
        try {
          decision = readFileSync(decisionPath, "utf-8").trim();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          // Remove the request/decision files before propagating — otherwise
          // the orphaned request lingers until `clean`'s 1-day sweep.
          cleanup();
          throw e;
        }
        cleanup();
        const validDecisions = new Set(["accept", "acceptForSession", "decline", "cancel"]);
        if (!validDecisions.has(decision)) {
          console.error(`[codex] Warning: Invalid decision "${decision}" for approval ${id}, treating as decline`);
          return "decline";
        }
        return decision as ApprovalDecision;
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    cleanup();
    throw new Error(`Approval ${id} timed out waiting for decision after ${timeoutMs / 1000}s`);
  }
}
