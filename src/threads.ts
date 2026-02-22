// src/threads.ts — Thread lifecycle and short ID mapping

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import type { ThreadMapping } from "./types";

/**
 * Acquire an advisory file lock using O_CREAT|O_EXCL on a .lock file.
 * Returns a release function. Spins with short sleeps on contention.
 */
function acquireLock(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  const maxAttempts = 100;
  let fd: number | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      // Lock held — wait and retry
      Bun.sleepSync(10 + Math.random() * 20);
    }
  }
  if (fd === undefined) {
    // Stale lock — force acquire
    try { unlinkSync(lockPath); } catch {}
    fd = openSync(lockPath, "w");
  }

  return () => {
    try { closeSync(fd!); } catch {}
    try { unlinkSync(lockPath); } catch {}
  };
}

export function generateShortId(): string {
  return randomBytes(4).toString("hex");
}

export function loadThreadMapping(threadsFile: string): ThreadMapping {
  if (!existsSync(threadsFile)) return {};
  let content: string;
  try {
    content = readFileSync(threadsFile, "utf-8");
  } catch (e) {
    throw new Error(`Cannot read threads file ${threadsFile}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error(
      `[codex] Warning: threads file is corrupted (${e instanceof Error ? e.message : e}). Thread history may be incomplete.`,
    );
    return {};
  }
}

export function saveThreadMapping(threadsFile: string, mapping: ThreadMapping): void {
  const dir = dirname(threadsFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = threadsFile + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(mapping, null, 2));
  renameSync(tmpPath, threadsFile);
}

export function registerThread(
  threadsFile: string,
  threadId: string,
  meta?: { model?: string; cwd?: string },
): ThreadMapping {
  const release = acquireLock(threadsFile);
  try {
    const mapping = loadThreadMapping(threadsFile);
    const shortId = generateShortId();
    mapping[shortId] = {
      threadId,
      createdAt: new Date().toISOString(),
      model: meta?.model,
      cwd: meta?.cwd,
    };
    saveThreadMapping(threadsFile, mapping);
    return mapping;
  } finally {
    release();
  }
}

export function resolveThreadId(threadsFile: string, idOrPrefix: string): string {
  const mapping = loadThreadMapping(threadsFile);

  // Exact match
  if (mapping[idOrPrefix]) return mapping[idOrPrefix].threadId;

  // Prefix match
  const matches = Object.entries(mapping).filter(([k]) => k.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0][1].threadId;
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idOrPrefix}" — matches: ${matches.map(([k]) => k).join(", ")}`,
    );
  }

  throw new Error(`Thread not found: "${idOrPrefix}"`);
}

export function findShortId(threadsFile: string, threadId: string): string | null {
  const mapping = loadThreadMapping(threadsFile);
  for (const [shortId, entry] of Object.entries(mapping)) {
    if (entry.threadId === threadId) return shortId;
  }
  return null;
}

export function removeThread(threadsFile: string, shortId: string): void {
  const release = acquireLock(threadsFile);
  try {
    const mapping = loadThreadMapping(threadsFile);
    delete mapping[shortId];
    saveThreadMapping(threadsFile, mapping);
  } finally {
    release();
  }
}
