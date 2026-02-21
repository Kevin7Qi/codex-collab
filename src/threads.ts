// src/threads.ts — Thread lifecycle and short ID mapping

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import type { ThreadMapping } from "./types";

export function generateShortId(): string {
  return randomBytes(4).toString("hex");
}

export function loadThreadMapping(threadsFile: string): ThreadMapping {
  if (!existsSync(threadsFile)) return {};
  try {
    return JSON.parse(readFileSync(threadsFile, "utf-8"));
  } catch {
    return {};
  }
}

export function saveThreadMapping(threadsFile: string, mapping: ThreadMapping): void {
  const dir = dirname(threadsFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(threadsFile, JSON.stringify(mapping, null, 2));
}

export function registerThread(
  threadsFile: string,
  threadId: string,
  meta?: { model?: string; cwd?: string },
): ThreadMapping {
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
  const mapping = loadThreadMapping(threadsFile);
  delete mapping[shortId];
  saveThreadMapping(threadsFile, mapping);
}
