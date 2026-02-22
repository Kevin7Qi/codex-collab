// src/turns.ts — Turn lifecycle (runTurn, runReview)

import type { AppServerClient } from "./protocol";
import type {
  UserInput, TurnStartParams, TurnStartResponse, TurnCompletedParams,
  ReviewTarget, ReviewStartParams, ReviewDelivery,
  TurnResult, ItemStartedParams, ItemCompletedParams, DeltaParams,
  ErrorNotificationParams,
  CommandApprovalRequest, FileChangeApprovalRequest,
  ApprovalPolicy, ReasoningEffort,
} from "./types";
import type { EventDispatcher } from "./events";
import type { ApprovalHandler } from "./approvals";

export interface TurnOptions {
  dispatcher: EventDispatcher;
  approvalHandler: ApprovalHandler;
  timeoutMs: number;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy?: ApprovalPolicy;
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

  // Subscribe to turn/completed BEFORE sending the request to prevent
  // a race where fast turns complete before we call waitFor(). In the
  // read loop (protocol.ts), a single read() chunk may contain both
  // the response and turn/completed. The while-loop dispatches them
  // synchronously, so the notification handler fires during dispatch —
  // before the response promise resolves (promise continuations are
  // microtasks). This means waitFor() would be called too late.
  const completion = createTurnCompletionAwaiter(client, opts.timeoutMs);
  unsubs.push(completion.unsubscribe);

  try {
    const { turn } = await client.request<TurnStartResponse>(method, params);
    const completedTurn = await completion.waitFor(turn.id);

    opts.dispatcher.flushOutput();
    opts.dispatcher.flush();

    // Output comes from accumulated item/agentMessage/delta notifications
    // (for normal turns) or from exitedReviewMode item/completed notification
    // (for reviews). Note: turn/completed Turn.items is always [] per protocol
    // spec — items are only populated on thread/resume or thread/fork.
    const output = opts.dispatcher.getAccumulatedOutput();

    return {
      status: completedTurn.turn.status as TurnResult["status"],
      output,
      filesChanged: opts.dispatcher.getFilesChanged(),
      commandsRun: opts.dispatcher.getCommandsRun(),
      error: completedTurn.turn.error?.message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    for (const unsub of unsubs) unsub();
  }
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
  ]) {
    unsubs.push(
      client.on(method, (params) => {
        dispatcher.handleDelta(method, params as DeltaParams);
      }),
    );
  }

  // Mid-turn error notifications (e.g. retryable API errors)
  unsubs.push(
    client.on("error", (params) => {
      dispatcher.handleError(params as ErrorNotificationParams);
    }),
  );

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
 * Create a turn/completed awaiter that buffers events from the moment it's
 * created. Call waitFor(turnId) after the request to resolve with the matching
 * completion — even if it arrived before waitFor was called.
 *
 * This eliminates the race between client.request() resolving and registering
 * the turn/completed handler. If turn/completed does not arrive within
 * timeoutMs, the returned promise rejects with a timeout error.
 */
function createTurnCompletionAwaiter(
  client: AppServerClient,
  timeoutMs: number,
): {
  waitFor: (turnId: string) => Promise<TurnCompletedParams>;
  unsubscribe: () => void;
} {
  const buffer: TurnCompletedParams[] = [];
  let resolver: ((p: TurnCompletedParams) => void) | null = null;
  let targetId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const unsub = client.on("turn/completed", (params) => {
    const p = params as TurnCompletedParams;
    if (targetId !== null && p.turn.id === targetId && resolver) {
      clearTimeout(timer);
      resolver(p);
      resolver = null;
    } else {
      buffer.push(p);
    }
  });

  return {
    waitFor(turnId: string): Promise<TurnCompletedParams> {
      const found = buffer.find((p) => p.turn.id === turnId);
      if (found) return Promise.resolve(found);

      return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          resolver = null;
          targetId = null;
          unsub();
          reject(new Error(`Turn timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        // Set resolver before targetId so the notification handler never
        // sees targetId set without a resolver to call.
        resolver = (p) => {
          clearTimeout(timer);
          resolve(p);
        };
        targetId = turnId;
      });
    },
    unsubscribe() {
      unsub();
      clearTimeout(timer);
    },
  };
}
