// scripts/ci-local.ts — run what CI runs, the way CI runs it.
//
// CI's hosts have no `claude` on PATH, so everything that adapts to Claude
// Code's presence — `skill render` and its peer-only block, the peer
// capability probe — takes the other branch there. A suite that is green
// on a developer's machine, where `claude` is installed, has not been run
// the way CI runs it. This hides `claude` (a PATH of the few tools the
// suite needs plus the system directories) and runs the typecheck and the
// full suite. Windows is not emulated: CI runs the real thing there.
//
//   bun run test:ci

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const onWindows = process.platform === "win32";

function which(name: string): string | null {
  const r = spawnSync(onWindows ? "where" : "which", [name], { encoding: "utf-8" });
  const hit = (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return r.status === 0 && hit ? hit : null;
}

let path = process.env.PATH ?? "";
let shimDir: string | null = null;
if (!onWindows) {
  shimDir = mkdtempSync(join(tmpdir(), "codex-collab-ci-"));
  for (const tool of ["bun", "node", "npm", "npx", "git", "codex"]) {
    const found = which(tool);
    if (found) symlinkSync(found, join(shimDir, tool));
  }
  path = [shimDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  if (which("claude")) console.log("claude is on PATH here; hidden for this run, as on CI.");
}

const env = { ...process.env, PATH: path, CODEX_COLLAB_NO_UPDATE_CHECK: "1" };
let failed = false;
for (const [label, args] of [["Type check", ["run", "typecheck"]], ["Run tests", ["test"]]] as const) {
  console.log(`\n== ${label}: bun ${args.join(" ")}`);
  const r = spawnSync("bun", [...args], { stdio: "inherit", env });
  if (r.status !== 0) { failed = true; break; }
}
if (shimDir) rmSync(shimDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
