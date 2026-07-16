// src/commands/update.ts — skill sync/render and self-update command handlers
//
// Consent model: every write here (the installed SKILL.md, the skill bundle
// itself) happens only behind --yes or an interactive y/N. A non-interactive
// invocation without --yes prints exactly what would change and exits 1 —
// that invocation IS the "show me first" step for an agent-driven session.

import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { config } from "../config";
import { acquireLockSync } from "../lock";
import {
  expectedSkillMd,
  installedSkillMd,
  skillInstallDir,
  unifiedDiff,
} from "../skill";
import {
  REMOTE_CHECK_INTERVAL_MS,
  REPO_SLUG,
  type ReleaseInfo,
  compareVersions,
  fetchLatestRelease,
  loadUpdateState,
  releaseDownloadBase,
  saveUpdateState,
  updateStateFile,
} from "../update";
import { die, parseOptions } from "./shared";

/** Gate a write on explicit consent: --yes, or an interactive y/N prompt.
 *  Exits 1 otherwise — after the caller has already printed what would change. */
function requireConsent(yes: boolean, question: string, nonInteractiveHint: string): void {
  if (yes) return;
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // Bun's confirm() appends its own " [y/N] " — don't add one to the message.
    if (confirm(question)) return;
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

  // Exactly one positional: a trailing token here is a mistake worth failing
  // on — notably `--yes=false`, which parseOptions expands into `--yes` (set!)
  // plus a stray "false" positional; silently ignoring it would treat an
  // explicitly withheld consent as granted.
  if (positional.length > 1) {
    die(`Unexpected argument: ${positional[1]}\nUsage: codex-collab skill <sync|render> [--yes]`);
  }

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
  // Up-to-date is content equality (same normalization as the drift notice),
  // NOT diff emptiness: a drift in line endings or the end-of-file newline
  // produces an empty line diff, and deciding by the diff would leave the
  // staleness notice firing forever with sync claiming nothing to do.
  const normalize = (s: string) => s.replace(/\r\n/g, "\n");
  if (installed !== null && normalize(installed) === normalize(expected)) {
    console.log("Installed SKILL.md is already up to date.");
    return;
  }
  const diff =
    unifiedDiff(installed ?? "", expected, "SKILL.md (installed)", "SKILL.md (regenerated)") ||
    "(no visible line changes — line-ending or end-of-file whitespace difference)";

  console.log(diff);
  console.log("");
  requireConsent(
    options.yes,
    "Apply these changes to the installed SKILL.md?",
    "Review the diff above with the user, then re-run 'codex-collab skill sync --yes' to apply.",
  );
  // Serialize with self-update: an installer running concurrently replaces
  // the whole skill dir, so an unguarded sync could fail its rename mid-swap
  // or overwrite the freshly installed SKILL.md with stale content. Every
  // released binary that has `skill sync` also takes this lock.
  mkdirSync(config.dataDir, { recursive: true });
  let releaseLock: () => void;
  try {
    releaseLock = acquireLockSync(join(config.dataDir, "update.lock"), {
      maxAttempts: 2,
      staleThresholdMs: 15 * 60_000,
    });
  } catch {
    die("A codex-collab update is in progress — retry 'skill sync' after it finishes.");
  }
  try {
    // Revalidate under the lock: the diff above may predate an interactive
    // wait at the consent prompt, during which another sync or an update
    // can have replaced the file — writing the stale plan would overwrite
    // newer content (throw, not die: the lock must release via finally).
    if (installedSkillMd(dir) !== installed) {
      throw new Error(
        "The installed SKILL.md changed while waiting for confirmation — re-run 'codex-collab skill sync' to review the current diff.",
      );
    }
    // Write-then-rename: a straight write truncates first, so a failure
    // mid-write (disk full) would leave the installed skill broken.
    const target = join(dir, "SKILL.md");
    const tmp = join(dir, `.SKILL.md.tmp-${process.pid}`);
    try {
      writeFileSync(tmp, expected);
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    console.log(`Updated ${target} — takes effect in new Claude Code sessions.`);
  } finally {
    releaseLock();
  }
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
  // Cache what we learned — including the check timestamps, so the passive
  // path doesn't immediately re-fetch what this command just fetched.
  const stampNow = new Date().toISOString();
  if (!release) {
    // A previously cached release may have been withdrawn — clear it so
    // passive notices stop advertising a version update can't install.
    try {
      const state = loadUpdateState();
      state.lastRemoteCheck = stampNow;
      state.lastSuccessAt = stampNow;
      delete state.latestVersion;
      delete state.latestUrl;
      saveUpdateState(state);
    } catch {
      // cache only — not worth failing the command over
    }
    console.log(`No releases published yet at https://github.com/${REPO_SLUG}/releases.`);
    return;
  }

  try {
    const state = loadUpdateState();
    state.lastRemoteCheck = stampNow;
    state.lastSuccessAt = stampNow;
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

  // The installers hard-code the default skill dir; under the override the
  // before/after checks would read one copy while the installer writes
  // another — "success" against the wrong installation. (--check and --skip
  // never install, so they stay usable with the override.)
  if (process.env.CODEX_COLLAB_SKILL_DIR) {
    die("CODEX_COLLAB_SKILL_DIR is set, but self-update always installs to the default location — unset it, or update manually with the installer.");
  }

  // Dev installs are a working repo — updating over git preserves local work.
  if (isDevInstall()) {
    die("This is a dev install (symlinked into a working repo). Update with git in that repo, then re-run ./install.sh --dev.");
  }

  requireConsent(
    options.yes,
    `Download ${release.tag}, build, and reinstall now?`,
    "Confirm with the user, then re-run 'codex-collab update --yes'.",
  );

  // Serialize installs: two concurrent updates would clobber each other's
  // work dir and interleave installer copies into the live skill dir. Fail
  // fast on contention; a crashed holder goes stale after 15 minutes.
  // maxAttempts 2, not 1: breaking a stale lock happens AFTER an attempt's
  // open, so the retry is what acquires the freed lock in the same
  // invocation instead of just cleaning up and reporting contention.
  mkdirSync(config.dataDir, { recursive: true });
  let releaseLock: () => void;
  try {
    releaseLock = acquireLockSync(join(config.dataDir, "update.lock"), {
      maxAttempts: 2,
      staleThresholdMs: 15 * 60_000,
    });
  } catch {
    die("Another codex-collab update appears to be in progress — wait for it to finish and retry (a crashed update unlocks itself after 15 minutes).");
  }
  try {
    // Revalidate under the lock: this process may have sat at the consent
    // prompt while another updater installed a newer release — proceeding
    // would downgrade it to the tag fetched before the prompt.
    const installedNow = installedBinaryVersion();
    if (installedNow && compareVersions(installedNow, release.version) >= 0) {
      console.log(`Another process already updated to ${installedNow} — nothing to do.`);
      return;
    }
    await downloadAndInstall(release);
  } finally {
    releaseLock();
  }
}

/** Version reported by the INSTALLED binary (not this process — after a
 *  concurrent update they differ). Null when it can't be determined; callers
 *  fail open, which just means no better than today's behavior. */
function installedBinaryVersion(): string | null {
  try {
    const bin = join(skillInstallDir(), "scripts", "codex-collab");
    if (!existsSync(bin)) return null;
    const r = spawnSync("bun", [bin, "version"], { encoding: "utf-8", timeout: 15_000 });
    const match = (r.stdout ?? "").match(/codex-collab\s+(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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

  // Refresh unless the cache is fresh: --skip mutes the CURRENT latest
  // release, and an old cache may predate a newer one. Freshness comes from
  // lastSuccessAt, NOT lastRemoteCheck — the latter stamps attempts (it is
  // written before the passive fetch even resolves), so it can be recent
  // while latestVersion is days old. If GitHub is unreachable but a cached
  // release exists, mute that and say so — a user acting on a just-seen
  // notice shouldn't be blocked by being offline.
  const last = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : NaN;
  const cacheFresh = !Number.isNaN(last) && Date.now() - last <= REMOTE_CHECK_INTERVAL_MS;
  if (!latest || !cacheFresh) {
    let release: ReleaseInfo | null = null;
    let fetchError: string | null = null;
    try {
      release = await fetchLatestRelease();
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }
    if (fetchError === null) {
      state.lastRemoteCheck = new Date().toISOString();
      state.lastSuccessAt = state.lastRemoteCheck;
      if (!release) {
        delete state.latestVersion;
        delete state.latestUrl;
        saveUpdateState(state, stateFile);
        die("No releases published yet — nothing to skip.");
      }
      latest = release.version;
      state.latestVersion = latest;
      state.latestUrl = release.url;
    } else if (latest) {
      console.error(`[codex-collab] Could not reach GitHub (${fetchError}) — muting the last known release ${latest} instead.`);
    } else {
      die(`Could not check for updates: ${fetchError}`);
    }
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
 *  installer, and report the SKILL.md delta the update applied.
 *  Failures THROW (never die/process.exit): the caller holds the update
 *  lock and its finally must run, and process.exit would skip it. */
async function downloadAndInstall(release: ReleaseInfo): Promise<void> {
  let workDir = join(config.dataDir, "updates", release.tag);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // A leftover dir can be held open on Windows (see the cleanup note
    // below) — fall back to a unique sibling rather than failing the update.
    workDir = `${workDir}-${process.pid}`;
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });
  const tarball = join(workDir, "source.tar.gz");
  const url = `${releaseDownloadBase()}/${REPO_SLUG}/archive/refs/tags/${release.tag}.tar.gz`;

  console.log(`Downloading ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": config.clientName },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));

  const tar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", workDir], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (tar.exitCode !== 0) throw new Error("Could not extract the release tarball (is 'tar' on PATH?).");
  const extracted = readdirSync(workDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (extracted.length !== 1) throw new Error(`Unexpected tarball layout under ${workDir}`);
  const srcDir = join(workDir, extracted[0].name);

  const before = installedSkillMd() ?? "";

  console.log(`\nRunning the ${release.tag} installer...\n`);
  const installer =
    process.platform === "win32"
      ? ["powershell", "-ExecutionPolicy", "Bypass", "-File", join(srcDir, "install.ps1")]
      : ["bash", join(srcDir, "install.sh")];
  // cwd must be OUTSIDE workDir: the installer scripts resolve their own
  // location from $0/$MyInvocation (cwd-independent), but their final health
  // check spawns a detached broker that INHERITS this cwd — and Windows
  // refuses to rm a directory that is a live process's cwd (EBUSY), which
  // failed the whole update after a successful install.
  const run = Bun.spawnSync(installer, { cwd: homedir(), stdout: "inherit", stderr: "inherit" });
  if (run.exitCode !== 0) {
    throw new Error(`Installer exited with code ${run.exitCode} — the previous install may still be in place.`);
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

  // Best-effort cleanup — a failure here must never fail a COMPLETED update
  // (this fired as a fatal EBUSY on Windows when a lingering process held
  // the dir, reporting failure after a successful install).
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (e) {
    console.error(
      `Note: could not remove the update work dir (${e instanceof Error ? e.message : String(e)}) — safe to delete later: ${workDir}`,
    );
  }

  // No broker sweep here: killing brokers races commands that connected but
  // haven't recorded a run yet. Instead, brokers carry the version that
  // spawned them (BrokerState.version) and NEW clients bypass mismatched
  // brokers with a direct connection — unfed, an old broker's idle timeout
  // retires it while any in-flight turn finishes undisturbed.
  console.log(
    "\nBrokers from the previous version are bypassed from now on and retire on idle; in-flight runs finish undisturbed.",
  );
  console.log(`Updated to ${release.version}. New Claude Code sessions pick up the new skill automatically.`);
}
