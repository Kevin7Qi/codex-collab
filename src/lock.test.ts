// src/lock.test.ts — a lock held by a process that exits

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireLockSync } from "./lock";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "cc-lock-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A process that takes the lock, sets up how it ends (`then`), and says so. */
function holder(lockPath: string, then: string, opts: { releaseOnExit?: boolean } = { releaseOnExit: true }): { held: Promise<void>; exited: Promise<number | null>; kill: (signal: NodeJS.Signals) => void } {
  const script = join(root, `holder-${Math.random().toString(16).slice(2)}.ts`);
  writeFileSync(script, `import { acquireLockSync } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};
acquireLockSync(${JSON.stringify(lockPath)}, ${JSON.stringify(opts)});
${then}
console.log("held");
`);
  const child = spawn(process.execPath, ["run", script], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise<void>((resolve) => child.stdout.on("data", (d) => { if (String(d).includes("held")) resolve(); }));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { held, exited, kill: (signal) => { child.kill(signal); } };
}

describe("a lock held by a process that exits", () => {
  test("is released when the process exits with it", async () => {
    const lockPath = join(root, "exit.lock");
    const h = holder(lockPath, `setTimeout(() => process.exit(3), 100);`);
    await h.held;
    expect(existsSync(lockPath)).toBe(true);
    expect(await h.exited).toBe(3);
    expect(existsSync(lockPath)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("is released when a signal the process turns into an exit ends it, as the CLI does", async () => {
    const lockPath = join(root, "signal.lock");
    const h = holder(lockPath, `process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);`);
    await h.held;
    h.kill("SIGTERM");
    expect(await h.exited).toBe(143);
    expect(existsSync(lockPath)).toBe(false);
    // Free at once for the next process, not once it has gone stale.
    acquireLockSync(lockPath, { maxAttempts: 1 })();
  });

  test("is left where it is when it was not taken to be released on exit", async () => {
    const lockPath = join(root, "kept.lock");
    const h = holder(lockPath, `setTimeout(() => process.exit(3), 100);`, {});
    await h.held;
    expect(await h.exited).toBe(3);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a lock released before the exit is released once", () => {
    const lockPath = join(root, "once.lock");
    const release = acquireLockSync(lockPath, { releaseOnExit: true });
    release();
    // Taken again by another holder: a second release must leave it.
    const other = acquireLockSync(lockPath);
    release();
    expect(existsSync(lockPath)).toBe(true);
    other();
    expect(existsSync(lockPath)).toBe(false);
  });
});
