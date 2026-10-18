// src/codex-hooks.test.ts — adding codex-collab's hooks to Codex's hooks file, and taking them out
//
// Every case works on a hooks file of its own under a temp dir, and leaves
// the user's own hooks where they were.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_CONTEXT_LIMIT, HOOK_TIMEOUT_SEC, codexHooksInSync, hookCommand, installCodexHooks, isOurHandler, removeCodexHooks } from "./codex-hooks";

const ROOT = mkdtempSync(join(tmpdir(), "codex-collab-hooks-"));
let n = 0;
const fresh = () => {
  const dir = join(ROOT, `c-${++n}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "hooks.json");
};
const COMMAND = hookCommand("/opt/bun", "/home/u/.local/bin/codex-collab");
const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
const userHook = { hooks: [{ type: "command", command: "notify-me" }] };

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("codex-collab's hooks in Codex's hooks file", () => {
  test("the command runs Bun and this CLI by absolute path, quoted", () => {
    expect(COMMAND).toBe("'/opt/bun' '/home/u/.local/bin/codex-collab' hook");
    expect(hookCommand("/opt/bun", "/it's here/cli.ts")).toBe("'/opt/bun' '/it'\\''s here/cli.ts' hook");
    expect(isOurHandler({ command: COMMAND })).toBe(true);
    expect(isOurHandler({ command: "notify-me" })).toBe(false);
    expect(isOurHandler({ command: "'/x/codex-collab' hook --other" })).toBe(false);
  });

  test("into no file: one hook for each of the three events, with a timeout, and room for a message on the two that add context", () => {
    const path = fresh();
    expect(codexHooksInSync(COMMAND, path)).toBeNull();
    installCodexHooks(COMMAND, path);
    const doc = read(path);
    expect(Object.keys(doc.hooks).sort()).toEqual(["PostToolUse", "Stop", "UserPromptSubmit"]);
    expect(doc.hooks.PostToolUse).toEqual([{ hooks: [{ type: "command", command: COMMAND, timeout: HOOK_TIMEOUT_SEC, additionalContextLimit: HOOK_CONTEXT_LIMIT }] }]);
    expect(doc.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: COMMAND, timeout: HOOK_TIMEOUT_SEC }] }]);
    expect(codexHooksInSync(COMMAND, path)).toBe(true);
    if (process.platform !== "win32") expect((Bun.file(path).size)).toBeGreaterThan(0);
  });

  test("beside the user's own hooks: ours go after theirs, written again without doubling, and only ours come out", () => {
    const path = fresh();
    const theirs = { model: "kept", hooks: { Stop: [userHook], PreToolUse: [userHook] } };
    writeFileSync(path, JSON.stringify(theirs));
    installCodexHooks(COMMAND, path);
    installCodexHooks(COMMAND, path);
    const doc = read(path);
    expect(doc.model).toBe("kept");
    expect(doc.hooks.PreToolUse).toEqual([userHook]);
    // Theirs keeps its place, which is what Codex keys its trust by.
    expect(doc.hooks.Stop[0]).toEqual(userHook);
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.PostToolUse).toHaveLength(1);
    expect(removeCodexHooks(path)).toBe(true);
    expect(read(path)).toEqual(theirs);
    expect(removeCodexHooks(path)).toBe(false);
  });

  test("a group the user shares with ours keeps their handler", () => {
    const path = fresh();
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }, { type: "command", command: COMMAND }] }] } }));
    expect(removeCodexHooks(path)).toBe(true);
    expect(read(path)).toEqual({ hooks: { Stop: [userHook] } });
  });

  test("taking ours out of a file that held nothing else removes the file", () => {
    const path = fresh();
    installCodexHooks(COMMAND, path);
    expect(removeCodexHooks(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(removeCodexHooks(path)).toBe(false);
  });

  test("hooks written by another install, or one missing, are out of date", () => {
    const path = fresh();
    installCodexHooks(hookCommand("/old/bun", "/home/u/.local/bin/codex-collab"), path);
    expect(codexHooksInSync(COMMAND, path)).toBe(false);
    const doc = read(path);
    delete doc.hooks.Stop;
    writeFileSync(path, JSON.stringify(doc));
    expect(codexHooksInSync(hookCommand("/old/bun", "/home/u/.local/bin/codex-collab"), path)).toBe(false);
    installCodexHooks(COMMAND, path);
    expect(codexHooksInSync(COMMAND, path)).toBe(true);
  });

  test("a file that is not a hooks file is reported and never written over", () => {
    for (const text of ["{ not json", "[]", JSON.stringify({ hooks: [] })]) {
      const path = fresh();
      writeFileSync(path, text);
      expect(() => installCodexHooks(COMMAND, path)).toThrow("codex-collab leaves it as it is");
      expect(() => removeCodexHooks(path)).toThrow("codex-collab leaves it as it is");
      expect(readFileSync(path, "utf-8")).toBe(text);
      expect(codexHooksInSync(COMMAND, path)).toBe(false);
    }
  });
});
