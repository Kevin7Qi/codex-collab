// src/claude-trust.ts — which folders Codex and Claude Code each trust, and
// carrying Codex's trust over to Claude Code (`config spawn-trust codex`).
//
// Both keep trust per folder in the user's own config: Codex in
// `$CODEX_HOME/config.toml` (`[projects."<path>"] trust_level`), Claude Code
// in `~/.claude.json` (`projects["<path>"].hasTrustDialogAccepted`). Neither
// file is documented as an interface. Every reader here fails open — an
// unreadable file trusts nothing — and the one write takes the lock Claude
// Code takes on its own file.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** What `config spawn-trust` takes. */
export const SPAWN_TRUST_SETTINGS = ["off", "codex"] as const;
export type SpawnTrustSetting = typeof SPAWN_TRUST_SETTINGS[number];

export function isSpawnTrustSetting(value: unknown): value is SpawnTrustSetting {
  return typeof value === "string" && (SPAWN_TRUST_SETTINGS as readonly string[]).includes(value);
}

export function codexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

/** Claude Code's global config, as Claude Code finds it: a legacy
 *  `.config.json` in its config folder when there is one, else `.claude.json`
 *  in `CLAUDE_CONFIG_DIR` or the home directory. */
export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  // Test seam: a test must never read or write the user's real file.
  if (env.CODEX_COLLAB_CLAUDE_CONFIG) return env.CODEX_COLLAB_CLAUDE_CONFIG;
  const legacy = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".config.json");
  if (existsSync(legacy)) return legacy;
  return join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

/** The repository a folder is in: the nearest folder at or above it with a
 *  `.git` entry, a directory or (in a linked worktree or a submodule) a file. */
function repoRootOf(folder: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** For the root of a linked worktree, the root of the repository's main
 *  working tree; null for anything else. Read the way Codex reads it: the
 *  worktree's `.git` file names `<common dir>/worktrees/<name>`, and the main
 *  working tree is the folder holding the common dir. */
export function mainWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    if (!lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
    if (!m) return null;
    const gitDir = realpathSync(isAbsolute(m[1]) ? m[1] : resolve(root, m[1]));
    if (basename(dirname(gitDir)) !== "worktrees") return null;
    return dirname(dirname(dirname(gitDir)));
  } catch {
    return null;
  }
}

/** Whether Codex trusts `folder` (a workspace root: a repository's top level,
 *  or a folder outside any repository), by its user config: an entry for the
 *  folder itself decides, else, for a linked worktree, the entry for its
 *  main working tree. An entry for a folder above does not count. Probed
 *  against Codex 0.160's own `config/read`. Undefined when there is no entry,
 *  or the file cannot be read. */
export function codexTrust(folder: string, file = codexConfigFile()): "trusted" | "untrusted" | undefined {
  let projects: Record<string, unknown>;
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!parsed.projects || typeof parsed.projects !== "object") return undefined;
    projects = parsed.projects as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const main = mainWorktreeRoot(folder);
  for (const key of main ? [folder, main] : [folder]) {
    const entry = projects[key];
    if (!entry || typeof entry !== "object") continue;
    const level = (entry as Record<string, unknown>).trust_level;
    if (level === "trusted" || level === "untrusted") return level;
  }
  return undefined;
}

function readClaudeProjects(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed.projects === "object" && parsed.projects ? parsed.projects : {};
  } catch {
    return undefined;
  }
}

/** Whether Claude Code trusts `folder`, as it decides for `claude --bg`: an
 *  entry for the folder or one above it — inside a repository, no higher
 *  than the repository's root, or for a linked worktree, its main working
 *  tree's root. Undefined when the file cannot be read. For `health`: the
 *  word that counts is Claude Code's own, when it starts a session. */
export function claudeTrusts(folder: string, file = claudeConfigFile()): boolean | undefined {
  const projects = readClaudeProjects(file);
  if (!projects) return undefined;
  const trusted = (key: string) => (projects[key] as Record<string, unknown> | undefined)?.hasTrustDialogAccepted === true;
  const repo = repoRootOf(folder);
  for (let dir = folder; ; dir = dirname(dir)) {
    if (trusted(dir)) return true;
    if (dir === repo || dirname(dir) === dir) break;
  }
  const main = repo ? mainWorktreeRoot(repo) : null;
  return main !== null && trusted(main);
}

/** Claude Code locks its config with proper-lockfile: a directory beside the
 *  file, whose mtime the holder refreshes every 5s and which counts as stale
 *  after 10s. Beside the file as named, even when it is a link: Claude Code
 *  passes the lock's path itself (`lockfilePath: \`${file}.lock\``, file the
 *  unresolved `~/.claude.json`; 2.1.289), and proper-lockfile resolves links
 *  only to derive a path it was not given. So the lock here is the same
 *  directory, and only the write follows the link. */
const CLAUDE_LOCK_STALE_MS = 10_000;
const CLAUDE_LOCK_WAIT_MS = 10_000;

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

/** True when the lock has gone: let go of, or stale and removed here. A
 *  stale lock is removed the way proper-lockfile removes one, which two
 *  writers breaking the same stale lock at once can both get past; matching
 *  it is what keeps Claude Code out while this one writes. Anything at the
 *  lock's path that cannot be removed — a file, a directory with something
 *  in it — is waited on like a lock that is held. */
