// `codex-collab uninstall`, run against a home of its own: what it removes,
// what it leaves, what it stops first, and what holds it up.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRun } from "../threads";
import { writeTask, type TaskRecord } from "../claude-tasks";
import type { RunRecord } from "../types";

setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "cli.ts");
const windows = process.platform === "win32";
const unixOnly = windows ? test.skip : test;
const linuxOnly = process.platform === "linux" ? test : test.skip;

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  children.length = 0;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Home {
  root: string;
  home: string;
  codexHome: string;
  temp: string;
  dataDir: string;
  workspace: string;
  env: Record<string, string>;
}

/** A home, a Codex home and a temp folder of the test's own, and an
 *  environment that names only those: nothing of the machine's leaks in. */
function makeHome(): Home {
  const root = mkdtempSync(join(tmpdir(), "cc-uninstall-"));
  roots.push(root);
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const temp = join(root, "tmp");
  const dataDir = join(home, ".codex-collab");
  const workspace = join(dataDir, "workspaces", "ws-0123456789abcdef");
  mkdirSync(temp, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("CODEX_") || k.startsWith("CLAUDE_")) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, TMPDIR: temp, TEMP: temp, TMP: temp, CODEX_COLLAB_NO_UPDATE_CHECK: "1" });
  return { root, home, codexHome, temp, dataDir, workspace, env };
}

async function uninstall(h: Home, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", CLI, "uninstall", ...args], { env: h.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

/** The plan, and a check that everything it would remove is the test's. */
async function plan(h: Home): Promise<string> {
  const shown = await uninstall(h);
  const removes = shown.stdout.split("It removes:")[1]?.split("These stay:")[0] ?? "";
  const paths = removes.match(/(?:\/|[A-Za-z]:\\)[^\s;,]+/g) ?? [];
  for (const p of paths) expect(p.startsWith(h.root)).toBe(true);
  return shown.stdout + shown.stderr;
}

const OUR_HOOK = { type: "command", command: "'/usr/local/bin/bun' '/somewhere/codex-collab' hook", timeout: 600 };

/** Everything the installers and codex-collab put in a home, and a few of
 *  the user's own things beside them. */
function install(h: Home): { checkout: string; mailboxes: string } {
  const skill = join(h.home, ".claude", "skills", "codex-collab");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "skill\n");
  // A dev install's skill links into the checkout, which stays.
  const checkout = join(h.root, "checkout");
  mkdirSync(join(checkout, "src"), { recursive: true });
  writeFileSync(join(checkout, "src", "cli.ts"), "// the CLI\n");
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "codex-collab" }));
  const bin = join(h.home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "other-tool"), "theirs\n");
  if (windows) {
    writeFileSync(join(skill, "scripts", "codex-collab"), "// bundle\n");
    const target = join(skill, "scripts", "codex-collab");
    writeFileSync(join(bin, "codex-collab.cmd"), `@bun "${target}" %*\r\n`);
    writeFileSync(join(bin, "codex-collab"), `#!/usr/bin/env bash\nexec bun "${target}" "$@"`);
  } else {
    symlinkSync(join(checkout, "src", "cli.ts"), join(skill, "scripts", "codex-collab"));
    symlinkSync(join(checkout, "src", "cli.ts"), join(bin, "codex-collab"));
  }
  mkdirSync(join(h.codexHome, "skills", "claude-collab"), { recursive: true });
  writeFileSync(join(h.codexHome, "skills", "claude-collab", "SKILL.md"), "codex skill\n");
  mkdirSync(join(h.codexHome, "rules"), { recursive: true });
  writeFileSync(join(h.codexHome, "rules", "codex-collab.rules"), "rule\n");
  writeFileSync(join(h.codexHome, "rules", "default.rules"), "theirs\n");
  // The user's hooks before and after ours.
  writeFileSync(join(h.codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [OUR_HOOK] }, { hooks: [{ type: "command", command: "their-stop-hook" }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "their-tool-hook" }] }, { hooks: [OUR_HOOK] }],
    },
  }));
  // A config the uninstall must not depend on being able to read.
  writeFileSync(join(h.dataDir, "config.json"), "{ not json\n");
  mkdirSync(join(h.dataDir, "templates"), { recursive: true });
  writeFileSync(join(h.dataDir, "templates", "my-review.md"), "---\nname: my-review\n---\nmine\n");
  // The note that Codex ran the hooks in a thread.
  mkdirSync(join(h.dataDir, "hook-runs"), { recursive: true });
  writeFileSync(join(h.dataDir, "hook-runs", "0199a000-0000-7000-8000-0000000000aa"), "print\n");
  const mailboxes = join(h.temp, `codex-collab-${typeof process.getuid === "function" ? process.getuid() : "u"}`);
  mkdirSync(mailboxes, { recursive: true, mode: 0o700 });
  return { checkout, mailboxes };
}

