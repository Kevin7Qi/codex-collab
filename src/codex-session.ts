// src/codex-session.ts — what Codex's own session record says about a thread
//
// Codex keeps a record of every thread under `$CODEX_HOME/sessions/<year>/
// <month>/<day>/rollout-<time>-<thread id>.jsonl`, whose first line is the
// thread's `session_meta`; a thread gone quiet has its record compressed
// (`.jsonl.zst`). The format is Codex's and undocumented: what is read here
// fails closed.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The folder a Codex thread works in, as its session record says, or null
 *  when there is no such record or it cannot be read. */
export function codexThreadCwd(threadId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(threadId)) return null;
  const file = findRecord(join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions"), `-${threadId}.jsonl`);
  if (!file) return null;
  try {
    const meta = JSON.parse(file.endsWith(".zst") ? compressedFirstLine(file) : firstLine(file));
    const payload = meta?.type === "session_meta" ? meta.payload : null;
    if (!payload || payload.id !== threadId) return null;
    return typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : null;
  } catch {
    return null;
  }
}

/** The record whose name ends with `suffix`, or with `suffix` and `.zst`,
 *  newest day first. */
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
        const name = desc(join(root, year, month, day)).find((f) => f.endsWith(suffix) || f.endsWith(`${suffix}.zst`));
        if (name) return join(root, year, month, day, name);
      }
    }
  }
  return null;
}

/** A record's first line: the session metadata, read without the rest. It
 *  carries Codex's base instructions, tens of kilobytes; one past 4 MiB is
 *  not taken for a record. */
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      const end = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(buf.subarray(0, end >= 0 ? end : n));
      total += n;
      if (end >= 0) break;
      if (total > 4 * 1024 * 1024) throw new Error("no line end within 4 MiB");
    }
    return Buffer.concat(chunks).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** The first line of a compressed record. */
function compressedFirstLine(file: string): string {
  const text = Buffer.from(Bun.zstdDecompressSync(readFileSync(file))).toString("utf-8");
  const end = text.indexOf("\n");
  return end >= 0 ? text.slice(0, end) : text;
}
