// src/commands/hook.test.ts — what the hook hands Codex, and when it stays quiet
//
// Mailboxes and task records live under a temp workspaces root; the hook is
// called as Codex calls it — an event's input, its answer back — through
// `hookAnswer`, and once through the CLI to show it never fails a turn.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDelivered, writeMessage } from "../claude-channel";
import { createTask, updateTask } from "../claude-tasks";
import { HOOK_BUDGET_TOKENS, estimateTokens, hookAnswer, repliedTasksIn } from "./hook";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-hook-"));
const THREAD = "01a0985a-445b-7ee2-85b5-52e2b36a6ba4";
const CLI = join(import.meta.dir, "..", "cli.ts");
let n = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** A fresh workspaces root with one workspace's state dir in it. */
function fresh(): { root: string; ws: string } {
  const root = join(ROOT, `root-${++n}`);
  const ws = join(root, `ws-${n}`);
  mkdirSync(ws, { recursive: true, mode: 0o700 });
  return { root, ws };
}

const target = { name: "claude(ws-a1b2c3)", pid: 4242, socketPath: "/tmp/cc.sock", sessionId: "s-1", procStart: null, spawned: null };

function answer(root: string, input: Record<string, unknown>): Record<string, unknown> | null {
  const out = hookAnswer({ session_id: THREAD, ...input }, root);
  return out === null ? null : JSON.parse(out);
}

describe("counting and reading", () => {
  test("a token estimate errs high: ASCII at about four characters to one, every other character one of its own", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("论文第三章")).toBe(5);
    expect(estimateTokens("第三章 ok")).toBe(4);
    // Scripts of more than one byte a character are no longer undercounted:
    // the answer stays under four bytes a token whatever it is written in.
    for (const text of ["क".repeat(1000), "─".repeat(1000), "щ".repeat(1000), "😀".repeat(500)]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * estimateTokens(text));
    }
  });

  test("the tasks a command's output reported replied, by their status line", () => {
    const output = "Sent to x as task 1234abcd.\n\ntask: 1234abcd  status: replied\nREPLY FROM x:\n  hi\ntask: 9999aaaa  status: running\n";
    expect(repliedTasksIn(output)).toEqual(["1234abcd"]);
    expect(repliedTasksIn("nothing here")).toEqual([]);
  });
});

