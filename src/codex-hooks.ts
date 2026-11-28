// src/codex-hooks.ts — the Codex hooks that hand a thread what Claude sent it
//
// `config codex-hook on` adds three hooks to Codex's user-level hooks file,
// `$CODEX_HOME/hooks.json`: after each tool call (PostToolUse), when a turn
// would end (Stop) and when the user writes to the thread (UserPromptSubmit),
// each running `codex-collab hook` (commands/hook.ts). The file may hold the
// user's own hooks: ours go after theirs, since Codex keys each hook's trust
// by its place in the file, and only ours are ever taken out. Codex asks the
// user to trust them before they run.
//
// Whether they do run is known only from the hook itself: each time Codex
// runs it in a thread, it notes so (`noteHookRan`), and `send` and `task`
// tell Codex its reply comes by itself, and a wake starts a turn, only where
// our hooks are still where and what they were at that run (`hooksRunIn`);
// the promise also needs a recent one (`RECENT_HOOK_RUN_MS`).

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config";
import { isThreadId } from "./claude-channel";

/** The events our hooks answer (commands/hook.ts says how each hands a
 *  message over). */
export const HOOK_EVENTS = ["PostToolUse", "Stop", "UserPromptSubmit"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

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

/** Quoted for the Unix hook shell. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The path hooks reach this CLI by: the link the installer manages, where
 *  one leads to this very CLI. Bun resolves the link a script starts through,
 *  so `process.argv[1]` is the file behind it — in a dev install, a checkout,
 *  which can move or go. The link stays, and follows whichever install is
 *  current, so hooks need no rewriting, and Codex no new trust, when that
 *  changes. With no such link, or one leading elsewhere (a CLI run from
 *  another checkout), the path it runs from. */
export function stableCliPath(cli: string = process.argv[1], links: Array<string | null> = process.platform === "win32"
  ? [join(homedir(), ".claude", "skills", "codex-collab", "scripts", "codex-collab")]
  : [Bun.which("codex-collab"), join(homedir(), ".local", "bin", "codex-collab")]): string {
  let real: string;
  try {
    real = realpathSync(cli);
  } catch {
    return cli;
  }
  for (const link of links) {
    if (!link) continue;
    try {
      if (realpathSync(link) === real) return link;
    } catch { /* a link to nothing */ }
  }
  return cli;
}

/** The command each hook runs: Bun and this CLI by absolute path, since a
 *  hook the Codex app starts on macOS has a PATH with neither. */
export function hookCommand(bun: string = process.execPath, cli: string = stableCliPath(), platform: string = process.platform): string {
  if (platform === "win32") {
    // Codex wraps the entire command in quotes for cmd.exe /C.
    if (/["%!\r\n]/.test(bun) || /["%!\r\n]/.test(cli)) {
      throw new Error("Codex hook paths cannot contain cmd.exe expansion characters (quotes, %, or !)");
    }
    return `"${bun}" "${cli}" hook`;
  }
  return `${shQuote(bun)} ${shQuote(cli)} hook`;
}

/** Whether a hook handler is one of ours: the very command this install
 *  writes (`current`), or one `hookCommand` wrote for another install of
 *  codex-collab — two quoted paths, the second with codex-collab in it, then
 *  `hook`. Nothing else is, so that no hook of the user's — another project's
 *  `cli.ts hook`, say — is ever taken for one, replaced or removed. */
export function isOurHandler(h: unknown, current: string = hookCommand()): boolean {
  const command = (h as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  if (command === current) return true;
  const m = /^'(?:[^']|'\\'')+' '((?:[^']|'\\'')+)' hook$/.exec(command) ?? /^"[^"%!\r\n]+" "([^"%!\r\n]+)" hook$/.exec(command);
  return !!m && /codex-collab/.test(m[1]);
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
function withoutOurs(groups: unknown, command: string): unknown[] {
  if (!Array.isArray(groups)) return [];
  const out: unknown[] = [];
  for (const g of groups) {
    const handlers = (g as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(handlers)) { out.push(g); continue; }
    const kept = handlers.filter((h) => !isOurHandler(h, command));
    if (kept.length === 0) continue;
    out.push(kept.length === handlers.length ? g : { ...(g as object), hooks: kept });
  }
  return out;
}

/** Replace the file's content, atomically. A link (a dotfiles manager's,
 *  say) stays a link: the file it points to is the one replaced. */
function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let target = path;
  try { target = realpathSync(path); } catch { /* a new file */ }
  let mode = 0o600;
  try { mode = statSync(target).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${target}.codex-collab-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function writeDoc(path: string, doc: HooksDoc): void {
  writeText(path, JSON.stringify(doc, null, 2) + "\n");
}

/** The hooks file as it is now, to put back as it was: null for none. */
export function snapshotCodexHooks(path: string = codexHooksPath()): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Put the hooks file back as a snapshot had it. */
export function restoreCodexHooks(snapshot: string | null, path: string = codexHooksPath()): void {
  if (snapshot === null) rmSync(path, { force: true });
  else writeText(path, snapshot);
}

/** Our hooks in an event's groups, written where ours already are, so that
 *  every hook keeps its place — Codex keys each hook's trust by it — or
 *  after the user's when there were none. */
function withOurs(groups: unknown, handler: Record<string, unknown>, command: string): unknown[] {
  const list = Array.isArray(groups) ? groups : [];
  const ours = (h: unknown) => isOurHandler(h, command);
  let placed = false;
  const out: unknown[] = [];
  for (const g of list) {
    const handlers = (g as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(handlers) || !handlers.some(ours)) { out.push(g); continue; }
    const kept: unknown[] = [];
    for (const h of handlers) {
      if (!ours(h)) kept.push(h);
      else if (!placed) { kept.push(handler); placed = true; }
    }
    if (kept.length > 0) out.push({ ...(g as object), hooks: kept });
  }
  return placed ? out : [...out, { hooks: [handler] }];
}

/** Add our hooks (replacing any of ours already there). Returns the path. */
export function installCodexHooks(command: string = hookCommand(), path: string = codexHooksPath()): string {
  const doc = readDoc(path);
  const hooks: Record<string, unknown> = { ...(doc.hooks ?? {}) };
  for (const event of HOOK_EVENTS) hooks[event] = withOurs(hooks[event], ourHandler(event, command), command);
  writeDoc(path, { ...doc, hooks });
  return path;
}

/** Take our hooks out, leaving the user's; the file goes when nothing else
 *  is in it. False when none of ours were there. */
export function removeCodexHooks(path: string = codexHooksPath(), command: string = hookCommand()): boolean {
  if (!existsSync(path)) return false;
  const doc = readDoc(path);
  if (!doc.hooks) return false;
  let found = false;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(doc.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    if (groups.some((g) => { const hs = (g as { hooks?: unknown } | null)?.hooks; return Array.isArray(hs) && hs.some((h) => isOurHandler(h, command)); })) found = true;
    const kept = withoutOurs(groups, command);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!found) return false;
  const rest: HooksDoc = { ...doc, hooks };
  if (Object.keys(hooks).length === 0) delete rest.hooks;
  // The file goes once it holds nothing — unless it is a link, which is the
  // user's setup: it keeps an empty object.
  let link = false;
  try { link = lstatSync(path).isSymbolicLink(); } catch { /* gone */ }
  if (Object.keys(rest).length === 0 && !link) rmSync(path, { force: true });
  else writeDoc(path, rest);
  return true;
}

/** The events in which a hook of the user's comes after one of ours. Codex
 *  keys its trust in a hook by the hook's place in the file, so taking ours
 *  out moves those up, and Codex asks for the user's trust in them again;
 *  until then they do not run. */
export function hooksAfterOurs(path: string = codexHooksPath(), command: string = hookCommand()): string[] {
  let doc: HooksDoc;
  try {
    doc = readDoc(path);
  } catch {
    return [];
  }
  const events: string[] = [];
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    let seenOurs = false;
    let theirsAfter = false;
    for (const g of groups) {
      const handlers = (g as { hooks?: unknown } | null)?.hooks;
      for (const h of Array.isArray(handlers) ? handlers : [g]) {
        if (isOurHandler(h, command)) seenOurs = true;
        else if (seenOurs) theirsAfter = true;
      }
    }
    if (theirsAfter) events.push(event);
  }
  return events;
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
        if (!isOurHandler(h, command)) continue;
        ours++;
        if (JSON.stringify(h) === JSON.stringify(ourHandler(event, command))) right++;
      }
    }
  }
  if (ours === 0) return null;
  return ours === HOOK_EVENTS.length && right === HOOK_EVENTS.length;
}

