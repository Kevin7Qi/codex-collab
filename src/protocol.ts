// src/protocol.ts — JSON-RPC client for Codex app server

import type { JsonRpcMessage, RequestId } from "./types";

let nextId = 1;

/** Format a JSON-RPC request (has id, expects response). Returns newline-terminated JSON and the assigned id. */
export function formatRequest(method: string, params?: unknown): { line: string; id: number } {
  const id = nextId++;
  const msg: Record<string, unknown> = { id, method };
  if (params !== undefined) msg.params = params;
  return { line: JSON.stringify(msg) + "\n", id };
}

/** Format a JSON-RPC notification (no id, no response). Returns newline-terminated JSON. */
export function formatNotification(method: string, params?: unknown): string {
  const msg: Record<string, unknown> = { method };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg) + "\n";
}

/** Format a JSON-RPC response to a server request. Returns newline-terminated JSON. */
export function formatResponse(id: RequestId, result: unknown): string {
  return JSON.stringify({ id, result }) + "\n";
}

/** Parse a JSON-RPC message from a line. Returns null if unparseable. */
export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Reset the request ID counter (for testing). */
export function resetIdCounter(): void {
  nextId = 1;
}