describe("uninstall", () => {
  test("removes what codex-collab installed, after showing it, and leaves the user's own and its records", async () => {
    const h = makeHome();
    const { checkout, mailboxes } = install(h);
    // An entry a broker killed outright left in Claude Code's registry.
    const registry = join(h.home, ".claude", "sessions");
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, "999999.json"), JSON.stringify({ pid: 999_999, messagingSocketPath: join(h.dataDir, "workspaces", "ws-0123456789abcdef", "peer.sock") }));
    writeFileSync(join(registry, "123.json"), JSON.stringify({ pid: 999_998, messagingSocketPath: join(h.root, "a-claude-session.sock") }));

    // Only the bare flags agree, and no other command's option is taken.
    for (const args of [["--yes=false"], ["--purge=no", "--yes"], ["--check", "--yes"], ["--dir", h.root, "--yes"]]) {
      const malformed = await uninstall(h, ...args);
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain("uninstall takes no arguments other than --yes and --purge");
    }
    expect(existsSync(h.dataDir)).toBe(true);

    const shown = await plan(h);
    expect(shown).toContain("codex-collab's hooks in");
    expect(shown).toContain("Codex asks you to trust again those that move up a place (Stop)");
    expect(shown).toContain("the Codex rule");
    expect(shown).toContain("1 entry codex-collab's processes left in Claude Code's session registry");
    // The records stay, and say how they would go too.
    const stays = shown.split("These stay:")[1] ?? "";
    expect(stays).toContain(`codex-collab's records in ${h.dataDir}: settings, thread records and logs, with your 1 prompt template in ${join(h.dataDir, "templates")}, for a later install to pick up; \`--purge\` deletes them as well`);
    expect(shown).toContain("Not applied (no --yes in a non-interactive session)");
    // Shown, and nothing done.
    expect(existsSync(h.dataDir)).toBe(true);
    expect(readFileSync(join(h.codexHome, "hooks.json"), "utf-8")).toContain("codex-collab");

    const done = await uninstall(h, "--yes");
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("codex-collab is uninstalled.");
    expect(existsSync(join(h.codexHome, "skills", "claude-collab"))).toBe(false);
    for (const gone of [
      join(h.home, ".claude", "skills", "codex-collab"),
      join(h.home, ".local", "bin", "codex-collab"),
      join(h.home, ".local", "bin", "codex-collab.cmd"),
      join(h.codexHome, "rules", "codex-collab.rules"),
      mailboxes,
      join(registry, "999999.json"),
      // What Codex ran in which thread says nothing once the hooks are gone.
      join(h.dataDir, "hook-runs", "0199a000-0000-7000-8000-0000000000aa"),
    ]) expect(existsSync(gone)).toBe(false);
    // The user's hooks keep their order; nothing of ours is left.
    expect(JSON.parse(readFileSync(join(h.codexHome, "hooks.json"), "utf-8"))).toEqual({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "their-stop-hook" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "their-tool-hook" }] }],
      },
    });
    for (const kept of [
      join(h.codexHome, "rules", "default.rules"),
      join(h.home, ".local", "bin", "other-tool"),
      join(checkout, "src", "cli.ts"),
      join(registry, "123.json"),
      // Its records, for a later install.
      join(h.dataDir, "config.json"),
      join(h.dataDir, "templates", "my-review.md"),
    ]) expect(existsSync(kept)).toBe(true);
    expect(done.stdout).toContain(`Its records stay in ${h.dataDir}`);

    const again = await uninstall(h, "--yes");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`Nothing of codex-collab's is left to remove but its records in ${h.dataDir}, which stay`);

    // Asked for, the records go too.
    const purged = await uninstall(h, "--yes", "--purge");
    expect(purged.code).toBe(0);
    expect(purged.stdout).toContain(`Removed codex-collab's records in ${h.dataDir}`);
    expect(existsSync(h.dataDir)).toBe(false);
    expect((await uninstall(h, "--yes", "--purge")).stdout).toContain("Nothing of codex-collab's is left to remove.");
  });

  test("with --purge, lists the records among what it removes, and removes them with the rest", async () => {
    const h = makeHome();
    install(h);
    const shown = await uninstall(h, "--purge");
    const removes = shown.stdout.split("It removes:")[1]?.split("These stay:")[0] ?? "";
    expect(removes).toContain(`codex-collab's records in ${h.dataDir}: settings, thread records and logs, with your 1 prompt template`);
    expect(existsSync(h.dataDir)).toBe(true);
    const done = await uninstall(h, "--purge", "--yes");
    expect(done.code).toBe(0);
    expect(existsSync(h.dataDir)).toBe(false);
    expect(existsSync(join(h.home, ".claude", "skills", "codex-collab"))).toBe(false);
    expect(done.stdout).not.toContain("Its records stay");
  });

  unixOnly("leaves a codex-collab command the installers did not make", async () => {
    for (const target of ["/bin/sh", "another project's CLI"]) {
      const h = makeHome();
      install(h);
      const command = join(h.home, ".local", "bin", "codex-collab");
      rmSync(command);
      if (target === "/bin/sh") {
        symlinkSync(target, command);
      } else {
        const other = join(h.root, "other-project");
        mkdirSync(join(other, "src"), { recursive: true });
        writeFileSync(join(other, "src", "cli.ts"), "// theirs\n");
        writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other-project" }));
        symlinkSync(join(other, "src", "cli.ts"), command);
      }
      expect(await plan(h)).not.toContain("the command");
      expect((await uninstall(h, "--yes")).code).toBe(0);
      expect(existsSync(command)).toBe(true);
      expect(existsSync(join(h.home, ".claude", "skills", "codex-collab"))).toBe(false);
    }
  });

  test("leaves the user's own files in a skill folder, and the folder with them", async () => {
    const h = makeHome();
    install(h);
    const skills = [join(h.home, ".claude", "skills", "codex-collab"), ...(windows ? [] : [join(h.codexHome, "skills", "claude-collab")])];
    for (const dir of skills) writeFileSync(join(dir, "my-notes.md"), "mine\n");
    const done = await uninstall(h, "--yes");
    expect(done.code).toBe(0);
    for (const dir of skills) {
      expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
      expect(existsSync(join(dir, "my-notes.md"))).toBe(true);
      expect(done.stdout).toContain(`from ${dir}; the folder stays, with files codex-collab did not put there.`);
    }
    expect(existsSync(join(skills[0], "scripts"))).toBe(false);
  });

  unixOnly("takes out a linked skill folder as a link, and leaves what it leads to", async () => {
    const h = makeHome();
    install(h);
    const codexSkill = join(h.codexHome, "skills", "claude-collab");
    const source = join(h.root, "checkout", "codex-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "tracked source\n");
    rmSync(codexSkill, { recursive: true });
    symlinkSync(source, codexSkill);
    const done = await uninstall(h, "--yes");
    expect(done.code).toBe(0);
    expect(done.stdout).toContain(`Removed the link ${codexSkill}; what it leads to stays.`);
    expect(existsSync(codexSkill)).toBe(false);
    expect(readFileSync(join(source, "SKILL.md"), "utf-8")).toBe("tracked source\n");
  });

  test("is held up by a hooks file it cannot read, which may hold hooks of codex-collab's", async () => {
    const h = makeHome();
    install(h);
    writeFileSync(join(h.codexHome, "hooks.json"), "{ \"hooks\": ");
    const refused = await uninstall(h, "--yes");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("codex-collab cannot be uninstalled yet:");
    expect(refused.stderr).toContain(`${join(h.codexHome, "hooks.json")} cannot be read`);
    expect(existsSync(h.dataDir)).toBe(true);
    expect(existsSync(join(h.home, ".claude", "skills", "codex-collab", "SKILL.md"))).toBe(true);
  });

  (windows || process.getuid?.() === 0 ? test.skip : test)("keeps the command while Codex's hooks cannot be taken out", async () => {
    const h = makeHome();
    install(h);
    // The hooks file is rewritten through a file beside it: a folder that
    // cannot be written keeps it as it is.
    chmodSync(h.codexHome, 0o555);
    try {
      const done = await uninstall(h, "--yes");
      expect(done.code).toBe(1);
      expect(done.stderr).toContain("could not take the hooks out of");
      expect(done.stderr).toContain("Nothing else was removed");
      expect(existsSync(join(h.home, ".local", "bin", "codex-collab"))).toBe(true);
      expect(existsSync(join(h.home, ".claude", "skills", "codex-collab", "SKILL.md"))).toBe(true);
      expect(existsSync(h.dataDir)).toBe(true);
    } finally {
      chmodSync(h.codexHome, 0o755);
    }
  });

  unixOnly("is refused while a Codex turn runs, and then changes nothing", async () => {
    const h = makeHome();
    install(h);
    // A runner is codex-collab's CLI; a pid some crashed runner's record still
    // names, and the system has since given to something else, is not.
    const runner = Bun.spawn(["sh", "-c", "sleep 60; true", "codex-collab", "run"]);
    const unrelated = Bun.spawn(["sleep", "60"]);
    children.push(runner, unrelated);
    const run = (shortId: string, pid: number) => createRun(h.workspace, {
      runId: `run-${shortId}`, threadId: "0199a000-0000-7000-8000-000000000001", shortId, kind: "task", phase: null,
      status: "running", pid, sessionId: null, logFile: `${shortId}.log`, logOffset: 0, prompt: "a job", model: null,
      startedAt: new Date().toISOString(), completedAt: null, elapsed: null, output: null, filesChanged: null, commandsRun: null, error: null,
    } as RunRecord);
    run("a1b2c3d4", runner.pid);
    run("e5f6a7b8", unrelated.pid);
    const refused = await uninstall(h, "--yes");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not uninstalled while work is in flight");
    expect(refused.stderr).toContain("a Codex turn on thread a1b2c3d4");
    expect(refused.stderr).toContain("codex-collab kill a1b2c3d4");
    expect(refused.stderr).not.toContain("e5f6a7b8");
    expect(existsSync(h.dataDir)).toBe(true);
    expect(existsSync(join(h.home, ".local", "bin", "codex-collab"))).toBe(true);
    expect(readFileSync(join(h.codexHome, "hooks.json"), "utf-8")).toContain("codex-collab");
    // Once its runner has gone, the turn holds nothing up.
    runner.kill("SIGKILL");
    await runner.exited;
    expect((await uninstall(h, "--yes")).code).toBe(0);
    expect(existsSync(join(h.home, ".claude", "skills", "codex-collab"))).toBe(false);
  });

  linuxOnly("never signals a process it cannot check, and is held up by it", async () => {
    const h = makeHome();
    install(h);
    const receiver = Bun.spawn(["sleep", "60"]);
    children.push(receiver);
    mkdirSync(join(h.workspace, "tasks"), { recursive: true });
    const now = new Date();
    // Its pid is another pid namespace's: here it names something else.
    writeTask(h.workspace, {
      id: "0000abce", status: "running", cwd: h.root, threadId: null, message: "a job",
      target: { name: "claude(ws-abcdef)", pid: 1, socketPath: join(h.root, "s.sock"), sessionId: null, procStart: null, spawned: null },
      createdAt: now.toISOString(), deliveredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      receiver: { pid: receiver.pid, procStart: null, pidDomain: "linux:another-machine:pid:[4026531836]" },
    } as TaskRecord);
    const refused = await uninstall(h, "--yes");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("runs where this command cannot check it");
    expect(receiver.exitCode).toBeNull();
    expect(existsSync(h.dataDir)).toBe(true);
  });

  unixOnly("stops a task's wait, a reaper and the channel host before it removes anything", async () => {
    const h = makeHome();
    install(h);
    // Each is known by its record and by the command it runs.
    const receiver = Bun.spawn(["sh", "-c", "sleep 60; true", "recv-task"]);
    const reaper = Bun.spawn(["sh", "-c", "sleep 60; true", "reap-claude", "cafe0001"]);
    const host = Bun.spawn(["sh", "-c", "sleep 60; true", "channel-host"]);
    // A process that only has a reaper's log name, or the pid a crashed
    // receiver's record still names, is left alone.
    const stranger = Bun.spawn(["sleep", "60"]);
    const reused = Bun.spawn(["sleep", "60"]);
    children.push(receiver, reaper, host, stranger, reused);
    mkdirSync(join(h.workspace, "tasks"), { recursive: true });
    const now = new Date();
    writeTask(h.workspace, {
      id: "0000abcd", status: "running", cwd: h.root, threadId: null, message: "a job",
      target: { name: "claude(ws-abcdef)", pid: 1, socketPath: join(h.root, "s.sock"), sessionId: null, procStart: null, spawned: null },
      createdAt: now.toISOString(), deliveredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      receiver: { pid: receiver.pid, procStart: null, pidDomain: null },
    } as TaskRecord);
    writeTask(h.workspace, {
      id: "0000abcf", status: "running", cwd: h.root, threadId: null, message: "another job",
      target: { name: "claude(ws-fedcba)", pid: 1, socketPath: join(h.root, "s2.sock"), sessionId: null, procStart: null, spawned: null },
      createdAt: now.toISOString(), deliveredAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      receiver: { pid: reused.pid, procStart: null, pidDomain: null },
    } as TaskRecord);
    mkdirSync(join(h.workspace, "reapers"), { recursive: true });
    writeFileSync(join(h.workspace, "reapers", `cafe0001-${reaper.pid}.log`), "watching\n");
    writeFileSync(join(h.workspace, "reapers", `cafe0002-${stranger.pid}.log`), "watching\n");
    mkdirSync(join(h.workspace, "channels"), { recursive: true });
    writeFileSync(join(h.workspace, "channels", "host.json"), JSON.stringify({ pid: host.pid, procStart: null, pidDomain: null, control: join(h.root, "host.sock"), startedAt: now.toISOString() }));

    const shown = await plan(h);
    expect(shown).toContain("codex-collab uninstall stops:");
    expect(shown).toContain("the wait for claude(ws-abcdef)'s reply to task 0000abcd");
    expect(shown).toContain("a reply that comes later goes nowhere");
    expect(shown).toContain(`the reaper of session cafe0001 (workspace ws-0123456789abcdef, pid ${reaper.pid})`);
    expect(shown).not.toContain("cafe0002");
    expect(shown).not.toContain("0000abcf");
    expect(shown).toContain(`the channel host for workspace ws-0123456789abcdef (pid ${host.pid})`);

    const done = await uninstall(h, "--yes");
    expect(done.code).toBe(0);
    const out = done.stdout;
    // Waits first, the reaper next, the host after them; removal last.
    const order = ["Stopped the wait for", "Stopped the reaper", "Stopped the channel host", "Removed"].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const p of [receiver, reaper, host]) expect(await Promise.race([p.exited.then(() => true), Bun.sleep(5000).then(() => false)])).toBe(true);
    for (const p of [stranger, reused]) expect(p.exitCode).toBeNull();
    expect(existsSync(join(h.home, ".claude", "skills", "codex-collab"))).toBe(false);
  });
});