/** A value with its objects' keys in order, so that one written again with
 *  its keys moved about reads the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/** What Codex's trust in our hooks rests on, as the hooks file has it now,
 *  in short: each of ours with its place — event, group, handler, the key
 *  Codex keeps that trust under — and what Codex hashes for it, which is the
 *  handler and its group's other fields (the matcher). Nothing else in the
 *  file counts: the user's own hooks, other events, the layout. Null when
 *  the file holds none of ours, or cannot be read. */
export function ourHooksPrint(path: string = codexHooksPath()): string | null {
  let doc: HooksDoc;
  try {
    doc = readDoc(path);
  } catch {
    return null;
  }
  // This install's command, worked out once; any install's is ours too
  // (`isOurHandler`), so one this process cannot tell (no script path)
  // leaves that.
  let command = "";
  try { command = hookCommand(); } catch { /* no script path */ }
  const ours: Array<[string, unknown]> = [];
  for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, i) => {
      const handlers = (g as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) return;
      const { hooks: _, ...group } = g as Record<string, unknown>;
      handlers.forEach((h, j) => { if (isOurHandler(h, command)) ours.push([`${event}:${i}:${j}`, canonical({ group, h })]); });
    });
  }
  if (ours.length === 0) return null;
  ours.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(ours)).digest("hex").slice(0, 32);
}

/** Where the hook notes when Codex last ran it in each thread: a file per
 *  thread, named by its id, whose time is that run's, holding what our hooks
 *  were then (`ourHooksPrint`). */
