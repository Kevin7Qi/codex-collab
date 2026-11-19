// src/bun-version.ts — the oldest Bun codex-collab runs on
//
// The number is package.json's `engines.bun`. Older Buns fail in ways nobody
// would trace back to Bun: no zstd for Codex's compressed thread records
// (before 1.2.14), socket paths over 104 bytes refused on macOS and a pipe
// given to `send --file` read forever (into 1.3), a test run that never
// ends (1.2.10). The installers refuse an older Bun and `health` says so;
// commands do not check, since most of them work there.

import pkg from "../package.json";

/** The oldest Bun codex-collab is tested on, as "1.2.3". */
export const MIN_BUN: string = pkg.engines.bun.replace(/^[^\d]*/, "");

export function bunTooOld(version: string = Bun.version): boolean {
  return Bun.semver.order(version, MIN_BUN) < 0;
}

/** What to tell a user on an older Bun, or null when theirs will do. */
export function bunTooOldMessage(version: string = Bun.version): string | null {
  if (!bunTooOld(version)) return null;
  return `codex-collab needs Bun ${MIN_BUN} or newer, and this is Bun ${version}. Upgrade Bun ('bun upgrade', or the way you installed it)`;
}
