// src/events.ts — Event dispatcher for app server notifications

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import {
  isKnownItem,
  type ItemStartedParams, type ItemCompletedParams, type DeltaParams,
  type ErrorNotificationParams, type AutoApprovalReviewParams,
  type FileChange, type CommandExec,
  type PendingQuestion, type ResolvedQuestion,
} from "./types";
import { saveGuardianDenial } from "./guardian";
import { shellQuote } from "./approvals";
import {
  answerPath,
  isStdinAskInvocation,
  listPendingQuestions,
  loadQuestion,
  looksLikeAskInvocation,
  parseQuestionMarker,
  questionSummary,
} from "./questions";

type ProgressCallback = (line: string) => void;

/** Wiring for the ask channel: where to read question files from and how to
 *  mirror pending/resolved state onto the run record. Set by the turn owner
 *  once the runId is known (setQuestionContext). */
export interface QuestionStreamContext {
  mailboxDir: string;
  /** Echoed in the answer hint (falls back to the question's workspaceDir). */
  workspaceDir?: string;
  /** Fired with the question when one is posted, and with null on every
   *  resolution — mirrors PendingApproval's onPending contract. */
  onPending?: (pending: PendingQuestion | null) => void;
  /** Fired once per question when it resolves (answered or expired). */
  onResolved?: (resolved: ResolvedQuestion) => void;
}

