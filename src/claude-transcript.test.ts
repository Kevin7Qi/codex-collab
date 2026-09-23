// src/claude-transcript.test.ts — reading why a turn failed out of Claude Code's transcript
//
// The transcripts here are written by hand in the shape Claude Code writes
// (verified against a real one: `isApiErrorMessage`, `apiErrorStatus`,
// `error`, `timestamp`). Every reader fails open, so the cases that matter
// most are the broken ones.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationMovedSince, describeTrouble, describeTurnError, firstSaidSince, lastTurnError, transcriptPath, turnEndedOnError, turnErrorsSince, turnTrouble } from "./claude-transcript";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-transcripts-"));
const SID = "4da729ee-d7cf-46e2-b700-a5bfab15c4a6";
const saved = process.env.CODEX_COLLAB_PROJECTS_DIR;

const entry = (o: Record<string, unknown>) => JSON.stringify(o);
const apiError = (at: string, status: number, reason = "server_error") =>
  entry({ type: "assistant", timestamp: at, isApiErrorMessage: true, apiErrorStatus: status, error: reason });

beforeAll(() => {
  process.env.CODEX_COLLAB_PROJECTS_DIR = ROOT;
  const dir = join(ROOT, "-home-user-project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), [
    entry({ type: "user", timestamp: "2026-09-22T01:10:00.000Z" }),
    // Before this task was delivered: another task's trouble, not ours.
    apiError("2026-09-22T01:15:35.355Z", 529),
    entry({ type: "assistant", timestamp: "2026-09-22T01:18:20.000Z" }),
    apiError("2026-09-22T01:18:24.032Z", 500),
    "",
  ].join("\n"));
  writeFileSync(join(dir, "11111111-1111-4111-8111-111111111111.jsonl"), "{ not json\n" + entry({ type: "user" }) + "\n");
});

