// src/codex-hooks.ts — the Codex hooks that hand a thread what Claude sent it
//
// `config codex-hook on` adds three hooks to Codex's user-level hooks file,
// `$CODEX_HOME/hooks.json`: after each tool call (PostToolUse), when a turn
// would end (Stop) and when the user writes to the thread (UserPromptSubmit),
// each running `codex-collab hook` (commands/hook.ts). The file may hold the
// user's own hooks: ours go after theirs, since Codex keys each hook's trust
// by its place in the file, and only ours are ever taken out. Codex asks the
// user to trust them before they run.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shellQuote } from "./approvals";
import { config } from "./config";
import { HOOK_EVENTS } from "./commands/hook";

/** What Codex may put in context from one of our hooks before it moves the
 *  text to a file instead (its default is 2,500 tokens). The hook keeps
 *  under it (HOOK_BUDGET_TOKENS). */
export const HOOK_CONTEXT_LIMIT = 8000;

/** Seconds a hook may run: it reads a few small files. */
export const HOOK_TIMEOUT_SEC = 10;

/** Whether the user opted in (`config codex-hook on`). Read straight from
 *  the config file: this module sits below the command layer. */
export function codexHookEnabled(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(config.configFile, "utf-8")) as Record<string, unknown> | null;
    return cfg?.["codex-hook"] === "on";
  } catch {
    return false;
  }
}

export function codexHooksPath(): string {
  const override = process.env.CODEX_COLLAB_CODEX_HOOKS_PATH;
  if (override) return override;
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "hooks.json");
}

/** The command each hook runs: Bun and this CLI by absolute path, since a
 *  hook the Codex app starts on macOS has a PATH with neither. */
export function hookCommand(bun: string = process.execPath, cli: string = process.argv[1]): string {
  return `${shellQuote(bun)} ${shellQuote(cli)} hook`;
}

/** Whether a hook handler is one of ours: it runs this CLI's `hook`. */
export function isOurHandler(h: unknown): boolean {
  const command = (h as { command?: unknown } | null)?.command;
  return typeof command === "string" && / hook$/.test(command) && /codex-collab|cli\.ts/.test(command);
}

function ourHandler(event: string, command: string): Record<string, unknown> {
  return {
    type: "command",
    command,
    timeout: HOOK_TIMEOUT_SEC,
    // Stop hands its text over as a reason, which has no such limit.
    ...(event === "Stop" ? {} : { additionalContextLimit: HOOK_CONTEXT_LIMIT }),
  };
}

type HooksDoc = { hooks?: Record<string, unknown> } & Record<string, unknown>;

/** The hooks file as written, {} when there is none. A file that is not a
 *  hooks file is reported, and never written over. */
function readDoc(path: string): HooksDoc {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}); codex-collab leaves it as it is`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${path} does not hold a JSON object; codex-collab leaves it as it is`);
  const hooks = (doc as HooksDoc).hooks;
  if (hooks !== undefined && (!hooks || typeof hooks !== "object" || Array.isArray(hooks))) throw new Error(`${path} has a "hooks" that is not an object; codex-collab leaves it as it is`);
  return doc as HooksDoc;
}

/** Every group of an event with our handlers taken out; groups left empty go. */
function withoutOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    const handlers = (g as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(handlers)) { out.push(g); continue; }
    const kept = handlers.filter((h) => !isOurHandler(h));
    if (kept.length === 0) continue;
    out.push(kept.length === handlers.length ? g : { ...(g as object), hooks: kept });
  }
  return out;
}

function writeDoc(path: string, doc: HooksDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try { mode = statSync(path).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${path}.codex-collab-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Add our hooks (replacing any of ours already there). Returns the path. */
export function installCodexHooks(command: string = hookCommand(), path: string = codexHooksPath()): string {
  const doc = readDoc(path);
  const hooks: Record<string, unknown> = { ...(doc.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...withoutOurs(hooks[event]), { hooks: [ourHandler(event, command)] }];
  }
  writeDoc(path, { ...doc, hooks });
  return path;
}

/** Take our hooks out, leaving the user's; the file goes when nothing else
 *  is in it. False when none of ours were there. */
export function removeCodexHooks(path: string = codexHooksPath()): boolean {
  if (!existsSync(path)) return false;
  const doc = readDoc(path);
  if (!doc.hooks) return false;
  let found = false;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    if (groups.some((g) => { const hs = (g as { hooks?: unknown } | null)?.hooks; return Array.isArray(hs) && hs.some(isOurHandler); })) found = true;
    const kept = withoutOurs(groups);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!found) return false;
  const rest: HooksDoc = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) delete rest.hooks;
  if (Object.keys(rest).length === 0) rmSync(path, { force: true });
  else writeDoc(path, rest);
  return true;
}

/** Whether our hooks are installed as this binary would write them: true,
 *  false (some missing or different — `config codex-hook on` writes them
 *  again), or null when none are. */
export function codexHooksInSync(command: string = hookCommand(), path: string = codexHooksPath()): boolean | null {
  let doc: HooksDoc;
  try {
    doc = readDoc(path);
  } catch {
    return false;
  }
  let ours = 0;
  let right = 0;
  for (const event of HOOK_EVENTS) {
    const groups = doc.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const handlers = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        if (!isOurHandler(h)) continue;
        ours++;
        if (JSON.stringify(h) === JSON.stringify(ourHandler(event, command))) right++;
      }
    }
  }
  if (ours === 0) return null;
  return ours === HOOK_EVENTS.length && right === HOOK_EVENTS.length;
}
