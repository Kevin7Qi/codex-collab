import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startFakeServer } from "./server";
import { configureTools, createFixture } from "./setup";

const args = process.argv.slice(2);
const names = args.filter(arg => !arg.startsWith("-"));
const flags = args.filter(arg => arg.startsWith("-"));
const install = flags.includes("--install");
if (names.length > 1 || flags.some(flag => !["--install", "--keep"].includes(flag))) {
  console.error("Usage: bun run test:fake-models [scenario] [--install] [--keep]");
  process.exit(2);
}

let home: string | undefined;
let succeeded = false;
const server = startFakeServer(data => {
  if (home) appendFileSync(join(home, "model.jsonl"), JSON.stringify(data) + "\n");
});
let worker: ReturnType<typeof Bun.spawn> | undefined;
const stop = (signal: NodeJS.Signals) => worker?.kill(signal);

async function removeProfile(path: string) {
  // The app-server can still be closing SQLite files after the broker socket closes.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (attempt === 3 || (code !== "EBUSY" && code !== "EPERM")) {
        throw new Error(`Could not remove fixture profile ${path}`, { cause: error });
      }
      await Bun.sleep(600);
    }
  }
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  const fixture = createFixture(server.port!);
  home = fixture.home;
  console.log(`Fixture: ${home}`);
  await configureTools(fixture.env, install);
  worker = Bun.spawn([process.execPath, join(import.meta.dir, "scenarios.ts"), ...names], {
    cwd: fixture.workspace,
    env: { ...fixture.env, CODEX_COLLAB_FIXTURE_PINNED: install ? "1" : "0" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  succeeded = await worker.exited === 0;
} catch (error) {
  console.error(error);
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await server.stop(true);
  if (home) {
    if (succeeded && !args.includes("--keep")) await removeProfile(home);
    else console.log(`Fixture logs retained in ${home}`);
  }
}
process.exitCode = succeeded ? 0 : 1;
