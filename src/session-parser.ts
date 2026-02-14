import { existsSync, readdirSync, readFileSync } from "fs";
import type { Dirent } from "fs";
import { extname, join } from "path";
import { stripAnsiCodes } from "./utils.ts";

export type SessionTokens = {
  input: number;
  output: number;
  context_window: number;
  context_used_pct: number;
};

export type ParsedSessionData = {
  tokens: SessionTokens | null;
  files_modified: string[] | null;
  summary: string | null;
};

const SESSION_EXTENSIONS = new Set<string>([".jsonl", ".json"]);

function getCodexHome(): string | null {
  const configured = process.env.CODEX_HOME;
  if (configured && configured.trim()) return configured;
  if (!process.env.HOME) return null;
  return join(process.env.HOME, ".codex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractAssistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type !== "output_text" && type !== "text" && type !== "input_text")
      continue;
    const text = part.text;
    if (typeof text === "string") parts.push(text);
  }

  return parts.length > 0 ? parts.join("") : null;
}

function extractFilesFromPatch(patchText: string): string[] {
  const files: string[] = [];
  const prefixes = [
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Move to: ",
  ];

  for (const line of patchText.split("\n")) {
    for (const prefix of prefixes) {
      if (!line.startsWith(prefix)) continue;
      const file = line.slice(prefix.length).trim();
      if (file) files.push(file);
    }
  }

  return files;
}

function extractPatchText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.includes("*** Begin Patch")) return raw;

  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  const parsed = parseJsonLine(trimmed);
  if (!isRecord(parsed)) return null;

  const patchValue = parsed.patch ?? parsed.input;
  if (
    typeof patchValue === "string" &&
    patchValue.includes("*** Begin Patch")
  ) {
    return patchValue;
  }

  return null;
}

function parseTokensFromInfo(
  info: Record<string, unknown>
): SessionTokens | null {
  const totalUsage = info.total_token_usage;
  if (!isRecord(totalUsage)) return null;

  const inputTokens = toNumber(totalUsage.input_tokens);
  const outputTokens = toNumber(totalUsage.output_tokens);
  const contextWindow = toNumber(info.model_context_window);

  if (
    inputTokens === null ||
    outputTokens === null ||
    contextWindow === null
  )
    return null;
  const contextUsed =
    contextWindow > 0 ? (inputTokens / contextWindow) * 100 : 0;
  const contextUsedPct = Math.round(contextUsed * 100) / 100;

  return {
    input: inputTokens,
    output: outputTokens,
    context_window: contextWindow,
    context_used_pct: contextUsedPct,
  };
}

function parseJsonlSession(content: string): ParsedSessionData {
  const filesModified = new Set<string>();
  let tokens: SessionTokens | null = null;
  let summary: string | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = parseJsonLine(line);
    if (!isRecord(record)) continue;

    const recordType = typeof record.type === "string" ? record.type : null;
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!recordType || !payload) continue;

    const payloadType =
      typeof payload.type === "string" ? payload.type : null;
    if (recordType === "event_msg" && payloadType === "token_count") {
      if (isRecord(payload.info)) {
        const parsedTokens = parseTokensFromInfo(payload.info);
        if (parsedTokens) tokens = parsedTokens;
      }
    }

    if (recordType === "event_msg" && payloadType === "agent_message") {
      const message = payload.message;
      if (typeof message === "string") summary = message;
    }

    if (recordType === "response_item" && payloadType === "message") {
      const role = payload.role;
      if (role === "assistant") {
        const messageText = extractAssistantText(payload.content);
        if (messageText) summary = messageText;
      }
    }

    if (recordType === "response_item") {
      const toolType =
        payloadType === "custom_tool_call" ||
        payloadType === "function_call";
      const toolName =
        typeof payload.name === "string" ? payload.name : null;
      if (toolType && toolName === "apply_patch") {
        const patchText = extractPatchText(payload.input ?? payload.arguments);
        if (patchText) {
          for (const file of extractFilesFromPatch(patchText)) {
            filesModified.add(file);
          }
        }
      }
    }
  }

  return {
    tokens,
    files_modified: Array.from(filesModified),
    summary,
  };
}

function parseJsonSession(content: string): ParsedSessionData | null {
  const parsed = parseJsonLine(content);
  if (!isRecord(parsed)) return null;

  let summary: string | null = null;
  const items = parsed.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.role !== "assistant") continue;
      const messageText = extractAssistantText(item.content);
      if (messageText) summary = messageText;
    }
  }

  return {
    tokens: null,
    files_modified: [],
    summary,
  };
}

export function extractSessionId(logContent: string): string | null {
  const cleanContent = stripAnsiCodes(logContent);

  const patterns = [
    /session id:\s*([0-9a-f-]{8,})/i,
    /session_id[:=]\s*([0-9a-f-]{8,})/i,
    /sessionId["\s:=]*([0-9a-f-]{8,})/i,
  ];

  for (const pattern of patterns) {
    const match = cleanContent.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function findSessionFile(sessionId: string): string | null {
  if (!sessionId.trim()) return null;
  const codexHome = getCodexHome();
  if (!codexHome) return null;

  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return null;

  const stack: string[] = [sessionsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const extension = extname(entry.name);
      if (!SESSION_EXTENSIONS.has(extension)) continue;
      if (entry.name.includes(sessionId)) return fullPath;
    }
  }

  return null;
}

export function parseSessionFile(
  sessionFilePath: string
): ParsedSessionData | null {
  let content: string;
  try {
    content = readFileSync(sessionFilePath, "utf-8");
  } catch {
    return null;
  }

  if (sessionFilePath.endsWith(".jsonl")) {
    return parseJsonlSession(content);
  }

  return parseJsonSession(content);
}
