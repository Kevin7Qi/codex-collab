// End-to-end test of `codex-collab update` against a local mock of the
// GitHub release API and tag tarball. Exercises the REAL installed binary
// and the REAL installer from a fake release staged off this repo's HEAD —
// the only way to run the download → build → reinstall path before (or
// without) a published release.
//
// Gated: slow (two full installer runs) and needs the codex CLI on PATH for
// the installer's prerequisite check. Run with:
//   RUN_UPDATE_E2E=1 bun test src/update-e2e.test.ts

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO = join(import.meta.dir, "..");
const SLUG = "Kevin7Qi/codex-collab";
const FAKE_VERSION = "9.9.9";
const FAKE_TAG = `v${FAKE_VERSION}`;

const codexPath = ((): string => {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf-8" });
  return r.status === 0 ? (r.stdout ?? "").trim().split("\n")[0].trim() : "";
})();

// POSIX-only for now: the harness drives install.sh (install.ps1 would need
// its own variant) and builds PATH with ":".
const enabled = process.env.RUN_UPDATE_E2E === "1" && codexPath !== "" && process.platform !== "win32";

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!enabled)("update E2E against a mock release host", () => {
  let stage: string;
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let tarballMode: "ok" | "error" = "ok";
  let env: Record<string, string>;
  let installedBin: string;

  beforeAll(() => {
    // Stage a fake release: this repo's committed tree with a bumped version.
    stage = mkdtempSync(join(tmpdir(), "update-e2e-stage-"));
    const relDir = join(stage, `codex-collab-${FAKE_VERSION}`);
    mkdirSync(relDir, { recursive: true });
    expect(sh(["bash", "-c", `git archive HEAD | tar -x -C '${relDir}'`], { cwd: REPO }).status).toBe(0);
    const pkgPath = join(relDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    pkg.version = FAKE_VERSION;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    expect(sh(["tar", "-czf", join(stage, "release.tar.gz"), "-C", stage, `codex-collab-${FAKE_VERSION}`]).status).toBe(0);
    const tarballBytes = readFileSync(join(stage, "release.tar.gz"));

    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === `/repos/${SLUG}/releases/latest`) {
          return Response.json({
            tag_name: FAKE_TAG,
            body: "Mock release for update E2E validation.",
            html_url: `http://127.0.0.1:${server.port}/release-page`,
          });
        }
        if (path === `/${SLUG}/archive/refs/tags/${FAKE_TAG}.tar.gz`) {
          if (tarballMode === "error") return new Response("boom", { status: 500 });
          return new Response(tarballBytes, { headers: { "content-type": "application/gzip" } });
        }
        return new Response("not found", { status: 404 });
      },
    });

    // Isolated HOME with a shimmed PATH: codex stays visible, the real
    // ~/.local/bin is hidden so the installer takes its no-codex-collab
    // fallback instead of running `health` against the real environment.
    home = mkdtempSync(join(tmpdir(), "update-e2e-home-"));
    const shimBin = join(home, "shim-bin");
    mkdirSync(shimBin, { recursive: true });
    symlinkSync(codexPath, join(shimBin, "codex"));
    const cleanPath = `${shimBin}:${(process.env.PATH ?? "")
      .split(":")
      .filter((p) => p !== `${process.env.HOME}/.local/bin`)
      .join(":")}`;
    env = {
      HOME: home,
      PATH: cleanPath,
      CODEX_COLLAB_RELEASE_API_BASE: `http://127.0.0.1:${server.port}`,
      CODEX_COLLAB_RELEASE_DL_BASE: `http://127.0.0.1:${server.port}`,
    };

    // Install the current (working-tree) version in build mode.
    const install = sh(["bash", "install.sh"], { cwd: REPO, env });
    expect(install.status).toBe(0);
    installedBin = join(home, ".claude", "skills", "codex-collab", "scripts", "codex-collab");
    expect(existsSync(installedBin)).toBe(true);
  }, 300_000);

  afterAll(() => {
    server?.stop(true);
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("failed download aborts cleanly: lock released, install intact", () => {
    const before = sh(["bun", installedBin, "version"], { env }).stdout.trim();
    tarballMode = "error";
    const r = sh(["bun", installedBin, "update", "--yes"], { env });
    tarballMode = "ok";
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Download failed");
    expect(existsSync(join(home, ".codex-collab", "update.lock"))).toBe(false);
    expect(sh(["bun", installedBin, "version"], { env }).stdout.trim()).toBe(before);
  }, 120_000);

  test("update --yes installs the mock release end to end", () => {
    const r = sh(["bun", installedBin, "update", "--yes"], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Updated to ${FAKE_VERSION}`);
    expect(r.stdout).toContain("SKILL.md"); // the delta (or unchanged) is always reported
    expect(sh(["bun", installedBin, "version"], { env }).stdout).toContain(FAKE_VERSION);
    expect(existsSync(join(home, ".codex-collab", "update.lock"))).toBe(false);
    const state = JSON.parse(readFileSync(join(home, ".codex-collab", "update-check.json"), "utf-8"));
    expect(state.latestVersion).toBe(FAKE_VERSION);
    const skillMd = readFileSync(join(home, ".claude", "skills", "codex-collab", "SKILL.md"), "utf-8");
    expect(skillMd).toContain("Staying Up to Date");
  }, 300_000);

  test("re-running update against the same release is a no-op", () => {
    const r = sh(["bun", installedBin, "update", "--yes"], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Already up to date");
  }, 120_000);
});
