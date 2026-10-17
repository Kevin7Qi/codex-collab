// src/codex-session.test.ts — reading the folder a Codex thread works in from its record

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexThreadCwd } from "./codex-session";

let home: string;
const env = () => ({ CODEX_HOME: home }) as NodeJS.ProcessEnv;
const id = (n: number) => `01a14a00-0000-7000-8000-${String(n).padStart(12, "0")}`;

function record(day: string, threadId: string, first: unknown, opts: { compress?: boolean; rest?: string } = {}): void {
  const dir = join(home, "sessions", "2026", "10", day);
  mkdirSync(dir, { recursive: true });
  const text = `${typeof first === "string" ? first : JSON.stringify(first)}\n${opts.rest ?? '{"type":"event_msg"}\n'}`;
  const name = `rollout-2026-10-${day}T00-00-00-${threadId}.jsonl`;
  if (opts.compress) writeFileSync(join(dir, `${name}.zst`), Bun.zstdCompressSync(Buffer.from(text)));
  else writeFileSync(join(dir, name), text);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("codexThreadCwd", () => {
  test("a thread's folder, from its record, plain or compressed", () => {
    record("17", id(1), { type: "session_meta", payload: { id: id(1), cwd: "/work/plain" } });
    record("03", id(2), { type: "session_meta", payload: { id: id(2), cwd: "/work/compressed" } }, { compress: true });
    expect(codexThreadCwd(id(1), env())).toBe("/work/plain");
    expect(codexThreadCwd(id(2), env())).toBe("/work/compressed");
  });

  test("a first line of any length is read whole", () => {
    // Codex's base instructions make it tens of kilobytes.
    const big = "x".repeat(200 * 1024);
    record("16", id(3), { type: "session_meta", payload: { id: id(3), base_instructions: big, cwd: "/work/big" } });
    expect(codexThreadCwd(id(3), env())).toBe("/work/big");
  });

  test("anything that is not this thread's record, naming an absolute folder, says nothing", () => {
    record("15", id(4), { type: "session_meta", payload: { id: id(99), cwd: "/work/other" } });
    record("15", id(5), { type: "event_msg", payload: { id: id(5), cwd: "/work/event" } });
    record("15", id(6), { type: "session_meta", payload: { id: id(6), cwd: "relative/folder" } });
    record("15", id(7), "not json");
    for (const n of [4, 5, 6, 7]) expect(codexThreadCwd(id(n), env())).toBeNull();
    expect(codexThreadCwd(id(8), env())).toBeNull();
    // An id that is not one is never looked for.
    expect(codexThreadCwd("../../etc", env())).toBeNull();
    expect(codexThreadCwd(id(1), { CODEX_HOME: join(home, "nowhere") } as NodeJS.ProcessEnv)).toBeNull();
  });
});
