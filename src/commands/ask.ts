// src/commands/ask.ts — ask command handler (invoked BY CODEX inside a turn)
//
// Posts a question to the workspace mailbox, waits up to the deadline for an
// answer, and resolves exactly one of two ways — both on stdout, which lands
// in Codex's context: an answer (steering), or a graceful "no answer,
// proceed on your best judgment". Exit 0 in both cases: from Codex's point
// of view the tool always succeeds; only the advice differs. Non-zero exits
// are reserved for genuine failures (unwritable mailbox, bad arguments),
// which Codex should see as loud errors, not silent expiry.

import { readFileSync } from "fs";
import { resolveMailboxDir, resolveWorkspaceDir } from "../config";
import {
  DEFAULT_ASK_TIMEOUT_SEC,
  generateQuestionId,
  markerAnswered,
  markerExpired,
  markerPosted,
  pollForAnswer,
  removeQuestion,
  sanitizeForTerminal,
  updateQuestion,
  writeQuestion,
} from "../questions";
import { die, formatDuration, parseOptions } from "./shared";
import type { QuestionRecord } from "../types";

export async function handleAsk(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  // Deliberately no applyUserConfig: the config `timeout` is the TURN
  // timeout; the ask deadline is its own budget with its own default.
  const deadlineSec = options.explicit.has("timeout") ? options.timeout : DEFAULT_ASK_TIMEOUT_SEC;

  let question = positional.join(" ");
  if (question === "-") {
    if (process.stdin.isTTY) console.error("[codex] Reading question from stdin — end with Ctrl-D.");
    question = readFileSync(0, "utf-8");
  }
  question = sanitizeForTerminal(question).trim();
  if (!question) {
    die('No question provided\nUsage: codex-collab ask "question" [--timeout <sec>]');
  }

  const mailboxDir = resolveMailboxDir(options.dir);
  const id = generateQuestionId();
  const askedAt = Date.now();
  const record: QuestionRecord = {
    id,
    question,
    askedAt: new Date(askedAt).toISOString(),
    expiresAt: new Date(askedAt + deadlineSec * 1000).toISOString(),
    workspaceDir: resolveWorkspaceDir(options.dir),
    pid: process.pid,
  };
  try {
    writeQuestion(mailboxDir, record);
  } catch (e) {
    die(`Could not post question (mailbox ${mailboxDir}): ${e instanceof Error ? e.message : String(e)}`);
  }

  // First line is the attribution marker the turn owner parses from the
  // command's output stream; the second is for Codex itself.
  console.log(markerPosted(id, deadlineSec));
  console.log(
    `Question posted. Waiting up to ${formatDuration(deadlineSec * 1000)} for an answer` +
    ` (collaborator answers with: codex-collab answer ${id} "<text>").`,
  );

  const answer = await pollForAnswer(mailboxDir, id, askedAt + deadlineSec * 1000);

  if (answer !== null) {
    const latencySec = Math.max(1, Math.round((Date.now() - askedAt) / 1000));
    console.log(markerAnswered(id, latencySec));
    console.log("");
    console.log(`ANSWER FROM YOUR COLLABORATOR (after ${formatDuration(latencySec * 1000)}):`);
    // Indented so no answer line can sit at column 0 and be mistaken for a
    // marker by the turn owner's line parser.
    for (const line of sanitizeForTerminal(answer).trimEnd().split("\n")) {
      console.log(`  ${line}`);
    }
    removeQuestion(mailboxDir, id);
  } else {
    // Fail open: stamp expired (kept for the audit trail until `clean`
    // sweeps it) and tell Codex to carry on.
    try {
      updateQuestion(mailboxDir, { ...record, expired: true });
    } catch (e) {
      console.error(`[codex] Warning: could not mark question expired: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log(markerExpired(id, deadlineSec));
    console.log("");
    console.log(`NO ANSWER within ${formatDuration(deadlineSec * 1000)}. Proceed on your best judgment.`);
    console.log("Record this open question and the decision you took in your final summary.");
  }
  process.exit(0);
}