function lockGone(lock: string): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = lstatSync(lock).mtimeMs;
  } catch (e) {
    return errCode(e) === "ENOENT";
  }
  if (Date.now() - mtimeMs <= CLAUDE_LOCK_STALE_MS) return false;
  try {
    rmdirSync(lock);
    return true;
  } catch (e) {
    return errCode(e) === "ENOENT";
  }
}

async function withClaudeConfigLock<T>(file: string, waitMs: number, fn: () => T): Promise<T> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
    if (Date.now() > deadline) throw new Error(`Claude Code's lock on its config, ${lock}, was still there after ${waitMs / 1000}s`);
    if (lockGone(lock)) continue;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* broken as stale by someone else */ }
  }
}

/** Mark `folder` trusted in Claude Code's config, as accepting its trust
 *  prompt there would. Under Claude Code's own lock, the file is read afresh
 *  and replaced whole, with one key changed: Claude Code re-reads it under
 *  that lock before each of its own writes, so a running session keeps the
 *  change. A file that cannot be parsed is left alone. `written` is false
 *  when the file already marked the folder trusted. */
export async function trustInClaudeCode(folder: string, file = claudeConfigFile(), opts: { lockWaitMs?: number } = {}): Promise<{ file: string; written: boolean }> {
  if (!existsSync(file)) throw new Error(`Claude Code's config, ${file}, does not exist`);
  const written = await withClaudeConfigLock(file, opts.lockWaitMs ?? CLAUDE_LOCK_WAIT_MS, () => {
    // A link (a dotfiles manager's, say) stays a link: the file it points to
    // is the one replaced.
    const target = realpathSync(file);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(target, "utf-8"));
    } catch (e) {
      throw new Error(`${file} could not be read as JSON (${e instanceof Error ? e.message : String(e)}), so it was left as it is`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file} does not hold an object, so it was left as it is`);
    const projects = config.projects && typeof config.projects === "object" ? config.projects as Record<string, Record<string, unknown>> : {};
    if (projects[folder]?.hasTrustDialogAccepted === true) return false;
    config.projects = { ...projects, [folder]: { ...projects[folder], hasTrustDialogAccepted: true } };
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    try {
      // Private from the start: the file holds the account's details, and
      // the folder it sits in may be readable by others. Then the mode the
      // file had.
      writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      chmodSync(tmp, statSync(target).mode & 0o777);
      renameSync(tmp, target);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* never written */ }
      throw e;
    }
    return true;
  });
  return { file, written };
}

export function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

/** Whether trust for `folder` would reach the home directory: it is the
 *  home directory, or a folder above it, whose trust Claude Code extends to
 *  folders below that are outside any repository. Claude Code trusts the
 *  home directory one interactive session at a time and never keeps that,
 *  so no trust is carried over to either. */
export function trustReachesHome(folder: string, home = realHome()): boolean {
  return folder === home || home.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** What `send` reports when Claude Code refuses a folder, beyond Claude
 *  Code's own words: how Codex's trust stands, and what the setting did. */
export type TrustCarry =
  | { carried: true; file: string }
  | { carried: false; detail: string };

/** With `spawn-trust codex`, after Claude Code has refused `folder`: when
 *  Codex trusts it, mark it trusted in Claude Code as well. */
export async function carryCodexTrust(folder: string, home = realHome()): Promise<TrustCarry> {
  if (folder === home) return { carried: false, detail: "Claude Code never keeps trust for the home directory, so codex-collab carries none over to it (spawn-trust codex)." };
  if (trustReachesHome(folder, home)) return { carried: false, detail: `Trust for ${folder} would reach the home directory below it, which Claude Code never keeps trust for, so codex-collab carries none over to it (spawn-trust codex).` };
  const codex = codexTrust(folder);
  if (codex === "untrusted") return { carried: false, detail: `Codex has ${folder} as untrusted, so codex-collab did not carry trust over (spawn-trust codex).` };
  if (codex !== "trusted") return { carried: false, detail: `Codex has not trusted ${folder} either, so there was no trust to carry over (spawn-trust codex).` };
  let result: { file: string; written: boolean };
  try {
    result = await trustInClaudeCode(folder);
  } catch (e) {
    return { carried: false, detail: `Codex trusts ${folder}, but codex-collab could not mark it trusted in Claude Code: ${e instanceof Error ? e.message : String(e)}.` };
  }
  // Already marked, and refused all the same: trying again would change
  // nothing. Claude Code reads trust by rules of its own, which may have
  // moved on from these.
  if (!result.written) return { carried: false, detail: `Codex trusts ${folder}, and ${result.file} already marks it trusted, yet Claude Code refused it (spawn-trust codex).` };
  return { carried: true, file: result.file };
}

/** With `spawn-trust` off: a sentence for the refusal when Codex trusts the
 *  folder and its trust could be carried over. */
export function codexTrustNote(folder: string, home = realHome()): string | undefined {
  if (trustReachesHome(folder, home) || codexTrust(folder) !== "trusted") return undefined;
  return "Codex trusts this folder; the user can have codex-collab mark the folders Codex trusts as trusted in Claude Code by running `codex-collab config spawn-trust codex` in their own terminal.";
}