export class EventDispatcher {
  private accumulatedOutput = "";
  private finalAnswerOutput = "";
  /** Set from `exitedReviewMode.review`. For review turns this IS the
   *  deliverable; it takes precedence over the short final_answer sign-off
   *  Codex tags on at the end (which used to shadow the full review body). */
  private reviewOutput = "";
  private filesChanged: FileChange[] = [];
  private commandsRun: CommandExec[] = [];
  private logBuffer: string[] = [];
  private logPath: string;
  private onProgress: ProgressCallback;
  /** When set, denied Guardian reviews are persisted here so the user can
   *  override them later with `approve --guardian`. */
  private guardianDir: string | null;
  /** Ask-channel wiring; null until the turn owner calls setQuestionContext. */
  private questionCtx: QuestionStreamContext | null = null;
  /** Item IDs of commands that are `codex-collab ask` invocations. Marker
   *  parsing is restricted to THESE items' output — without the gate, any
   *  command whose stdout contains a marker-shaped line (a cat of a log, a
   *  grep, prompt-injected output) could fabricate or fake-resolve question
   *  state on the run record. */
  private askCommandItems = new Set<string>();
  /** Partial trailing line of each ask command's output stream, keyed by
   *  item ID — markers can split across delta chunks, and concurrent
   *  commands' deltas interleave. Bounded (a marker line is short; anything
   *  longer is not a marker). */
  private commandOutputTails = new Map<string, string>();
  /** Summaries of questions seen posted this turn, so resolved entries carry
   *  them without re-reading a (possibly deleted) question file. */
  private postedQuestions = new Map<string, { summary: string | null; askedAt: string }>();
  /** Question events already handled (`id:kind`), shared by every detection
   *  path — output-delta markers, aggregated-output markers, and the mailbox
   *  watchers — so each event fires exactly once no matter which path wins. */
  private seenQuestionMarkers = new Set<string>();
  /** Mailbox watchers. Codex ≥0.142 runs commands through session-based
   *  exec, where output deltas are not a reliable LIVE channel — the posted
   *  marker may only surface at command completion, long after the question
   *  needed announcing. The mailbox is the source of truth, so an `ask`
   *  command *starting* arms a short scan for its question file, and each
   *  posted question gets a resolution watcher. Markers remain the fast
   *  path and refine latency when they do arrive. All timers are unref'd
   *  (they must never hold the process open) and cleared on reset. */
  private askScanTimer: ReturnType<typeof setInterval> | null = null;
  private askScanDeadline = 0;
  private askScanSince = 0;
  /** When the current scan was armed (no clock-skew backdate) — the
   *  sole-candidate fallback only trusts questions posted after this, so a
   *  concurrent run's slightly-older question can't be claimed while our
   *  own ask hasn't written its file yet. */
  private askScanArmedAt = 0;
  /** The ask command line the scan was armed for. `ask "…"` embeds the
   *  question text in the command, so candidates can be matched to THIS
   *  run's ask — without it, two workspace runs asking within the same
   *  window could attribute each other's questions. */
  private askScanCommand = "";
  /** Armed command is a stdin ask (`ask -`) — the only form where text
   *  matching is impossible and the sole-candidate fallback is justified. */
  private askScanStdin = false;
  /** Questions posted this turn that have not yet resolved — the run
   *  record's pendingQuestion mirror shows the newest of these, so
   *  resolving one question must not blank the mirror while another is
   *  still awaiting an answer. */
  private livePendingQuestions = new Map<string, PendingQuestion>();
  private resolutionWatchers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    logPath: string,
    onProgress?: ProgressCallback,
    guardianDir?: string,
  ) {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.logPath = logPath;
    this.onProgress = onProgress ?? ((line) => process.stderr.write(line + "\n"));
    this.guardianDir = guardianDir ?? null;
  }

  handleItemStarted(params: ItemStartedParams): void {
    const { item } = params;
    if (!isKnownItem(item)) return;

    if (item.type === "commandExecution") {
      this.progress(`Running: ${item.command}`);
      // An `ask` starting is the live signal a question is imminent. Session
      // -based exec makes output deltas unreliable as a LIVE channel, so the
      // question is surfaced from the mailbox itself.
      // Invocation detection, not substring match — a grep/echo that merely
      // MENTIONS the command must not feed marker parsing or arm the scan.
      if (this.questionCtx && looksLikeAskInvocation(item.command)) {
        this.askCommandItems.add(item.id);
        this.armAskScan(item.command);
      }
    }

    // Separate consecutive messages
    if (item.type === "agentMessage" && this.accumulatedOutput.length > 0) {
      this.accumulatedOutput += "\n";
    }
  }

  handleItemCompleted(params: ItemCompletedParams): void {
    const { item } = params;
    if (!isKnownItem(item)) return;

    // Track agent message phases for output filtering
    if (item.type === "agentMessage") {
      if (item.phase === "final_answer") {
        // Final answer: append text (supports multiple final_answer messages)
        if (item.text) {
          if (this.finalAnswerOutput.length > 0) {
            this.finalAnswerOutput += "\n";
          }
          this.finalAnswerOutput += item.text;
        }
      } else if (item.text) {
        // Intermediate agent message (planning/status): show as progress
        const preview = item.text.length > 120
          ? item.text.slice(0, 117) + "..."
          : item.text;
        this.progress(preview);
      }
    }

    switch (item.type) {
      case "commandExecution": {
        // Fallback marker scan: if the output deltas were not delivered for
        // this command, the aggregated output still carries the ask markers
        // (seenQuestionMarkers dedupes against the delta path). Gated on the
        // command itself being an ask — same spoofing concern as the deltas.
        if (
          this.questionCtx &&
          looksLikeAskInvocation(item.command) &&
          typeof item.aggregatedOutput === "string" &&
          item.aggregatedOutput.includes("[codex-collab] question ")
        ) {
          for (const line of item.aggregatedOutput.split("\n")) this.handleMarkerLine(line);
        }
        this.askCommandItems.delete(item.id);
        this.commandOutputTails.delete(item.id);
        if (item.status !== "completed") {
          this.progress(`Command ${item.status}: ${item.command}`);
          break;
        }
        this.commandsRun.push({
          command: item.command,
          exitCode: item.exitCode ?? null,
          durationMs: item.durationMs ?? null,
        });
        const exit = item.exitCode ?? "?";
        this.log(`command: ${item.command} (exit ${exit})`);
        break;
      }
      case "fileChange": {
        if (item.status !== "completed") {
          const paths = item.changes.map(c => c.path).join(", ");
          this.progress(`File change ${item.status}: ${paths || "(no paths)"}`);
          break;
        }
        for (const change of item.changes) {
          this.filesChanged.push({
            path: change.path,
            kind: change.kind.type,
            diff: change.diff,
          });
          this.progress(`Edited: ${change.path} (${change.kind.type})`);
        }
        break;
      }
      case "exitedReviewMode": {
        this.accumulatedOutput = item.review;
        this.reviewOutput = item.review;
        this.log(`review output (${item.review.length} chars)`);
        break;
      }
    }
  }

  /** Log-only sink for out-of-band lines that already reached the console by
   *  another path (e.g. approval prompts, which must stay visible even under
   *  --content-only). Writes the `[codex]`-tagged entry to the thread log so
   *  observers that don't own this process's stdout — `follow`, Monitor
   *  scripts, `output` — see the same event stream. */
  logLine(text: string): void {
    this.log(`[codex] ${text}`);
    this.flush();
  }

  handleDelta(method: string, params: DeltaParams): void {
    if (method === "item/agentMessage/delta") {
      this.accumulatedOutput += params.delta;
      // Final-answer text is captured whole from item/completed (deltas
      // always precede their item's completion), so no per-delta routing
      // into finalAnswerOutput is needed here.
    } else if (method === "item/commandExecution/outputDelta") {
      // The ask channel's attribution path: `codex-collab ask` prints marker
      // lines to stdout. Only ask commands' output is scanned — marker-shaped
      // text in any other command's output must stay inert.
      if (this.askCommandItems.has(params.itemId)) {
        this.scanCommandOutput(params.itemId, params.delta);
      }
    }
    // No per-character logging — accumulated text is logged at flush
  }

  // -------------------------------------------------------------------------
  // Ask channel — question markers in the command output stream
  // -------------------------------------------------------------------------

  /** Arm ask-channel handling. Called by the turn owner once the runId is
   *  known; without it, marker lines in command output are ignored. */
  setQuestionContext(ctx: QuestionStreamContext | null): void {
    this.questionCtx = ctx;
  }

  private scanCommandOutput(itemId: string, chunk: string): void {
    if (!this.questionCtx) return;
    let tail = (this.commandOutputTails.get(itemId) ?? "") + chunk;
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    // A marker line is <100 chars; a longer tail can't become one. Keep the
    // buffer bounded against commands that stream huge single-line output.
    if (tail.length > 512) tail = tail.slice(-512);
    this.commandOutputTails.set(itemId, tail);
    for (const line of lines) this.handleMarkerLine(line);
  }

  private handleMarkerLine(line: string): void {
    if (!this.questionCtx) return;
    const marker = parseQuestionMarker(line);
    if (!marker) return;
    if (marker.kind === "posted") {
      this.emitPosted(marker.id, loadQuestion(this.questionCtx.mailboxDir, marker.id), marker.seconds);
    } else {
      // Resolution markers only count for questions posted in THIS turn —
      // a resolved-marker for an unknown id must not append audit entries.
      if (!this.postedQuestions.has(marker.id)) return;
      this.emitResolved(marker.id, marker.kind, marker.kind === "answered" ? marker.seconds * 1000 : undefined);
    }
  }

  /** An `ask` command has started: scan the mailbox briefly for the question
   *  file it is about to write. The askedAt window keeps a concurrent run's
   *  pre-existing question from being attributed to this command. */
  private armAskScan(command: string): void {
    this.askScanArmedAt = Date.now();
    this.askScanSince = this.askScanArmedAt - 2000;
    this.askScanDeadline = this.askScanArmedAt + 20_000;
    this.askScanCommand = normalizeForMatch(command);
    this.askScanStdin = isStdinAskInvocation(command);
    if (this.askScanTimer !== null) return; // already scanning — window extended above
    this.askScanTimer = setInterval(() => this.scanMailboxForPosted(), 1000);
    unrefTimer(this.askScanTimer);
  }

  private stopAskScan(): void {
    if (this.askScanTimer !== null) {
      clearInterval(this.askScanTimer);
      this.askScanTimer = null;
    }
  }

  private scanMailboxForPosted(): void {
    const ctx = this.questionCtx;
    if (!ctx) {
      this.stopAskScan();
      return;
    }
    try {
      const candidates = listPendingQuestions(ctx.mailboxDir).filter((record) => {
        const askedAtMs = Date.parse(record.askedAt);
        return Number.isFinite(askedAtMs)
          && askedAtMs >= this.askScanSince
          && !this.seenQuestionMarkers.has(`${record.id}:posted`);
      });
      // Prefer the candidate whose text appears in the armed command line —
      // that's THIS run's ask. The sole-candidate fallback applies ONLY to
      // stdin asks (where text matching is impossible) and only to
      // questions posted after the command started: a text-bearing ask
      // whose candidate doesn't match must keep scanning until its own
      // file appears, or a concurrent run's question gets claimed and the
      // scan stops before the real one is ever announced. Ambiguity is
      // left for the marker path, which is per-command and cannot
      // misattribute.
      const matched = candidates.find(
        (record) => this.askScanCommand.includes(normalizeForMatch(record.question).slice(0, 80)),
      );
      const fallback = this.askScanStdin
        ? candidates.filter((record) => Date.parse(record.askedAt) >= this.askScanArmedAt)
        : [];
      const pick = matched ?? (fallback.length === 1 ? fallback[0] : undefined);
      if (pick) {
        this.emitPosted(pick.id, pick);
        this.stopAskScan(); // one ask command posts exactly one question
        return;
      }
    } catch (e) {
      console.error(`[codex] Warning: mailbox scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (Date.now() > this.askScanDeadline) this.stopAskScan();
  }

  /** Watch a posted question until it resolves. `ask` deletes the files on
   *  answer and stamps `expired` on timeout, so the mailbox state alone
   *  distinguishes the outcomes; a resolution marker (when the output stream
   *  does deliver one) short-circuits this via the shared dedupe set. */
  private armResolutionWatcher(id: string): void {
    if (this.resolutionWatchers.has(id)) return;
    const timer = setInterval(() => {
      const ctx = this.questionCtx;
      if (!ctx || this.seenQuestionMarkers.has(`${id}:resolved`)) {
        this.stopResolutionWatcher(id);
        return;
      }
      try {
        const record = loadQuestion(ctx.mailboxDir, id);
        if (record?.expired) {
          this.emitResolved(id, "expired");
        } else if (!record || existsSync(answerPath(ctx.mailboxDir, id))) {
          const askedAtMs = Date.parse(this.postedQuestions.get(id)?.askedAt ?? "");
          const latencyMs = Number.isFinite(askedAtMs)
            ? Math.max(1000, Math.round((Date.now() - askedAtMs) / 1000) * 1000)
            : undefined;
          this.emitResolved(id, "answered", latencyMs);
        }
      } catch (e) {
        console.error(`[codex] Warning: question watcher failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 2000);
    unrefTimer(timer);
    this.resolutionWatchers.set(id, timer);
  }

  private stopResolutionWatcher(id: string): void {
    const timer = this.resolutionWatchers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      this.resolutionWatchers.delete(id);
    }
  }

  private emitPosted(id: string, record: ReturnType<typeof loadQuestion>, deadlineSec?: number): void {
    const ctx = this.questionCtx;
    if (!ctx) return;
    const key = `${id}:posted`;
    if (this.seenQuestionMarkers.has(key)) return;
    this.seenQuestionMarkers.add(key);

    const summary = record ? questionSummary(record.question) : null;
    const askedAt = record?.askedAt ?? new Date().toISOString();
    const expiresAt = record?.expiresAt
      ?? new Date(Date.now() + (deadlineSec ?? 600) * 1000).toISOString();
    this.postedQuestions.set(id, { summary, askedAt });

    const remainingSec = Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
    // Like approval prompts, question prompts are actionable and must stay
    // visible even under --content-only — announce bypasses the progress
    // console gate but still lands in the thread log for follow/next/output.
    this.announce(`QUESTION FROM CODEX (expires in ${formatSeconds(remainingSec)})`);
    if (record) {
      const questionLines = record.question.split("\n");
      for (const qLine of questionLines.slice(0, 6)) this.announce(`  ${qLine}`);
      if (questionLines.length > 6) {
        this.announce(`  … (${questionLines.length - 6} more lines — \`codex-collab questions ${id}\` shows the full text)`);
      }
    }
    // shellQuote, not naive interpolation — a quote in the workspace path
    // would break the hint or worse (it's meant to be copy-pasted).
    const dirHint = ctx.workspaceDir ? ` -d ${shellQuote(ctx.workspaceDir)}` : "";
    this.announce(`  Answer: codex-collab answer ${id} "<text>"${dirHint}`);
    const pending: PendingQuestion = { id, summary, askedAt, expiresAt };
    this.livePendingQuestions.set(id, pending);
    this.notifyQuestionPending(pending);
    this.armResolutionWatcher(id);
  }

  private emitResolved(id: string, outcome: "answered" | "expired", latencyMs?: number): void {
    // Single resolution key regardless of outcome: whichever detection path
    // fires first wins, and a late marker can't double-record or contradict.
    const key = `${id}:resolved`;
    if (this.seenQuestionMarkers.has(key)) return;
    this.seenQuestionMarkers.add(key);
    this.stopResolutionWatcher(id);

    const summary = this.postedQuestions.get(id)?.summary ?? null;
    let resolved: ResolvedQuestion;
    if (outcome === "answered") {
      this.announce(`Question ${id} answered${latencyMs !== undefined ? ` after ${formatSeconds(Math.round(latencyMs / 1000))}` : ""}.`);
      resolved = { id, summary, outcome, ...(latencyMs !== undefined ? { latencyMs } : {}) };
    } else {
      this.announce(`Question ${id} expired unanswered — Codex proceeds on its own judgment.`);
      resolved = { id, summary, outcome };
    }
    // The mirror shows the newest still-live question; only blank it when
    // nothing else from this turn is awaiting an answer.
    this.livePendingQuestions.delete(id);
    const remaining = [...this.livePendingQuestions.values()];
    this.notifyQuestionPending(remaining.length > 0 ? remaining[remaining.length - 1] : null);
    try {
      this.questionCtx?.onResolved?.(resolved);
    } catch (e) {
      console.error(`[codex] Warning: question-resolved observer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private notifyQuestionPending(pending: PendingQuestion | null): void {
    try {
      this.questionCtx?.onPending?.(pending);
    } catch (e) {
      console.error(`[codex] Warning: pending-question observer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Console + log, unconditionally — for actionable lines (questions) that
   *  must stay visible under --content-only, mirroring how approval prompts
   *  bypass the progress gate. */
  private announce(text: string): void {
    console.log(`[codex] ${text}`);
    this.log(`[codex] ${text}`);
    this.flush();
  }

  /** Surface Guardian (auto_review) approval reviews in the progress stream
   *  so autonomous permit/reject decisions stay auditable. Observed 0.142
   *  payload: `action.command` (what's under review) and `review.{status,
   *  riskLevel, rationale}` (the verdict) — but the protocol is [UNSTABLE],
   *  so extraction is best-effort with flat-field fallbacks and degrades to
   *  a generic line rather than dropping the event. */
  handleAutoApprovalReview(method: string, params: AutoApprovalReviewParams): void {
    const str = (v: unknown): string | null => {
      if (typeof v === "string" && v.length > 0) return v;
      // Enum-shaped objects like { type: "approved" }
      if (v !== null && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") {
        return (v as { type: string }).type;
      }
      return null;
    };
    const pick = (obj: Record<string, unknown> | undefined, ...keys: string[]): string | null => {
      for (const key of keys) {
        const found = str(obj?.[key]);
        if (found) return found;
      }
      return null;
    };
    const action = params.action as Record<string, unknown> | undefined;
    const review = params.review as Record<string, unknown> | undefined;

    const subject = pick(action, "command", "description") ?? pick(params, "command", "reason", "summary");
    const clipped = subject && subject.length > 120 ? subject.slice(0, 117) + "..." : subject;

    if (method.endsWith("/completed")) {
      const decision = pick(review, "status") ?? pick(params, "decision", "verdict", "outcome", "status");
      const risk = pick(review, "riskLevel");
      const verdict = `${decision ?? "review completed"}${risk ? ` (${risk} risk)` : ""}`;
      this.progress(`Guardian ${verdict}${clipped ? `: ${clipped}` : ""}`);
      // Full payload in the log — the progress line is lossy and the exact
      // decision trail (rationale, decisionSource) matters for auditing an
      // autonomous approval.
      this.log(`guardian review completed: ${safeStringify(params)}`);
      if (decision === "denied" && this.guardianDir) {
        try {
          if (saveGuardianDenial(this.guardianDir, params)) {
            this.progress(
              `Override available: codex-collab approve --guardian ${String(params.reviewId).slice(0, 8)}`,
            );
          }
        } catch (e) {
          // Persistence is best-effort; the denial is still in the log above.
          this.log(`failed to persist guardian denial: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      this.progress(`Guardian reviewing approval request${clipped ? `: ${clipped}` : ""}`);
      this.log(`guardian review started: ${safeStringify(params)}`);
    }
  }

  /** guardianWarning: a human-facing message about a Guardian decision. Fires
   *  on denials AND on risky approvals ("Automatic approval review approved
   *  (risk: medium, authorization: high): <rationale>"). Thread-scoped, no
   *  turnId. This is the primary audit line for Guardian's judgment calls. */
  handleGuardianWarning(params: { message?: unknown }): void {
    const msg = typeof params?.message === "string" && params.message.length > 0
      ? params.message
      : "Guardian issued a warning (no message in payload)";
    this.progress(`Guardian warning: ${msg}`);
  }

  handleError(params: ErrorNotificationParams): void {
    const retry = params.willRetry ? " (will retry)" : "";
    this.progress(`Error: ${params.error.message}${retry}`);
    this.log(`error: ${params.error.message}${retry}`);
  }

  getAccumulatedOutput(): string {
    return this.accumulatedOutput;
  }

  /** Output for `TurnResult.output`, with precedence:
   *  1. `reviewOutput` — set from an `exitedReviewMode` item; for review turns
   *     this is the structured deliverable and must NOT be shadowed by the
   *     short `final_answer` sign-off Codex emits at the end.
   *  2. `finalAnswerOutput` — agentMessage items with phase `"final_answer"`;
   *     for normal run turns this excludes intermediate planning/status noise.
   *  3. `accumulatedOutput` — fall back when neither of the above was seen. */
  getTurnOutput(): string {
    return this.reviewOutput || this.finalAnswerOutput || this.accumulatedOutput;
  }

  getFilesChanged(): FileChange[] {
    return [...this.filesChanged];
  }

  getCommandsRun(): CommandExec[] {
    return [...this.commandsRun];
  }

  reset(): void {
    this.accumulatedOutput = "";
    this.finalAnswerOutput = "";
    this.reviewOutput = "";
    this.filesChanged = [];
    this.commandsRun = [];
    this.askCommandItems.clear();
    this.commandOutputTails.clear();
    this.postedQuestions.clear();
    this.livePendingQuestions.clear();
    this.seenQuestionMarkers.clear();
    this.stopAskScan();
    for (const id of [...this.resolutionWatchers.keys()]) this.stopResolutionWatcher(id);
  }

  /** Write accumulated agent output to the log (called before final flush). */
  flushOutput(): void {
    if (this.accumulatedOutput) {
      this.log(`agent output:\n${this.accumulatedOutput}\n<<END_AGENT_OUTPUT>>`);
    }
  }

  flush(): void {
    if (this.logBuffer.length === 0) return;
    try {
      appendFileSync(this.logPath, this.logBuffer.join("\n") + "\n", { mode: 0o600 });
      this.logBuffer = [];
    } catch (e) {
      console.error(`[codex] Warning: Failed to write log to ${this.logPath}: ${e instanceof Error ? e.message : e}`);
      // Keep buffer — will retry on next flush
    }
  }

  private progress(text: string): void {
    this.onProgress(text);
    this.log(`[codex] ${text}`);
    this.flush();
  }

  private log(entry: string): void {
    const ts = new Date().toISOString();
    this.logBuffer.push(`${ts} ${entry}`);
    // Auto-flush every 20 entries
    if (this.logBuffer.length >= 20) this.flush();
  }
}

/** Collapse shell-quoting differences so question text can be matched
 *  against the command line it was embedded in: strip quotes, backslashes,
 *  and whitespace runs, which `zsh -lc '…'` wrapping and argv re-quoting
 *  rewrite freely. */
function normalizeForMatch(text: string): string {
  return text.replace(/[\\'"]/g, "").replace(/\s+/g, " ");
}

/** Timers here observe state for the user's benefit; they must never hold
 *  the process open after the turn's real work is done. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/** "90s" → "1m 30s"; sub-minute values stay in seconds. Local to avoid an
 *  import cycle with commands/shared (which imports this module). */
function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

/** JSON.stringify that never throws (circular refs) and bounds entry size —
 *  used for logging unstable payloads whose shape we don't control. */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}
