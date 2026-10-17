// src/codex-session.ts — what Codex's own session record says about a thread
//
// Codex keeps a record of every thread under `$CODEX_HOME/sessions/<year>/
// <month>/<day>/rollout-<time>-<thread id>.jsonl`, whose first line is the
// thread's `session_meta`. The format is Codex's and undocumented: what is
// read here fails closed.

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The folder a Codex thread works in, as its session record says, or null
 *  when there is no such record or it cannot be read. */
export function codexThreadCwd(threadId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(threadId)) return null;
  const file = findRecord(join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"), `-${threadId}.jsonl`);
  if (!file) return null;
  try {
    const meta = JSON.parse(firstLine(file));
    const payload = meta?.type === "session_meta" ? meta.payload : null;
    if (!payload || payload.id !== threadId) return null;
    return typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : null;
  } catch {
    return null;
  }
}

/** The record whose name ends with `suffix`, newest day first. */
function findRecord(root: string, suffix: string): string | null {
  const desc = (dir: string) => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of desc(root)) {
    for (const month of desc(join(root, year))) {
      for (const day of desc(join(root, year, month))) {
        const name = desc(join(root, year, month, day)).find((f) => f.endsWith(suffix));
        if (name) return join(root, year, month, day, name);
      }
    }
  }
  return null;
}

/** A record's first line: the session metadata, read without the rest. */
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf-8");
    const end = text.indexOf("\n");
    return end >= 0 ? text.slice(0, end) : text;
  } finally {
    closeSync(fd);
  }
}