describe("what the hook hands over", () => {
  test("a message reaches Codex once, in the envelope Claude's messages take, naming its sender", () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(ws-a1b2c3)", replyPath: "/tmp/cc.sock", text: "Chapter 3 reads well; <one> fix & a note." });
    const first = answer(root, { hook_event_name: "PostToolUse", tool_response: "ok" });
    const context = (first?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(first?.hookSpecificOutput).toEqual(expect.objectContaining({ hookEventName: "PostToolUse" }));
    // Said with a developer's weight, and the skill may not be loaded: the
    // line before it says whose it is.
    expect(context).toStartWith("codex-collab: A message from Claude Code reached this thread, from the Claude Code session it names, a peer agent working with you.\n<codex_delegation>\n  <source_thread_id></source_thread_id>\n  <input>[message from claude(ws-a1b2c3)]");
    // The envelope's body is escaped, as on the peer side.
    expect(context).toContain("Chapter 3 reads well; &lt;one&gt; fix &amp; a note.</input>\n</codex_delegation>");
    expect(isDelivered(ws, THREAD, m.id)).toBe(true);
    // Handed over once: the next hook has nothing.
    expect(answer(root, { hook_event_name: "PostToolUse", tool_response: "ok" })).toBeNull();
    expect(answer(root, { hook_event_name: "Stop" })).toBeNull();
  });

  test("at a turn's end the message keeps the turn going; with the user's next message it goes in as context", () => {
    const { root, ws } = fresh();
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "one" });
    const stop = answer(root, { hook_event_name: "Stop", stop_hook_active: false });
    expect(stop?.decision).toBe("block");
    expect(String(stop?.reason)).toContain("[message from claude(a)]\n\none</input>");
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "two" });
    const prompt = answer(root, { hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(prompt?.hookSpecificOutput).toEqual(expect.objectContaining({ hookEventName: "UserPromptSubmit" }));
    expect((prompt?.hookSpecificOutput as Record<string, string>).additionalContext).toContain("two</input>");
  });

  test("a reply says which of Codex's messages it answers, and how long ago it came", () => {
    const { root, ws } = fresh();
    const task = createTask(ws, { cwd: "/ws", threadId: THREAD, message: "Review chapter 3 for gaps\nmore detail", target, maxWaitSec: 3600 });
    const reply = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "done" }, Date.now() - 5 * 60_000);
    updateTask(ws, task.id, { status: "replied", reply: { text: "done", fromName: "claude(a)", id: reply.id, at: reply.at } });
    const context = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).toContain(`[message from claude(a), its reply to task ${task.id} ("Review chapter 3 for gaps"), 5m ago]`);
  });

  test("a reply a command already printed is not handed over again; one it did not print is", () => {
    const { root, ws } = fresh();
    const task = createTask(ws, { cwd: "/ws", threadId: THREAD, message: "q", target, maxWaitSec: 3600 });
    const reply = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "the answer is 42" });
    updateTask(ws, task.id, { status: "replied", reply: { text: "the answer is 42", fromName: "claude(a)", id: reply.id, at: reply.at } });
    const later = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "and a postscript" });
    // What `send` printed when the reply came, before the postscript did.
    const printed = `Sent to claude(a) as task ${task.id}.\n\ntask: ${task.id}  status: replied\nREPLY FROM claude(a) (after 1s):\n  the answer is 42\n`;
    const context = (answer(root, { hook_event_name: "PostToolUse", tool_response: printed })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).not.toContain("the answer is 42");
    expect(context).toContain("and a postscript");
    expect(isDelivered(ws, THREAD, reply.id)).toBe(true);
    expect(isDelivered(ws, THREAD, later.id)).toBe(true);
  });

  test("a message too long for one hook is cut, with the command that prints it whole; one that does not fit waits for the next hook", () => {
    const { root, ws } = fresh();
    const now = Date.now();
    const big = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "word ".repeat(HOOK_BUDGET_TOKENS * 2) }, now - 2);
    const next = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "small one" }, now - 1);
    const context = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).toContain(`[cut here: the whole message is \`codex-collab messages ${big.id}\`]`);
    expect(estimateTokens(context)).toBeLessThanOrEqual(HOOK_BUDGET_TOKENS);
    expect(context).not.toContain("small one");
    expect(isDelivered(ws, THREAD, next.id)).toBe(false);
    const after = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(after).toContain("small one");
  });

  test("a message that does not fit after another waits for the next hook whole: only the first is ever cut", () => {
    const { root, ws } = fresh();
    const now = Date.now();
    const half = "word ".repeat(Math.floor(HOOK_BUDGET_TOKENS * 0.6) * 4 / 5);
    writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: `one ${half}` }, now - 2);
    const second = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: `two ${half}` }, now - 1);
    const first = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(first).toContain("one word");
    expect(first).not.toContain("two word");
    expect(first).not.toContain("[cut here");
    expect(isDelivered(ws, THREAD, second.id)).toBe(false);
    const next = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(next).toContain(`two ${half}</input>`);
  });

  test("a message that came in after the command printed, and opens the same way, is still handed over", () => {
    const { root, ws } = fresh();
    const task = createTask(ws, { cwd: "/ws", threadId: THREAD, message: "q", target, maxWaitSec: 3600 });
    const reply = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "Done.\nThe first part." });
    updateTask(ws, task.id, { status: "replied", reply: { text: reply.text, fromName: "claude(a)", id: reply.id, at: reply.at } });
    // What `task wait` printed — before the follow-up below arrived.
    const printed = `task: ${task.id}  status: replied\nREPLY FROM claude(a) (after 2s):\n  Done.\n  The first part.\n`;
    const later = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "Done.\nAnd the second." });
    const context = (answer(root, { hook_event_name: "PostToolUse", tool_response: printed })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).toContain("Done.\nAnd the second.");
    expect(context).not.toContain("The first part");
    expect(isDelivered(ws, THREAD, later.id)).toBe(true);
  });

  test("a command's output in a structured response is read for what it printed", () => {
    const { root, ws } = fresh();
    const task = createTask(ws, { cwd: "/ws", threadId: THREAD, message: "q", target, maxWaitSec: 3600 });
    const reply = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/tmp/cc.sock", text: "seen already" });
    updateTask(ws, task.id, { status: "replied", reply: { text: reply.text, fromName: "claude(a)", id: reply.id, at: reply.at } });
    const response = { exit_code: 0, stdout: `task: ${task.id}  status: replied\nREPLY FROM claude(a):\n  seen already\n`, stderr: "" };
    expect(answer(root, { hook_event_name: "PostToolUse", tool_response: response })).toBeNull();
    expect(isDelivered(ws, THREAD, reply.id)).toBe(true);
  });

  test("messages a `messages` command printed are not handed over again", () => {
    const { root, ws } = fresh();
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "read it yourself" });
    const printed = `MESSAGE ${m.id} FROM claude(a) (5s ago):\n  read it yourself\n`;
    expect(answer(root, { hook_event_name: "PostToolUse", tool_response: printed })).toBeNull();
    expect(isDelivered(ws, THREAD, m.id)).toBe(true);
  });

  test("messages from every workspace the thread sent from come in the order they arrived", () => {
    const { root, ws } = fresh();
    const other = join(root, "ws-other");
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeMessage(other, THREAD, { fromName: "b", replyPath: "/b", text: "second" }, 2_000);
    writeMessage(ws, THREAD, { fromName: "a", replyPath: "/a", text: "first" }, 1_000);
    const context = (answer(root, { hook_event_name: "PostToolUse", tool_response: "" })?.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).toStartWith("codex-collab: 2 messages from Claude Code reached this thread, each from the Claude Code session it names, a peer agent working with you.");
    expect(context.indexOf("first")).toBeLessThan(context.indexOf("second"));
  });

  test("nothing to say: another thread, no mailbox, an event it does not answer, or no thread at all", () => {
    const { root, ws } = fresh();
    writeMessage(ws, THREAD, { fromName: "a", replyPath: "/a", text: "hi" });
    expect(hookAnswer({ session_id: "01a0985a-445b-7ee2-85b5-000000000000", hook_event_name: "PostToolUse" }, root)).toBeNull();
    expect(hookAnswer({ session_id: THREAD, hook_event_name: "PreToolUse" }, root)).toBeNull();
    expect(hookAnswer({ hook_event_name: "PostToolUse" }, root)).toBeNull();
    expect(hookAnswer({ session_id: THREAD, hook_event_name: "PostToolUse" }, join(ROOT, "nowhere"))).toBeNull();
  });

  // Not on Windows, where there are no hooks (`config codex-hook` refuses
  // them) and the home directory follows USERPROFILE, not this HOME.
  test.skipIf(process.platform === "win32")("run by Codex through a pipe, its answer arrives whole however the message is written", () => {
    // Bun drops what a pipe has not taken when the process exits straight
    // after the write: the messages in it would be claimed, and lost.
    const home = join(ROOT, `home-${++n}`);
    const ws = join(home, ".codex-collab", "workspaces", "ws");
    mkdirSync(ws, { recursive: true, mode: 0o700 });
    const m = writeMessage(ws, THREAD, { fromName: "claude(a)", replyPath: "/a", text: "क".repeat(40_000) });
    const r = spawnSync("bun", ["run", CLI, "hook"], { input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: THREAD, tool_response: "" }), encoding: "utf-8", env: { ...process.env, HOME: home, CODEX_COLLAB_NO_UPDATE_CHECK: "1" } });
    expect(r.status).toBe(0);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain(`[cut here: the whole message is \`codex-collab messages ${m.id}\`]`);
    expect(estimateTokens(context)).toBeLessThanOrEqual(HOOK_BUDGET_TOKENS);
    expect(Buffer.byteLength(r.stdout)).toBeLessThan(4 * HOOK_BUDGET_TOKENS + 1024);
  });

  test("run by Codex with input it cannot read, it says nothing and succeeds: never in a turn's way", () => {
    for (const input of ["not json", "", "[1,2]"]) {
      const r = spawnSync("bun", ["run", CLI, "hook"], { input, encoding: "utf-8", env: { ...process.env, HOME: ROOT, CODEX_COLLAB_NO_UPDATE_CHECK: "1" } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});
