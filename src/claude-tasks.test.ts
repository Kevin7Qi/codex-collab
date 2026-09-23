// src/claude-tasks.test.ts — task records: what `send` hands over and what readers make of it
//
// Records live under a temp state dir. The receiver a record names is never
// a real one: `settled` takes the identity check as a parameter, so "its
// process is gone" and "it cannot be checked from here" are both a function
// away. The whole flow against a fake session is in commands/send.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FINAL_STATUSES,
  TASK_KEEP_MS,
  createTask,
  listTasks,
  loadTask,
  nextTurnAfter,
  outstandingTasksFor,
  resolveTaskId,
  settled,
  sweepTasks,
  taskLogFile,
  tasksDir,
  updateTask,
  writeTask,
  type TaskRecord,
} from "./claude-tasks";
import { exitCodeFor, statusLine } from "./commands/task";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-tasks-"));
let n = 0;
const freshStateDir = () => join(ROOT, `ws-${++n}`);

const target = { name: "fake-claude", pid: 4242, socketPath: "/tmp/fake.sock", sessionId: "s", procStart: "123", spawned: null };
const fields = { cwd: "/ws", threadId: "01a0985a-445b-7ee2-85b5-52e2b36a6ba4", message: "look into it\nplease", target, maxWaitSec: 3600 };

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("task records", () => {
  test("a new task is pending, private, and expires after its longest wait", () => {
    const stateDir = freshStateDir();
    const now = new Date("2026-09-21T10:00:00.000Z");
    const task = createTask(stateDir, fields, now);
    expect(task.id).toMatch(/^[0-9a-f]{8}$/);
    expect(task).toEqual(expect.objectContaining({ status: "pending", cwd: "/ws", message: "look into it\nplease", createdAt: now.toISOString(), expiresAt: "2026-09-21T11:00:00.000Z" }));
    expect(loadTask(stateDir, task.id)).toEqual(task);
    // The message and the reply are the user's work.
    if (process.platform !== "win32") {
      expect(statSync(join(tasksDir(stateDir), `${task.id}.json`)).mode & 0o077).toBe(0);
    }
    // No temp file is left where a reader could mistake it for a record.
    expect(readdirSync(tasksDir(stateDir))).toEqual([`${task.id}.json`]);
  });

  test("an update merges into the record; one for a task that is gone writes nothing", () => {
    const stateDir = freshStateDir();
    const task = createTask(stateDir, fields);
    const next = updateTask(stateDir, task.id, { status: "replied", reply: { text: "done", fromName: "fake-claude" } });
    expect(next).toEqual(expect.objectContaining({ id: task.id, status: "replied", message: task.message, reply: { text: "done", fromName: "fake-claude" } }));
    expect(loadTask(stateDir, task.id)).toEqual(next);
    expect(updateTask(stateDir, "00000000", { status: "failed" })).toBeNull();
    expect(existsSync(join(tasksDir(stateDir), "00000000.json"))).toBe(false);
  });

  test("a file that is not a task record reads as none", () => {
    const stateDir = freshStateDir();
    const task = createTask(stateDir, fields);
    writeFileSync(join(tasksDir(stateDir), "deadbeef.json"), "{ not json");
    writeFileSync(join(tasksDir(stateDir), "cafecafe.json"), JSON.stringify({ id: "cafecafe", status: "running" }));
    expect(loadTask(stateDir, "deadbeef")).toBeNull();
    expect(loadTask(stateDir, "cafecafe")).toBeNull();
    expect(listTasks(stateDir).map((t) => t.id)).toEqual([task.id]);
    expect(listTasks(freshStateDir())).toEqual([]);
  });

  test("tasks list newest first, and an id resolves exactly or by a unique prefix", () => {
    const stateDir = freshStateDir();
    const record = (id: string, createdAt: string): TaskRecord => ({ id, status: "running", cwd: "/ws", threadId: null, message: "m", target, createdAt, expiresAt: createdAt });
    // writeTask needs the directory createTask makes.
    createTask(stateDir, fields, new Date("2026-09-20T00:00:00Z"));
    writeTask(stateDir, record("abc12345", "2026-09-21T08:00:00Z"));
    writeTask(stateDir, record("abd00000", "2026-09-21T09:00:00Z"));
    expect(listTasks(stateDir).map((t) => t.id).slice(0, 2)).toEqual(["abd00000", "abc12345"]);
    expect(resolveTaskId(stateDir, "abc12345")).toEqual({ id: "abc12345", matches: ["abc12345"] });
    expect(resolveTaskId(stateDir, "ABC1").id).toBe("abc12345");
    expect(resolveTaskId(stateDir, "ab")).toEqual({ id: null, matches: ["abd00000", "abc12345"] });
    expect(resolveTaskId(stateDir, "ffff")).toEqual({ id: null, matches: [] });
    // Never a path — whichever way an id comes in.
    expect(resolveTaskId(stateDir, "../abc12345")).toEqual({ id: null, matches: [] });
    expect(loadTask(join(stateDir, "tasks", "nested"), "../abc12345")).toBeNull();
    expect(() => writeTask(stateDir, record("../escape", "2026-09-21T08:00:00Z"))).toThrow("Not a task id");
    expect(() => taskLogFile(stateDir, "abc1234")).toThrow("Not a task id");
  });

  test("an unfinished task whose receiver is gone reads as failed; one that cannot be checked is taken at its word", () => {
    const base: TaskRecord = { id: "abc12345", status: "running", cwd: "/ws", threadId: null, message: "m", target, createdAt: "t", expiresAt: "t", receiver: { pid: 99, procStart: "555", pidDomain: "linux:m:pid:[1]" } };
    const seen: Array<Record<string, unknown>> = [];
    const dead = settled(base, (entry) => { seen.push(entry); return "dead"; });
    expect(dead.status).toBe("failed");
    expect(dead.error).toContain("the process collecting the reply is gone");
    // The check gets what identifies the receiver, pid domain included: from
    // inside Codex's sandbox every host pid looks dead, and only the domain says so.
    expect(seen[0]).toEqual({ pid: 99, procStart: "555", pidDomain: "linux:m:pid:[1]" });
    // Gone before it delivered, or while delivering: the record says which,
    // so Codex is never told a message it may have delivered did not go.
    expect(settled({ ...base, status: "pending" }, () => "dead").error).toContain("so the message was not delivered");
    expect(settled({ ...base, status: "pending", deliveryStartedAt: "t" }, () => "dead").error).toContain("so the message may have reached the session");
    expect(settled(base, () => "unverifiable")).toBe(base);
    expect(settled(base, () => "live")).toBe(base);
    // A finished task is what it is, whatever became of its receiver since.
    const replied = { ...base, status: "replied" as const };
    expect(settled(replied, () => "dead")).toBe(replied);
    // Before the receiver has written itself in there is nobody to check.
    const { receiver: _none, ...unclaimed } = base;
    expect(settled(unclaimed, () => "dead")).toBe(unclaimed);
  });

  test("a task that never got a receiver settles as not delivered, and holds nothing", () => {
    const stateDir = freshStateDir();
    const now = Date.parse("2026-09-21T10:00:00.000Z");
    // `send` was killed between recording the task and starting its receiver.
    const orphan = createTask(stateDir, fields, new Date(now - 5 * 60_000));
    expect(settled(orphan, () => "live", now)).toEqual(expect.objectContaining({ status: "failed", error: expect.stringContaining("never started, so the message was not delivered") }));
    // A moment old, its receiver may still be starting.
    const young = createTask(stateDir, fields, new Date(now - 5_000));
    expect(settled(young, () => "live", now)).toBe(young);
    // Settled, it no longer holds the session from the reaper.
    const aged = createTask(stateDir, fields, new Date(Date.now() - 5 * 60_000));
    expect(outstandingTasksFor(stateDir, target).map((t) => t.id)).not.toContain(aged.id);
  });

  test("a task waits on its session under whatever pid the session has now", () => {
    const stateDir = freshStateDir();
    const task = createTask(stateDir, fields);
    updateTask(stateDir, task.id, { status: "running", receiver: { pid: process.pid, procStart: null, pidDomain: null } });
    // Claude Code brought the session back as another process: same id.
    expect(outstandingTasksFor(stateDir, { pid: 5151, sessionId: "s" }).map((t) => t.id)).toEqual([task.id]);
    expect(outstandingTasksFor(stateDir, { pid: 4242, sessionId: "another" })).toEqual([]);
    // Where a side has no session id, the pid is all there is.
    expect(outstandingTasksFor(stateDir, { pid: 4242, sessionId: null }).map((t) => t.id)).toEqual([task.id]);
  });

  test("a later task's own turn bounds which errors are this task's", () => {
    const stateDir = freshStateDir();
    const at = (s: number) => new Date(Date.parse("2026-09-21T10:00:00.000Z") + s * 1000).toISOString();
    const a = createTask(stateDir, fields);
    updateTask(stateDir, a.id, { status: "running", deliveredAt: at(0), joinedTurn: false });
    // Delivered to the idle session a moment after A, before A's turn was
    // seen running: both may be in one turn, and its end is both of theirs.
    const early = createTask(stateDir, fields);
    updateTask(stateDir, early.id, { status: "running", deliveredAt: at(1), joinedTurn: false });
    expect(nextTurnAfter(stateDir, a.id)).toBeUndefined();
    updateTask(stateDir, a.id, { busySeenAt: at(2) });
    expect(nextTurnAfter(stateDir, a.id)).toBeUndefined();
    // Delivered into A's turn while it ran: that turn is still A's.
    const joined = createTask(stateDir, fields);
    updateTask(stateDir, joined.id, { status: "running", deliveredAt: at(10), joinedTurn: true });
    expect(nextTurnAfter(stateDir, a.id)).toBeUndefined();
    // Another session's turns are no concern of A's.
    const elsewhere = createTask(stateDir, { ...fields, target: { ...target, pid: 7, sessionId: "other" } });
    updateTask(stateDir, elsewhere.id, { status: "running", deliveredAt: at(20), joinedTurn: false });
    expect(nextTurnAfter(stateDir, a.id)).toBeUndefined();
    // A message that started a turn of its own after A's ended: from here on,
    // whatever the session hits is that turn's.
    const b = createTask(stateDir, fields);
    updateTask(stateDir, b.id, { status: "running", deliveredAt: at(30), joinedTurn: false });
    updateTask(stateDir, b.id, { busySeenAt: at(31) });
    const c = createTask(stateDir, fields);
    updateTask(stateDir, c.id, { status: "running", deliveredAt: at(40), joinedTurn: false });
    expect(nextTurnAfter(stateDir, a.id)).toBe(at(30));
    expect(nextTurnAfter(stateDir, b.id)).toBe(at(40));
    expect(nextTurnAfter(stateDir, c.id)).toBeUndefined();
  });

  test("clean removes finished tasks once they are old, with their logs, and never one still waited on", () => {
    const stateDir = freshStateDir();
    const old = new Date(Date.now() - TASK_KEEP_MS - 60_000);
    const age = (file: string) => utimesSync(file, old, old);
    const done = createTask(stateDir, fields);
    updateTask(stateDir, done.id, { status: "replied" });
    writeFileSync(taskLogFile(stateDir, done.id), "log");
    const recent = createTask(stateDir, fields);
    updateTask(stateDir, recent.id, { status: "lost" });
    // Old, unfinished, and its receiver (this process) alive: someone may
    // yet ask for it.
    const waiting = createTask(stateDir, fields);
    updateTask(stateDir, waiting.id, { status: "running", receiver: { pid: process.pid, procStart: null, pidDomain: null } });
    for (const id of [done.id, waiting.id]) age(join(tasksDir(stateDir), `${id}.json`));
    age(taskLogFile(stateDir, done.id));
    expect(sweepTasks(stateDir)).toBe(1);
    expect(listTasks(stateDir).map((t) => t.id).sort()).toEqual([recent.id, waiting.id].sort());
    expect(existsSync(taskLogFile(stateDir, done.id))).toBe(false);
    expect(sweepTasks(freshStateDir())).toBe(0);
  });

  test("exit codes tell replied from still-running from blocked from never", () => {
    expect(exitCodeFor("replied")).toBe(0);
    expect(exitCodeFor("running")).toBe(3);
    expect(exitCodeFor("pending")).toBe(3);
    expect(exitCodeFor("blocked")).toBe(5);
    for (const s of ["lost", "failed", "expired"] as const) expect(exitCodeFor(s)).toBe(1);
    expect([...FINAL_STATUSES].sort()).toEqual(["blocked", "expired", "failed", "lost", "replied"]);
    expect(statusLine({ id: "abc12345", status: "running" })).toBe("task: abc12345  status: running");
  });
});
