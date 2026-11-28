// src/claude-trust.test.ts — Codex's and Claude Code's trust, read and carried over
//
// Every file here is a fake in a temp folder: the user's own Codex and
// Claude Code configs are never read or written.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryCodexTrust, claudeTrusts, codexTrust, codexTrustNote, mainWorktreeRoot, trustInClaudeCode, trustReachesHome } from "./claude-trust";

const onWindows = process.platform === "win32";
// What reads and writes trust serves `send` and `health`'s trust line, which
// do not exist on Windows (Claude Code has no cross-session messaging
// there), and its folder rules are Claude Code's and Codex's POSIX ones.
const describeUnix = onWindows ? describe.skip : describe;

let root: string;
let repo: string;
let worktree: string;
let parent: string;
let nested: string;
let loose: string;
const saved = { CODEX_HOME: process.env.CODEX_HOME, CODEX_COLLAB_CLAUDE_CONFIG: process.env.CODEX_COLLAB_CLAUDE_CONFIG };

function git(...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A Codex config.toml giving each folder its trust level. */
function codexConfig(name: string, entries: Record<string, string>): string {
  const file = join(root, `${name}.toml`);
  writeFileSync(file, Object.entries(entries).map(([path, level]) => `[projects.${JSON.stringify(path)}]\ntrust_level = "${level}"\n`).join("\n"));
  return file;
}

/** A Claude Code config marking each folder trusted, beside whatever else. */
function claudeConfig(name: string, trusted: string[], extra: Record<string, unknown> = {}): string {
  const file = join(root, `${name}.json`);
  const projects = Object.fromEntries(trusted.map((p) => [p, { allowedTools: [], hasTrustDialogAccepted: true }]));
  writeFileSync(file, JSON.stringify({ numStartups: 3, ...extra, projects: { ...(extra.projects as object), ...projects } }, null, 2));
  return file;
}

beforeAll(() => {
  if (onWindows) return;
  // As Claude Code and Codex name folders: as they are on disk.
  root = realpathSync(mkdtempSync(join(tmpdir(), "cc-trust-")));
  repo = join(root, "repo");
  worktree = join(root, "repo-wt");
  parent = join(root, "parent");
  nested = join(parent, "nested");
  loose = join(root, "loose", "deeper");
  for (const d of [repo, join(repo, "sub"), nested, loose]) mkdirSync(d, { recursive: true });
  git("init", "-q", repo);
  git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", repo, "worktree", "add", "-q", worktree);
  git("init", "-q", nested);
  process.env.CODEX_HOME = join(root, "codex-home");
  process.env.CODEX_COLLAB_CLAUDE_CONFIG = join(root, "claude-carry.json");
});

afterAll(() => {
  if (onWindows) return;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describeUnix("codexTrust", () => {
  test("the folder's own entry decides, either way; no entry is no trust", () => {
    const file = codexConfig("codex-own", { [repo]: "trusted", [nested]: "untrusted" });
    expect(codexTrust(repo, file)).toBe("trusted");
    expect(codexTrust(nested, file)).toBe("untrusted");
    expect(codexTrust(loose, file)).toBeUndefined();
  });

  test("a linked worktree has its main working tree's trust, unless it has an entry of its own", () => {
    expect(mainWorktreeRoot(worktree)).toBe(repo);
    expect(mainWorktreeRoot(repo)).toBeNull();
    expect(codexTrust(worktree, codexConfig("codex-wt", { [repo]: "trusted" }))).toBe("trusted");
    expect(codexTrust(worktree, codexConfig("codex-wt-own", { [repo]: "trusted", [worktree]: "untrusted" }))).toBe("untrusted");
  });

  test("a folder above does not count, as Codex 0.160 reads it", () => {
    // Probed against Codex's own config/read: a project under a trusted
    // folder still has its project config disabled as untrusted.
    expect(codexTrust(nested, codexConfig("codex-parent", { [parent]: "trusted" }))).toBeUndefined();
    expect(codexTrust(loose, codexConfig("codex-loose", { [join(root, "loose")]: "trusted" }))).toBeUndefined();
  });

  test("a missing or unreadable file trusts nothing", () => {
    expect(codexTrust(repo, join(root, "no-such.toml"))).toBeUndefined();
    const bad = join(root, "codex-bad.toml");
    writeFileSync(bad, "[projects\nthis is not toml");
    expect(codexTrust(repo, bad)).toBeUndefined();
    writeFileSync(bad, `[projects.${JSON.stringify(repo)}]\ntrust_level = 3\n`);
    expect(codexTrust(repo, bad)).toBeUndefined();
  });
});

describeUnix("claudeTrusts", () => {
  test("the folder, or one above it no higher than its repository's root", () => {
    expect(claudeTrusts(repo, claudeConfig("cl-own", [repo]))).toBe(true);
    expect(claudeTrusts(join(repo, "sub"), claudeConfig("cl-sub", [repo]))).toBe(true);
    // Above the repository's root, an entry does not reach into it.
    expect(claudeTrusts(nested, claudeConfig("cl-above", [parent]))).toBe(false);
    expect(claudeTrusts(repo, claudeConfig("cl-none", []))).toBe(false);
  });

  test("outside a repository any folder above counts; a worktree has its main tree's trust", () => {
    expect(claudeTrusts(loose, claudeConfig("cl-loose", [join(root, "loose")]))).toBe(true);
    expect(claudeTrusts(worktree, claudeConfig("cl-wt", [repo]))).toBe(true);
  });

  test("an entry that only exists, without the trust accepted, is no trust; an unreadable file is not known", () => {
    const file = join(root, "cl-untrusted.json");
    writeFileSync(file, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: false, allowedTools: [] } } }));
    expect(claudeTrusts(repo, file)).toBe(false);
    writeFileSync(file, "{ not json");
    expect(claudeTrusts(repo, file)).toBeUndefined();
  });
});