export function hookRunsDir(): string {
  return join(config.dataDir, "hook-runs");
}

/** How long a thread's note is kept after the hook last ran in it. */
const HOOK_RUN_KEEP_MS = 7 * 24 * 3600 * 1000;

/** Note that Codex ran the hook in this thread just now, with our hooks as
 *  the file has them. Codex runs it after every tool call in every thread,
 *  so this is a read and a touch of a file that is there already; a
 *  thread's first note also clears the notes of threads the hook has not
 *  run in for a week. Never throws: the hook's work goes on whether or not
 *  this was written. */
export function noteHookRan(threadId: string, dir: string = hookRunsDir(), now: Date = new Date(), hooksPath: string = codexHooksPath()): void {
  if (!isThreadId(threadId)) return;
  const path = join(dir, threadId);
  const print = ourHooksPrint(hooksPath) ?? "";
  try {
    if (readFileSync(path, "utf-8") !== print) writeFileSync(path, print, { mode: 0o600 });
    utimesSync(path, now, now);
    return;
  } catch { /* the thread's first */ }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, print, { mode: 0o600 });
    utimesSync(path, now, now);
  } catch {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const old = join(dir, name);
    try {
      if (now.getTime() - statSync(old).mtimeMs > HOOK_RUN_KEEP_MS) rmSync(old, { force: true });
    } catch { /* gone already */ }
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** How lately the hook must have run in a thread for a command there to
 *  promise that a reply comes by itself. Such a command runs in one of the
 *  thread's turns, and in a turn where Codex runs the hooks one ran after
 *  the last tool call, or with the user's message: a thread in whose turns
 *  none has run for this long has lost them inside Codex — its trust
 *  withdrawn, or reset by an update — which nothing on disk here shows. */
export const RECENT_HOOK_RUN_MS = 3600 * 1000;

/** `within`: the hook must also have run in the thread no longer than that
 *  ago (ms; `now` is a test seam). */
type HookSettings = { runsDir?: string; hooksPath?: string; enabled?: boolean; within?: number; now?: number };

/** A thread's note: when the hook last ran there, and what our hooks were. */
function readNote(path: string): { at: number; print: string } | null {
  try {
    return { at: statSync(path).mtimeMs, print: readFileSync(path, "utf-8") };
  } catch {
    return null;
  }
}

/** Whether a note still says Codex runs the hook: the user has them on, and
 *  our hooks are where and what they were when it ran, which is what
 *  Codex's trust in them rests on. An edit that moves or changes one of
 *  ours (Codex asks for the user's trust in it again), or takes them out,
 *  makes it false until the hook runs again; other edits to the file leave
 *  it as it was. Codex's own config, where it keeps that trust, is not
 *  looked at: Codex writes it for reasons of its own, and an idle thread,
 *  where the hook cannot run, would read as one without hooks after every
 *  such write. */
function stillRuns(note: { at: number; print: string } | null, opts: HookSettings): boolean {
  if (note === null || !(opts.enabled ?? codexHookEnabled())) return false;
  const now = ourHooksPrint(opts.hooksPath ?? codexHooksPath());
  return now !== null && note.print === now;
}

/** Forget every run noted: `config codex-hook` changed our hooks, and Codex
 *  may have let go of its trust in them meanwhile, so that a hook that ran
 *  before says nothing of them now. */
export function forgetHookRuns(dir: string = hookRunsDir()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (isThreadId(name)) rmSync(join(dir, name), { force: true });
}

/** Whether the hook has run in this thread at all within the week its runs
 *  are kept (`noteHookRan`), whatever has changed since. */
export function hookRanIn(threadId: string, runsDir: string = hookRunsDir()): boolean {
  return isThreadId(threadId) && mtimeOf(join(runsDir, threadId)) !== null;
}

/** Whether Codex runs our hooks in this thread as things stand: they are on,
 *  and the hook ran there with our hooks as they are now (`stillRuns`).
 *  Then whatever reaches the thread's mailbox is handed to it by itself,
 *  during a turn or with the user's next message. A change to ours makes
 *  this false until the hook runs again, at the thread's next turn. */
export function hooksRunIn(threadId: string, opts: HookSettings = {}): boolean {
  if (!isThreadId(threadId)) return false;
  const note = readNote(join(opts.runsDir ?? hookRunsDir(), threadId));
  if (note !== null && opts.within !== undefined && (opts.now ?? Date.now()) - note.at > opts.within) return false;
  return stillRuns(note, opts);
}

/** When Codex last ran the hook in any thread (ms), and whether our hooks
 *  are as they were then; null when there is no note of any run. */
export function lastHookRun(opts: HookSettings = {}): { at: number; current: boolean } | null {
  const dir = opts.runsDir ?? hookRunsDir();
  let latest: { at: number; print: string } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!isThreadId(name)) continue;
    const note = readNote(join(dir, name));
    if (note !== null && (latest === null || note.at > latest.at)) latest = note;
  }
  return latest === null ? null : { at: latest.at, current: stillRuns(latest, opts) };
}
