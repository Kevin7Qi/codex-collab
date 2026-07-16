// src/update.ts — release checking and update notices
//
// Two staleness signals, both surfaced as one-line stderr notices and never
// acted on automatically:
//   - local drift: the installed SKILL.md no longer matches what this binary
//     would generate (binary upgraded, or templates added/removed)
//   - upstream drift: a newer GitHub release exists
// The remote check is throttled to once per day, fails silently offline, and
// can be disabled entirely with CODEX_COLLAB_NO_UPDATE_CHECK=1.

import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { config } from "./config";
import { skillInSync } from "./skill";
import pkg from "../package.json";

/** "owner/repo" parsed from package.json's repository URL. */
export const REPO_SLUG: string = (() => {
  const url = typeof pkg.repository === "object" ? pkg.repository.url : String(pkg.repository ?? "");
  const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : "Kevin7Qi/codex-collab";
})();

export const REMOTE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateState {
  /** ISO timestamp of the last remote release check (attempted, not necessarily successful). */
  lastRemoteCheck?: string;
  /** ISO timestamp of the last SUCCESSFUL check (fetch completed, including a
   *  definitive "no releases"). lastRemoteCheck throttles attempts; this one
   *  vouches that latestVersion/latestUrl reflect a completed answer. */
  lastSuccessAt?: string;
  /** Latest release version seen on GitHub (no leading "v"). */
  latestVersion?: string;
  /** Release page URL for latestVersion. */
  latestUrl?: string;
  /** Version muted via `update --skip` — notices stay quiet up to and including it. */
  mutedVersion?: string;
}

export function updateStateFile(): string {
  return join(config.dataDir, "update-check.json");
}

export function loadUpdateState(file: string = updateStateFile()): UpdateState {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as UpdateState;
  } catch {
    return {};
  }
}

export function saveUpdateState(state: UpdateState, file: string = updateStateFile()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Numeric dotted-version compare ("v" prefix tolerated): -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, "").split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export interface ReleaseInfo {
  version: string; // "0.3.0"
  tag: string; // "v0.3.0"
  notes: string; // release body (markdown)
  url: string; // release page
}

/** Latest GitHub release, or null when the repo has no releases yet.
 *  Throws on network failure or non-404 API errors. */
export async function fetchLatestRelease(timeoutMs = 10_000): Promise<ReleaseInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": config.clientName },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${REPO_SLUG} releases`);
  const data = (await res.json()) as { tag_name?: string; body?: string; html_url?: string };
  if (!data.tag_name) return null;
  return {
    tag: data.tag_name,
    version: data.tag_name.replace(/^v/i, ""),
    notes: (data.body ?? "").trim(),
    url: data.html_url ?? `https://github.com/${REPO_SLUG}/releases`,
  };
}

/** True iff a known release is newer than `current` and not muted. Muting a
 *  version silences everything up to and including it; a later release
 *  notifies again. */
export function shouldNotifyRelease(current: string, state: UpdateState): boolean {
  if (!state.latestVersion) return false;
  if (compareVersions(state.latestVersion, current) <= 0) return false;
  if (state.mutedVersion && compareVersions(state.latestVersion, state.mutedVersion) <= 0) return false;
  return true;
}

/** Print staleness notices to stderr (called from heavyweight commands only).
 *  Detection only — nothing is ever downloaded or written to the skill dir
 *  here; both notices point at an explicit command. Fails silent throughout:
 *  a staleness check must never break or delay a real command.
 *
 *  `allowRemoteFetch=false` skips starting the background release fetch (and
 *  leaves the throttle stamp untouched so a later command still fetches):
 *  a pending fetch keeps the event loop alive up to its timeout, which would
 *  stall the exit of short-lived commands like `health` when offline.
 *  Notices always print from cached state either way. */
export async function maybeNotifyUpdates(allowRemoteFetch = true): Promise<void> {
  if (process.env.CODEX_COLLAB_NO_UPDATE_CHECK) return;

  try {
    if (skillInSync() === false) {
      console.error(
        "[codex-collab] Installed skill file is out of date — run 'codex-collab skill sync' to review and apply the update.",
      );
    }
  } catch {
    // never let a staleness check break a real command
  }

  try {
    const file = updateStateFile();
    const state = loadUpdateState(file);
    const last = state.lastRemoteCheck ? Date.parse(state.lastRemoteCheck) : NaN;
    if (allowRemoteFetch && (Number.isNaN(last) || Date.now() - last > REMOTE_CHECK_INTERVAL_MS)) {
      // Stamp and persist the attempt BEFORE fetching so an offline machine
      // retries daily instead of on every command, then fetch WITHOUT
      // awaiting: command startup must never wait on the network. The result
      // lands in the cache for the next command's notice; run/review live
      // long enough for it to complete, quick commands may cut it short.
      state.lastRemoteCheck = new Date().toISOString();
      saveUpdateState(state, file);
      void fetchLatestRelease(2_500)
        .then((release) => {
          // Reload rather than reuse: don't clobber state written since
          // (e.g. an `update --skip` racing this background fetch).
          const fresh = loadUpdateState(file);
          fresh.lastSuccessAt = new Date().toISOString();
          if (release) {
            fresh.latestVersion = release.version;
            fresh.latestUrl = release.url;
          } else {
            // Definitive "no releases": a cached one was withdrawn — stop
            // advertising a version that update can no longer install.
            delete fresh.latestVersion;
            delete fresh.latestUrl;
          }
          saveUpdateState(fresh, file);
        })
        .catch(() => {
          // offline or rate-limited — try again next interval
        });
    }
    if (shouldNotifyRelease(config.clientVersion, state)) {
      console.error(
        `[codex-collab] Update available: ${config.clientVersion} → ${state.latestVersion} — run 'codex-collab update' to review and install (or 'codex-collab update --skip' to mute this version).`,
      );
    }
  } catch {
    // state dir unwritable (e.g. sandboxed) — skip quietly
  }
}