describeUnix("trustInClaudeCode", () => {
  test("marks the folder trusted and changes nothing else, in Claude Code's own format", async () => {
    const file = claudeConfig("w-basic", [], { oauthAccount: { emailAddress: "x@y" }, projects: { [repo]: { allowedTools: ["Bash"], lastCost: 1.5 }, [loose]: { hasTrustDialogAccepted: true } } });
    const before = JSON.parse(readFileSync(file, "utf-8"));
    expect(await trustInClaudeCode(repo, file)).toEqual({ file, written: true });
    const text = readFileSync(file, "utf-8");
    const after = JSON.parse(text);
    expect(after).toEqual({ ...before, projects: { ...before.projects, [repo]: { allowedTools: ["Bash"], lastCost: 1.5, hasTrustDialogAccepted: true } } });
    expect(text).toBe(JSON.stringify(after, null, 2));
    expect(claudeTrusts(repo, file)).toBe(true);
    // The lock is let go, and no temp file is left beside the config.
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readdirSync(root).filter((f) => f.startsWith("w-basic.json.tmp"))).toEqual([]);
  });

  test("a folder already trusted leaves the file untouched", async () => {
    const file = claudeConfig("w-already", [repo]);
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const text = readFileSync(file, "utf-8");
    expect(await trustInClaudeCode(repo, file)).toEqual({ file, written: false });
    expect(readFileSync(file, "utf-8")).toBe(text);
    expect(statSync(file).mtimeMs).toBe(old.getTime());
  });

  test("keeps the file's mode, and a link stays a link to the file it names", async () => {
    const file = claudeConfig("w-mode", []);
    spawnSync("chmod", ["600", file]);
    await trustInClaudeCode(repo, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const target = claudeConfig("w-target", []);
    const link = join(root, "w-link.json");
    symlinkSync(target, link);
    await trustInClaudeCode(repo, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(claudeTrusts(repo, target)).toBe(true);
  });

  test("a file it cannot parse, or none at all, is left alone and said so", async () => {
    const file = join(root, "w-broken.json");
    writeFileSync(file, "{ \"projects\": ");
    await expect(trustInClaudeCode(repo, file)).rejects.toThrow("could not be read as JSON");
    expect(readFileSync(file, "utf-8")).toBe("{ \"projects\": ");
    expect(existsSync(`${file}.lock`)).toBe(false);
    await expect(trustInClaudeCode(repo, join(root, "w-none.json"))).rejects.toThrow("does not exist");
  });

  test("waits for Claude Code's lock, and writes once it is let go", async () => {
    const file = claudeConfig("w-locked", []);
    mkdirSync(`${file}.lock`);
    const started = Date.now();
    const release = setTimeout(() => rmSync(`${file}.lock`, { recursive: true }), 400);
    await trustInClaudeCode(repo, file);
    clearTimeout(release);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(claudeTrusts(repo, file)).toBe(true);
  });

  test("something at the lock's path that cannot be removed is waited on like a held lock, then reported", async () => {
    const cases: Array<[string, (lock: string) => void]> = [
      ["a file", (lock) => writeFileSync(lock, "")],
      ["a directory with something in it", (lock) => { mkdirSync(lock); writeFileSync(join(lock, "x"), ""); }],
      ["a link to nothing", (lock) => symlinkSync(join(root, "nowhere"), lock)],
    ];
    for (const [what, make] of cases) {
      const file = claudeConfig(`w-stuck-${cases.findIndex((c) => c[0] === what)}`, []);
      const lock = `${file}.lock`;
      make(lock);
      const old = new Date(Date.now() - 30_000);
      try { utimesSync(lock, old, old); } catch { /* a dangling link has no target to date */ }
      const text = readFileSync(file, "utf-8");
      const started = Date.now();
      await expect(trustInClaudeCode(repo, file, { lockWaitMs: 300 }), what).rejects.toThrow(`Claude Code's lock on its config, ${lock}, was still there after 0.3s`);
      expect(Date.now() - started, what).toBeLessThan(5_000);
      expect(readFileSync(file, "utf-8"), what).toBe(text);
    }
  });

  test("a lock nobody has refreshed for longer than Claude Code allows is stale, and broken", async () => {
    const file = claudeConfig("w-stale", []);
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 30_000);
    utimesSync(`${file}.lock`, old, old);
    await trustInClaudeCode(repo, file);
    expect(claudeTrusts(repo, file)).toBe(true);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});

describeUnix("carryCodexTrust", () => {
  test("marks a folder Codex trusts as trusted in Claude Code", async () => {
    mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    writeFileSync(join(process.env.CODEX_HOME!, "config.toml"), `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(nested)}]\ntrust_level = "untrusted"\n`);
    writeFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, JSON.stringify({ projects: {} }, null, 2));
    expect(await carryCodexTrust(repo)).toEqual({ carried: true, file: process.env.CODEX_COLLAB_CLAUDE_CONFIG! });
    expect(claudeTrusts(repo, process.env.CODEX_COLLAB_CLAUDE_CONFIG!)).toBe(true);
  });

  test("carries nothing where Codex has not trusted the folder, and says which", async () => {
    writeFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, JSON.stringify({ projects: {} }, null, 2));
    const untrusted = await carryCodexTrust(nested);
    expect(untrusted).toEqual({ carried: false, detail: expect.stringContaining(`Codex has ${nested} as untrusted`) });
    const none = await carryCodexTrust(loose);
    expect(none).toEqual({ carried: false, detail: expect.stringContaining(`Codex has not trusted ${loose} either`) });
    expect(JSON.parse(readFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, "utf-8"))).toEqual({ projects: {} });
  });

  test("never the home directory, whose trust Claude Code never keeps, nor a folder above it", async () => {
    writeFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, JSON.stringify({ projects: {} }, null, 2));
    // Codex trusts `repo`; here it is also the home directory.
    const home = await carryCodexTrust(repo, repo);
    expect(home).toEqual({ carried: false, detail: expect.stringContaining("never keeps trust for the home directory") });
    // Outside a repository Claude Code's trust reaches the folders below:
    // trusting one above the home directory would trust that too.
    const above = await carryCodexTrust(root, repo);
    expect(above).toEqual({ carried: false, detail: expect.stringContaining(`Trust for ${root} would reach the home directory below it`) });
    expect(codexTrustNote(repo, repo)).toBeUndefined();
    expect(JSON.parse(readFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, "utf-8"))).toEqual({ projects: {} });
    expect(trustReachesHome("/h/u", "/h/u")).toBe(true);
    expect(trustReachesHome("/h", "/h/u")).toBe(true);
    expect(trustReachesHome("/", "/h/u")).toBe(true);
    expect(trustReachesHome("/h/u/p", "/h/u")).toBe(false);
    expect(trustReachesHome("/h/us", "/h/u")).toBe(false);
    expect(trustReachesHome("/h/u", "/h/user")).toBe(false);
  });

  test("a folder the file already marks trusted, refused all the same, is said so, and not written", async () => {
    writeFileSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }, null, 2));
    const already = await carryCodexTrust(repo);
    expect(already).toEqual({ carried: false, detail: `Codex trusts ${repo}, and ${process.env.CODEX_COLLAB_CLAUDE_CONFIG} already marks it trusted, yet Claude Code refused it (spawn-trust codex).` });
  });

  test("a write that fails is reported with Codex's trust and the reason", async () => {
    rmSync(process.env.CODEX_COLLAB_CLAUDE_CONFIG!, { force: true });
    const failed = await carryCodexTrust(repo);
    expect(failed).toEqual({ carried: false, detail: expect.stringContaining(`Codex trusts ${repo}, but codex-collab could not mark it trusted in Claude Code:`) });
  });

  test("with the setting off, the refusal names Codex's trust only where there is some", () => {
    expect(codexTrustNote(repo)).toContain("codex-collab config spawn-trust codex");
    expect(codexTrustNote(nested)).toBeUndefined();
    expect(codexTrustNote(loose)).toBeUndefined();
  });
});