afterAll(() => {
  if (saved === undefined) delete process.env.CODEX_COLLAB_PROJECTS_DIR;
  else process.env.CODEX_COLLAB_PROJECTS_DIR = saved;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("what the transcript says went wrong", () => {
  test("a turn ended on an error only when the error is the last thing said", () => {
    const dir = join(ROOT, "-home-user-project");
    const sid = "33333333-3333-4333-8333-333333333333";
    const err = apiError("2026-09-22T01:18:24.032Z", 500);
    const said = (at: string) => entry({ type: "assistant", timestamp: at });
    // Claude Code keeps writing bookkeeping after a turn dies: the real
    // transcript of a died turn ends with system/cost-state/last-prompt
    // entries, so those cannot count as something said.
    const bookkeeping = [
      entry({ type: "system", timestamp: "2026-09-22T01:20:13.000Z" }),
      entry({ type: "cost-state" }),
      entry({ type: "last-prompt" }),
      entry({ type: "file-history-snapshot" }),
    ];
    writeFileSync(join(dir, `${sid}.jsonl`), [said("2026-09-22T01:10:00.000Z"), err, ...bookkeeping, ""].join("\n"));
    expect(turnEndedOnError(sid, "2026-09-22T01:18:20.000Z")?.status).toBe(500);
    // Delivered after it: that error belongs to something earlier.
    expect(turnEndedOnError(sid, "2026-09-22T02:00:00.000Z")).toBeNull();
    // Another task's message started a turn of its own before it: the error
    // is that turn's.
    expect(turnEndedOnError(sid, "2026-09-22T01:18:20.000Z", "2026-09-22T01:18:22.000Z")).toBeNull();
    expect(turnEndedOnError(sid, "2026-09-22T01:18:20.000Z", "2026-09-22T01:18:30.000Z")?.status).toBe(500);
    // What was said, and when: bookkeeping written later is not something said.
    expect(firstSaidSince(sid, "2026-09-22T01:00:00.000Z")).toBe("2026-09-22T01:10:00.000Z");
    expect(firstSaidSince(sid, "2026-09-22T01:11:00.000Z")).toBe("2026-09-22T01:18:24.032Z");
    expect(firstSaidSince(sid, "2026-09-22T01:19:00.000Z")).toBeNull();
    expect(conversationMovedSince(sid, "2026-09-22T01:18:00.000Z")).toBe(true);
    expect(conversationMovedSince(sid, "2026-09-22T01:19:00.000Z")).toBe(false);
    expect(firstSaidSince("44444444-4444-4444-8444-444444444444", "2026-09-22T01:00:00.000Z")).toBeNull();
    expect(conversationMovedSince(null, "2026-09-22T01:00:00.000Z")).toBe(false);
    // It hit the error and carried on: the turn did not end there.
    writeFileSync(join(dir, `${sid}.jsonl`), [err, ...bookkeeping, said("2026-09-22T01:19:00.000Z"), ""].join("\n"));
    expect(turnEndedOnError(sid, "2026-09-22T01:18:20.000Z")).toBeNull();
    expect(turnEndedOnError("44444444-4444-4444-8444-444444444444")).toBeNull();
    expect(turnEndedOnError(null)).toBeNull();
  });

  test("trouble is bounded at both ends, so a later task's errors are not this one's", () => {
    expect(turnErrorsSince(SID, "2026-09-22T01:00:00.000Z").length).toBe(2);
    // Finished before the second error: only the first is this task's.
    expect(turnTrouble(SID, "2026-09-22T01:00:00.000Z", "2026-09-22T01:16:00.000Z")?.count).toBe(1);
    expect(turnTrouble(SID, "2026-09-22T01:00:00.000Z", "2026-09-22T01:05:00.000Z")).toBeNull();
  });

  test("a session's transcript is found by its id, wherever its working directory put it", () => {
    expect(transcriptPath(SID)).toBe(join(ROOT, "-home-user-project", `${SID}.jsonl`));
    expect(transcriptPath("22222222-2222-4222-8222-222222222222")).toBeNull();
    // Never a path: an id is searched for, never joined in.
    expect(transcriptPath("../../etc/passwd")).toBeNull();
    expect(transcriptPath("")).toBeNull();
  });

  test("the last API error since the task was delivered, and none from before it", () => {
    expect(lastTurnError(SID, "2026-09-22T01:18:20.000Z")).toEqual({ status: 500, reason: "server_error", at: "2026-09-22T01:18:24.032Z" });
    // Delivered before both: the later one is what is reported.
    expect(lastTurnError(SID, "2026-09-22T01:00:00.000Z")?.status).toBe(500);
    // Delivered after both: this task has hit no trouble.
    expect(lastTurnError(SID, "2026-09-22T02:00:00.000Z")).toBeNull();
    // No session, no transcript, an unreadable one: nothing is claimed.
    expect(lastTurnError(null)).toBeNull();
    expect(lastTurnError(undefined)).toBeNull();
    expect(lastTurnError("22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(lastTurnError("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  test("an error reads as what Claude Code recorded, and a run of them carries its count", () => {
    expect(describeTurnError({ status: 429, reason: "rate_limit", at: "2026-09-22T01:18:24.032Z" })).toBe("429 rate_limit at 2026-09-22T01:18:24.032Z");
    expect(describeTurnError({ status: 500, reason: "server_error", at: "" })).toBe("500 server_error");
    // Whatever a later Claude Code leaves out, the field still reads.
    expect(describeTurnError({ status: null, reason: null, at: "" })).toBe("error");
    expect(describeTrouble({ count: 1, last: { status: 500, reason: "server_error", at: "" } })).toBe("500 server_error");
    expect(describeTrouble({ count: 4, last: { status: 500, reason: "server_error", at: "" } })).toBe("500 server_error (4 since delivery)");
    // Two errors in the fixture since before both of them.
    expect(turnTrouble(SID, "2026-09-22T01:00:00.000Z")?.count).toBe(2);
    expect(turnTrouble(SID, "2026-09-22T02:00:00.000Z")).toBeNull();
  });});
