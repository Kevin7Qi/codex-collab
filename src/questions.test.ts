// src/questions.test.ts — Tests for the ask-channel question mailbox

import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import {
  DEFAULT_ASK_TIMEOUT_SEC,
  answerPath,
  generateQuestionId,
  isQuestionPending,
  listPendingQuestions,
  listQuestions,
  loadQuestion,
  markerAnswered,
  markerExpired,
  markerPosted,
  parseQuestionMarker,
  pollForAnswer,
  questionPath,
  questionSummary,
  removeQuestion,
  sanitizeForTerminal,
  sweepQuestions,
  updateQuestion,
  writeAnswer,
  writeQuestion,
} from "./questions";
import type { QuestionRecord } from "./types";

const tmpRoot = join(process.env.TMPDIR ?? "/tmp", "questions-test-" + process.pid);
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshMailbox(): string {
  const dir = join(tmpRoot, `mb-${dirCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRecord(overrides?: Partial<QuestionRecord>): QuestionRecord {
  const now = Date.now();
  return {
    id: generateQuestionId(),
    question: "Drop the FK constraints or dual-write?\nContext: audit_log references sessions.",
    askedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEFAULT_ASK_TIMEOUT_SEC * 1000).toISOString(),
    workspaceDir: "/tmp/ws",
    pid: process.pid,
    ...overrides,
  };
}

describe("question IDs", () => {
  test("are q + 7 hex chars and marker-parseable", () => {
    const id = generateQuestionId();
    expect(id).toMatch(/^q[0-9a-f]{7}$/);
  });
});

describe("mailbox roundtrip", () => {
  test("write, load, answer, remove", async () => {
    const dir = freshMailbox();
    const record = makeRecord();
    writeQuestion(dir, record);

    const loaded = loadQuestion(dir, record.id);
    expect(loaded).toEqual(record);
    expect(isQuestionPending(dir, loaded!)).toBe(true);

    writeAnswer(dir, record.id, "Dual-write. The audit trail feeds compliance.");
    expect(isQuestionPending(dir, loaded!)).toBe(false);

    const answer = await pollForAnswer(dir, record.id, Date.now() + 1000, 10);
    expect(answer).toBe("Dual-write. The audit trail feeds compliance.");

    removeQuestion(dir, record.id);
    expect(existsSync(questionPath(dir, record.id))).toBe(false);
    expect(existsSync(answerPath(dir, record.id))).toBe(false);
  });

  test("writeQuestion creates the mailbox dir on demand", () => {
    const dir = join(freshMailbox(), "nested", "questions");
    const record = makeRecord();
    writeQuestion(dir, record);
    expect(loadQuestion(dir, record.id)).toEqual(record);
  });

  test("pollForAnswer returns null when the deadline lapses", async () => {
    const dir = freshMailbox();
    const record = makeRecord();
    writeQuestion(dir, record);
    const answer = await pollForAnswer(dir, record.id, Date.now() + 40, 10);
    expect(answer).toBeNull();
  });

  test("loadQuestion rejects corrupt and wrong-shape files", () => {
    const dir = freshMailbox();
    writeFileSync(join(dir, "qbadjson1.json"), "{nope", { mode: 0o600 });
    writeFileSync(join(dir, "qbadshape.json"), JSON.stringify({ id: 42 }), { mode: 0o600 });
    expect(loadQuestion(dir, "qbadjson1")).toBeNull();
    expect(loadQuestion(dir, "qbadshape")).toBeNull();
    // And listQuestions skips them without throwing
    expect(listQuestions(dir)).toEqual([]);
  });
});

describe("pending semantics", () => {
  test("expired flag, past deadline, and answered all end pending state", () => {
    const dir = freshMailbox();
    const flagged = makeRecord({ expired: true });
    const past = makeRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const answered = makeRecord();
    const live = makeRecord();
    for (const r of [flagged, past, answered, live]) writeQuestion(dir, r);
    writeAnswer(dir, answered.id, "yes");

    const pending = listPendingQuestions(dir);
    expect(pending.map((r) => r.id)).toEqual([live.id]);
  });

  test("updateQuestion stamps expired in place", () => {
    const dir = freshMailbox();
    const record = makeRecord();
    writeQuestion(dir, record);
    updateQuestion(dir, { ...record, expired: true });
    expect(loadQuestion(dir, record.id)?.expired).toBe(true);
    expect(isQuestionPending(dir, loadQuestion(dir, record.id)!)).toBe(false);
  });

  test("listQuestions sorts oldest first", () => {
    const dir = freshMailbox();
    const older = makeRecord({ askedAt: new Date(Date.now() - 60_000).toISOString() });
    const newer = makeRecord();
    writeQuestion(dir, newer);
    writeQuestion(dir, older);
    expect(listQuestions(dir).map((r) => r.id)).toEqual([older.id, newer.id]);
  });
});

describe("markers", () => {
  test("all three marker kinds roundtrip through the parser", () => {
    const id = generateQuestionId();
    expect(parseQuestionMarker(markerPosted(id, 600))).toEqual({ id, kind: "posted", seconds: 600 });
    expect(parseQuestionMarker(markerAnswered(id, 161))).toEqual({ id, kind: "answered", seconds: 161 });
    expect(parseQuestionMarker(markerExpired(id, 600))).toEqual({ id, kind: "expired", seconds: 600 });
  });

  test("trailing whitespace (CR) is tolerated, non-markers are not", () => {
    const id = generateQuestionId();
    expect(parseQuestionMarker(markerPosted(id, 60) + "\r")).not.toBeNull();
    expect(parseQuestionMarker("  " + markerPosted(id, 60))).toBeNull(); // indented = neutralized
    expect(parseQuestionMarker("[codex-collab] question notanid posted (deadline 60s)")).toBeNull();
    expect(parseQuestionMarker(`[codex-collab] question ${id} exploded (after 60s)`)).toBeNull();
    expect(parseQuestionMarker("plain output line")).toBeNull();
  });
});

describe("sweep", () => {
  test("removes only non-pending files older than maxAge", () => {
    const dir = freshMailbox();
    const oldRecord = makeRecord({ expired: true }); // resolved — sweepable
    const newRecord = makeRecord();
    writeQuestion(dir, oldRecord);
    writeQuestion(dir, newRecord);
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(questionPath(dir, oldRecord.id), twoDaysAgo, twoDaysAgo);

    const deleted = sweepQuestions(dir, 24 * 3600 * 1000);
    expect(deleted).toBe(1);
    expect(loadQuestion(dir, oldRecord.id)).toBeNull();
    expect(loadQuestion(dir, newRecord.id)).not.toBeNull();
  });

  test("missing mailbox dir sweeps nothing", () => {
    expect(sweepQuestions(join(tmpRoot, "does-not-exist"), 1000)).toBe(0);
  });
});

describe("text helpers", () => {
  test("questionSummary takes the first line and clips", () => {
    expect(questionSummary("short question\nsecond line")).toBe("short question");
    const long = "x".repeat(300);
    expect(questionSummary(long).length).toBe(160);
    expect(questionSummary(long).endsWith("…")).toBe(true);
  });

  test("sanitizeForTerminal strips control chars but keeps newlines and tabs", () => {
    expect(sanitizeForTerminal("a\x1b[31mred\x07\nb\tc")).toBe("a[31mred\nb\tc");
  });
});

describe("orphaned questions (review round 2)", () => {
  const { isAskerAlive } = require("./questions") as typeof import("./questions");
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

  /** A PID guaranteed dead: spawn a no-op process and wait for it to exit. */
  function deadPid(): number {
    const result = spawnSync(process.execPath, ["--version"], { stdio: "ignore" });
    if (typeof result.pid !== "number" || result.pid <= 0) throw new Error("could not obtain dead pid");
    return result.pid;
  }

  test("a question whose asker died is not pending, not listed, not answerable-looking", () => {
    const dir = freshMailbox();
    const orphan = makeRecord({ pid: deadPid() });
    const live = makeRecord(); // our own pid — alive
    writeQuestion(dir, orphan);
    writeQuestion(dir, live);

    expect(isAskerAlive(orphan)).toBe(false);
    expect(isAskerAlive(live)).toBe(true);
    expect(isQuestionPending(dir, orphan)).toBe(false);
    expect(listPendingQuestions(dir).map((r) => r.id)).toEqual([live.id]);
  });

  test("legacy records without a usable pid are never suppressed", () => {
    expect(isAskerAlive(makeRecord({ pid: 0 }))).toBe(true);
    expect(isAskerAlive(makeRecord({ pid: -1 }))).toBe(true);
    expect(isAskerAlive({ ...makeRecord(), pid: undefined as unknown as number })).toBe(true);
  });
});

describe("exclusive answer claim (review round 2)", () => {
  const { writeAnswerExclusive } = require("./questions") as typeof import("./questions");

  test("first responder wins, second is rejected, first answer survives", async () => {
    const dir = freshMailbox();
    const record = makeRecord();
    writeQuestion(dir, record);

    expect(writeAnswerExclusive(dir, record.id, "first answer")).toBe(true);
    expect(writeAnswerExclusive(dir, record.id, "second answer")).toBe(false);

    const answer = await pollForAnswer(dir, record.id, Date.now() + 500, 10);
    expect(answer).toBe("first answer");
  });

  test("removeQuestion cleans the claim so files never linger", () => {
    const dir = freshMailbox();
    const record = makeRecord();
    writeQuestion(dir, record);
    writeAnswerExclusive(dir, record.id, "answer");
    removeQuestion(dir, record.id);
    const { readdirSync } = require("fs") as typeof import("fs");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("ask invocation detection", () => {
  const { looksLikeAskInvocation } = require("./questions") as typeof import("./questions");

  test("recognizes genuine invocations", () => {
    expect(looksLikeAskInvocation(`codex-collab ask "which way?"`)).toBe(true);
    expect(looksLikeAskInvocation(`/bin/zsh -lc 'codex-collab ask "which way?"'`)).toBe(true);
    expect(looksLikeAskInvocation(`sh -c "codex-collab ask 'q'"`)).toBe(true);
    expect(looksLikeAskInvocation(`/bin/zsh -lc 'cat q.md | codex-collab ask -'`)).toBe(true);
    expect(looksLikeAskInvocation(`cd /repo && codex-collab ask "q"`)).toBe(true);
  });

  test("rejects mere mentions", () => {
    expect(looksLikeAskInvocation(`grep -rh "codex-collab ask" docs/`)).toBe(false);
    expect(looksLikeAskInvocation(`echo 'codex-collab ask'`)).toBe(false);
    expect(looksLikeAskInvocation(`cat "/notes/codex-collab ask.md"`)).toBe(false);
    expect(looksLikeAskInvocation(`git log --grep 'codex-collab ask stuff'`)).toBe(false);
    expect(looksLikeAskInvocation(`codex-collab answer q1234567 "text"`)).toBe(false);
  });
});

describe("mailbox privacy verification", () => {
  const { verifyMailboxDir } = require("./questions") as typeof import("./questions");
  const { chmodSync, symlinkSync } = require("fs") as typeof import("fs");

  test("a private mailbox passes and roundtrips", () => {
    const dir = freshMailbox();
    verifyMailboxDir(dir); // must not throw
    const record = makeRecord();
    writeQuestion(dir, record);
    expect(loadQuestion(dir, record.id)).toEqual(record);
  });

  test("a group/world-writable mailbox is refused", () => {
    const dir = freshMailbox();
    chmodSync(dir, 0o777);
    expect(() => verifyMailboxDir(dir)).toThrow(/not private/);
    expect(() => writeQuestion(dir, makeRecord())).toThrow(/not private/);
    expect(() => listQuestions(dir)).toThrow(/not private/);
    chmodSync(dir, 0o700); // restore for cleanup
  });

  test("a symlinked mailbox is refused", () => {
    const realDir = freshMailbox();
    const linkPath = join(tmpRoot, `mb-link-${Date.now()}`);
    symlinkSync(realDir, linkPath);
    expect(() => verifyMailboxDir(linkPath)).toThrow(/not private/);
  });
});

describe("sweep safety", () => {
  const { symlinkSync } = require("fs") as typeof import("fs");

  test("a symlinked mailbox is not swept and its target stays intact", () => {
    const realDir = freshMailbox();
    const record = makeRecord();
    writeQuestion(realDir, record);
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(questionPath(realDir, record.id), old, old);

    const linkPath = join(tmpRoot, `mb-sweep-link-${Date.now()}`);
    symlinkSync(realDir, linkPath);

    expect(sweepQuestions(linkPath, 24 * 3600 * 1000)).toBe(0);
    expect(loadQuestion(realDir, record.id)).not.toBeNull(); // untouched
  });

  test("unexpected filenames are never deleted, even when old", () => {
    const dir = freshMailbox();
    const strayPath = join(dir, "unrelated.txt");
    writeFileSync(strayPath, "not ours to delete", { mode: 0o600 });
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(strayPath, old, old);

    expect(sweepQuestions(dir, 24 * 3600 * 1000)).toBe(0);
    expect(existsSync(strayPath)).toBe(true);
  });
});

describe("review-hardening regressions", () => {
  const { looksLikeAskInvocation, isStdinAskInvocation, isAskerAlive } =
    require("./questions") as typeof import("./questions");

  test("unquoted mentions are rejected; prefix wrappers are accepted false negatives", () => {
    // The whitespace hole: an unquoted grep pattern is a mention, not an invocation.
    expect(looksLikeAskInvocation(`grep -rh codex-collab ask logs/`)).toBe(false);
    expect(looksLikeAskInvocation(`echo codex-collab ask`)).toBe(false);
    // Documented degradation: prefix commands are missed — enrichment-only cost.
    expect(looksLikeAskInvocation(`timeout 600 codex-collab ask "q"`)).toBe(false);
    // Command positions still recognized.
    expect(looksLikeAskInvocation(`codex-collab ask "q"`)).toBe(true);
    expect(looksLikeAskInvocation(`cd /repo && codex-collab ask "q"`)).toBe(true);
    expect(looksLikeAskInvocation(`/bin/zsh -lc 'cat q.md | codex-collab ask -'`)).toBe(true);
  });

  test("stdin ask detection", () => {
    expect(isStdinAskInvocation(`/bin/zsh -lc 'cat q.md | codex-collab ask -'`)).toBe(true);
    expect(isStdinAskInvocation(`codex-collab ask - --timeout 60`)).toBe(true);
    expect(isStdinAskInvocation(`codex-collab ask "a question"`)).toBe(false);
  });

  test("loadQuestion rejects a record missing askedAt instead of crashing listQuestions", () => {
    const dir = freshMailbox();
    const id = generateQuestionId();
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, question: "q", expiresAt: new Date(Date.now() + 60_000).toISOString(),
      workspaceDir: "/tmp/ws", pid: process.pid,
    }), { mode: 0o600 });
    expect(loadQuestion(dir, id)).toBeNull();
    expect(listQuestions(dir)).toEqual([]); // sorts without throwing
  });

  test("sweep never deletes a still-pending question with a live asker", () => {
    const dir = freshMailbox();
    const longAsk = makeRecord({ expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString() });
    writeQuestion(dir, longAsk);
    const old = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    utimesSync(questionPath(dir, longAsk.id), old, old);

    expect(isAskerAlive(longAsk)).toBe(true);
    expect(sweepQuestions(dir, 24 * 3600 * 1000)).toBe(0);
    expect(loadQuestion(dir, longAsk.id)).not.toBeNull();

    // …but an expired one of the same age is swept.
    updateQuestion(dir, { ...longAsk, expired: true });
    utimesSync(questionPath(dir, longAsk.id), old, old);
    expect(sweepQuestions(dir, 24 * 3600 * 1000)).toBe(1);
  });
});
