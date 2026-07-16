// src/commands/update.ts — skill sync/render and self-update command handlers
//
// Consent model: every write here (the installed SKILL.md, the skill bundle
// itself) happens only behind --yes or an interactive y/N. A non-interactive
// invocation without --yes prints exactly what would change and exits 1 —
// that invocation IS the "show me first" step for an agent-driven session.

import { join } from "path";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { config } from "../config";
import {
  expectedSkillMd,
  installedSkillMd,
  skillInstallDir,
  unifiedDiff,
} from "../skill";
import {
  REPO_SLUG,
  type ReleaseInfo,
  compareVersions,
  fetchLatestRelease,
  loadUpdateState,
  saveUpdateState,
  updateStateFile,
} from "../update";
import { die, parseOptions } from "./shared";

/** Gate a write on explicit consent: --yes, or an interactive y/N prompt.
 *  Exits 1 otherwise — after the caller has already printed what would change. */
function requireConsent(yes: boolean, question: string, nonInteractiveHint: string): void {
  if (yes) return;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    if (confirm(`${question} [y/N]`)) return;
    console.error("Aborted — nothing was changed.");
    process.exit(1);
  }
  console.error(`Not applied (no --yes in a non-interactive session). ${nonInteractiveHint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// skill render | sync
// ---------------------------------------------------------------------------

export async function handleSkill(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  const sub = positional[0];

  // render: print the SKILL.md this binary generates (embedded source +
  // current template table). Pure output — the installers pipe it to a file.
  if (sub === "render") {
    process.stdout.write(expectedSkillMd());
    return;
  }

  if (sub !== "sync") {
    die(`Unknown skill subcommand: ${sub ?? "(none)"}\nUsage: codex-collab skill <sync|render> [--yes]`);
  }

  const dir = skillInstallDir();
  if (!existsSync(dir)) {
    die(`No installed skill at ${dir} — run the installer first (install.sh / install.ps1).`);
  }

  const expected = expectedSkillMd();
  const installed = installedSkillMd(dir);
  const diff = unifiedDiff(installed ?? "", expected, "SKILL.md (installed)", "SKILL.md (regenerated)");
  if (!diff) {
    console.log("Installed SKILL.md is already up to date.");
    return;
  }

  console.log(diff);
  console.log("");
  requireConsent(
    options.yes,
    "Apply these changes to the installed SKILL.md?",
    "Review the diff above with the user, then re-run 'codex-collab skill sync --yes' to apply.",
  );
  writeFileSync(join(dir, "SKILL.md"), expected);
  console.log(`Updated ${join(dir, "SKILL.md")} — takes effect in new Claude Code sessions.`);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function handleUpdate(args: string[]): Promise<void> {
  const { positional, options } = parseOptions(args);
  if (positional.length > 0) {
    die(`Unexpected argument: ${positional[0]}\nUsage: codex-collab update [--check|--skip|--yes]`);
  }

  if (options.skip) return skipLatest();

  console.log(`Current version: ${config.clientVersion}`);
  console.log(`Checking ${REPO_SLUG} for the latest release...`);
  let release: ReleaseInfo | null;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    die(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!release) {
    console.log(`No releases published yet at https://github.com/${REPO_SLUG}/releases.`);
    return;
  }

  // Cache what we learned so passive notices don't need their own fetch.
  try {
    const state = loadUpdateState();
    state.latestVersion = release.version;
    state.latestUrl = release.url;
    saveUpdateState(state);
  } catch {
    // cache only — not worth failing the command over
  }

  if (compareVersions(release.version, config.clientVersion) <= 0) {
    console.log(`Already up to date (latest release: ${release.tag}).`);
    return;
  }

  console.log(`\nUpdate available: ${config.clientVersion} → ${release.version}`);
  console.log(`Release page: ${release.url}`);
  if (release.notes) console.log(`\n${release.notes}\n`);

  if (options.check) return;

  // Dev installs are a working repo — updating over git preserves local work.
  if (isDevInstall()) {
    die("This is a dev install (symlinked into a working repo). Update with git in that repo, then re-run ./install.sh --dev.");
  }

  requireConsent(
    options.yes,
    `Download ${release.tag}, build, and reinstall now?`,
    "Confirm with the user, then re-run 'codex-collab update --yes'.",
  );

  await downloadAndInstall(release);
}

function isDevInstall(): boolean {
  try {
    return lstatSync(join(skillInstallDir(), "scripts", "codex-collab")).isSymbolicLink();
  } catch {
    return false;
  }
}

async function skipLatest(): Promise<void> {
  const stateFile = updateStateFile();
  const state = loadUpdateState(stateFile);
  let latest = state.latestVersion;
  if (!latest) {
    let release: ReleaseInfo | null;
    try {
      release = await fetchLatestRelease();
    } catch (e) {
      die(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!release) die("No releases published yet — nothing to skip.");
    latest = release.version;
    state.latestVersion = latest;
    state.latestUrl = release.url;
  }
  if (compareVersions(latest, config.clientVersion) <= 0) {
    saveUpdateState(state, stateFile);
    console.log(`Already up to date (${config.clientVersion}) — nothing to skip.`);
    return;
  }
  state.mutedVersion = latest;
  saveUpdateState(state, stateFile);
  console.log(`Muted update notices up to ${latest}. A later release will notify again.`);
}

/** Download the pinned tag tarball, build locally via the release's own
 *  installer, and report the SKILL.md delta the update applied. */
async function downloadAndInstall(release: ReleaseInfo): Promise<void> {
  const workDir = join(config.dataDir, "updates", release.tag);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const tarball = join(workDir, "source.tar.gz");
  const url = `https://github.com/${REPO_SLUG}/archive/refs/tags/${release.tag}.tar.gz`;

  console.log(`Downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": config.clientName },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) die(`Download failed: HTTP ${res.status} for ${url}`);
  writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));

  const tar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", workDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (tar.exitCode !== 0) die("Could not extract the release tarball (is 'tar' on PATH?).");
  const extracted = readdirSync(workDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (extracted.length !== 1) die(`Unexpected tarball layout under ${workDir}`);
  const srcDir = join(workDir, extracted[0].name);

  const before = installedSkillMd() ?? "";

  console.log(`\nRunning the ${release.tag} installer...\n`);
  const installer =
    process.platform === "win32"
      ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", join(srcDir, "install.ps1")]
      : ["bash", join(srcDir, "install.sh")];
  const run = Bun.spawnSync(installer, { cwd: srcDir, stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) {
    die(`Installer exited with code ${run.exitCode} — the previous install may still be in place.`);
  }

  const after = installedSkillMd() ?? "";
  const diff = unifiedDiff(
    before,
    after,
    `SKILL.md (${config.clientVersion})`,
    `SKILL.md (${release.version})`,
  );
  console.log("");
  if (diff) {
    console.log("SKILL.md changes applied by this update:\n");
    console.log(diff);
  } else {
    console.log("SKILL.md is unchanged by this update.");
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log(`\nUpdated to ${release.version}. New Claude Code sessions pick up the new skill automatically.`);
}
