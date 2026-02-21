// src/turns.ts — Turn lifecycle (runTurn, runReview)

import type { AppServerClient } from "./protocol";
import type {
  UserInput, TurnStartParams, TurnStartResponse, TurnCompletedParams,
  ReviewTarget, ReviewStartParams, ReviewDelivery,
  TurnResult, ItemStartedParams, ItemCompletedParams, DeltaParams,
  CommandApprovalRequest, FileChangeApprovalRequest,
  AgentMessageItem,
} from "./types";
import type { EventDispatcher } from "./events";
import type { ApprovalHandler } from "./approvals";

export interface TurnOptions {
  dispatcher: EventDispatcher;
  approvalHandler: ApprovalHandler;
  timeoutMs: number;
  cwd?: string;
  model?: string;
  effort?: string;
  approvalPolicy?: string;
}

export interface ReviewOptions extends TurnOptions {
  delivery?: ReviewDelivery;
}

/**
 * Run a single turn: send input, wire up event/approval handlers,
 * wait for turn/completed, and return a structured TurnResult.
 */
export async function runTurn(
  client: AppServerClient,
  threadId: string,
  input: UserInput[],
  opts: TurnOptions,
): Promise<TurnResult> {
  const params: TurnStartParams = {
    threadId,
    input,
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    approvalPolicy: opts.approvalPolicy,
  };

  return executeTurn(client, "turn/start", params, opts);
}

/**
 * Run a review turn: same lifecycle as runTurn but sends review/start
 * instead of turn/start.
 */
export async function runReview(
  client: AppServerClient,
  threadId: string,
  target: ReviewTarget,
  opts: ReviewOptions,
): Promise<TurnResult> {
  const params: ReviewStartParams = {
    threadId,
    target,
    delivery: opts.delivery,
  };

  return executeTurn(client, "review/start", params, opts);
}

/**
 * Shared turn lifecycle: register handlers, send the start request,
 * wait for completion, collect results, and clean up.
 */
async function executeTurn(
  client: AppServerClient,
  method: string,
  params: TurnStartParams | ReviewStartParams,
  opts: TurnOptions,
): Promise<TurnResult> {
  const startTime = Date.now();
  opts.dispatcher.reset();

  const unsubs = registerEventHandlers(client, opts);

  const { turn } = await client.request<TurnStartResponse>(method, params);

  const completedTurn = await waitForTurnCompletion(client, turn.id, opts.timeoutMs);

  for (const unsub of unsubs) unsub();

  opts.dispatcher.flush();

  let output = opts.dispatcher.getAccumulatedOutput();
  if (!output && completedTurn.turn.items) {
    const agentMsg = completedTurn.turn.items.find(
      (i): i is AgentMessageItem => i.type === "agentMessage",
    );
    if (agentMsg) output = agentMsg.text;
  }

  return {
    status: completedTurn.turn.status as TurnResult["status"],
    output,
    filesChanged: opts.dispatcher.getFilesChanged(),
    commandsRun: opts.dispatcher.getCommandsRun(),
    error: completedTurn.turn.error?.message,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Register notification and approval request handlers on the client.
 * Returns an array of unsubscribe functions for cleanup.
 */
function registerEventHandlers(client: AppServerClient, opts: TurnOptions): Array<() => void> {
  const { dispatcher, approvalHandler } = opts;
  const unsubs: Array<() => void> = [];

  // Notification handlers
  unsubs.push(
    client.on("item/started", (params) => {
      dispatcher.handleItemStarted(params as ItemStartedParams);
    }),
  );

  unsubs.push(
    client.on("item/completed", (params) => {
      dispatcher.handleItemCompleted(params as ItemCompletedParams);
    }),
  );

  // Delta notifications
  for (const method of [
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/reasoning/summaryTextDelta",
  ]) {
    unsubs.push(
      client.on(method, (params) => {
        dispatcher.handleDelta(method, params as DeltaParams);
      }),
    );
  }

  // Approval requests (server -> client requests expecting a response).
  // The AppServerClient.onRequest handler returns the result directly;
  // the client takes care of sending the JSON-RPC response.
  unsubs.push(
    client.onRequest(
      "item/commandExecution/requestApproval",
      async (params) => {
        const decision = await approvalHandler.handleCommandApproval(
          params as CommandApprovalRequest,
        );
        return { decision };
      },
    ),
  );

  unsubs.push(
    client.onRequest(
      "item/fileChange/requestApproval",
      async (params) => {
        const decision = await approvalHandler.handleFileChangeApproval(
          params as FileChangeApprovalRequest,
        );
        return { decision };
      },
    ),
  );

  return unsubs;
}

/**
 * Wait for a turn/completed notification matching the given turnId.
 * Rejects with a timeout error if the notification doesn't arrive in time.
 */
function waitForTurnCompletion(
  client: AppServerClient,
  turnId: string,
  timeoutMs: number,
): Promise<TurnCompletedParams> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;

    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error(`Turn timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    unsub = client.on("turn/completed", (params) => {
      const p = params as TurnCompletedParams;
      if (p.turn.id === turnId) {
        clearTimeout(timer);
        if (unsub) unsub();
        resolve(p);
      }
    });
  });
}
