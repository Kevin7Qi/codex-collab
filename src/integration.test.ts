// src/integration.test.ts — CLI integration smoke tests
//
// These tests spawn `bun run src/cli.ts` as a subprocess and verify exit codes
// and output. They do NOT require a running codex app-server — they only test
// commands that work offline (help, threads, health prerequisites, etc.).
//
// The live-server integration tests (connect, thread/start) are gated behind
// RUN_INTEGRATION=1 and require codex CLI on PATH + valid credentials.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, "cli.ts");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env?: Record<string, string>): RunResult {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    // Short broker idle timeout so any detached broker self-exits in seconds
    // instead of lingering for 30 min. HOME stays opt-in per caller so the
    // gated live test keeps the real ~/.codex auth.
    env: { ...process.env, CODEX_COLLAB_BROKER_IDLE_TIMEOUT_MS: "5000", ...env },
    timeout: 10_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

// Use an isolated data directory so tests don't pollute the user's real data
const TEST_DATA_DIR = join(tmpdir(), `codex-collab-integ-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DATA_DIR)) {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Offline CLI tests (no app-server required)
// ---------------------------------------------------------------------------

describe("CLI help", () => {
  test("--help prints usage and exits 0", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("codex-collab");
    expect(r.stdout).toContain("Usage:");
  });

  test("-h prints usage and exits 0", () => {
    const r = runCli(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("no args prints usage and exits 0", () => {
    const r = runCli([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("help text mentions 'threads' (not 'jobs') as primary command", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("threads");
    // The help should use 'threads' as the command name, not 'jobs'
    expect(r.stdout).not.toMatch(/^\s+jobs\b/m);
  });
});

describe("unknown commands", () => {
  test("unknown command prints error and exits 1", () => {
    const r = runCli(["nonexistent"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: nonexistent");
    expect(r.stderr).toContain("--help");
  });

  test("unknown flag prints error and exits 1", () => {
    const r = runCli(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown option");
  });
});

describe("threads command", () => {
  test("threads with no data returns empty output", () => {
    // Use isolated HOME to avoid reading user's real threads
    const r = runCli(["threads"], { HOME: TEST_DATA_DIR });
    // Should exit 0 (empty list is fine)
    expect(r.exitCode).toBe(0);
  });

  test("threads --json returns valid JSON array", () => {
    const r = runCli(["threads", "--json"], { HOME: TEST_DATA_DIR });
    expect(r.exitCode).toBe(0);
    // Even with no threads, JSON output should be parseable
    const trimmed = r.stdout.trim();
    if (trimmed) {
      expect(() => JSON.parse(trimmed)).not.toThrow();
    }
  });
});

describe("jobs deprecation", () => {
  test("jobs prints deprecation warning but still works", () => {
    const r = runCli(["jobs"], { HOME: TEST_DATA_DIR });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("deprecated");
    expect(r.stderr).toContain("threads");
  });

  test("jobs --json prints deprecation warning and returns valid output", () => {
    const r = runCli(["jobs", "--json"], { HOME: TEST_DATA_DIR });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("deprecated");
  });
});

describe("health command", () => {
  test("health is a recognized command (does not print 'Unknown command')", () => {
    // health spawns an app-server which may hang without credentials,
    // so we only verify the command is recognized — not that it completes.
    // Full end-to-end health check is in the live integration suite below.
    const result = Bun.spawnSync(["bun", "run", CLI, "health"], {
      // Isolated HOME so this never spawns a broker in the real ~/.codex-collab,
      // and a short idle timeout so that broker self-exits in seconds.
      env: { ...process.env, HOME: TEST_DATA_DIR, CODEX_COLLAB_BROKER_IDLE_TIMEOUT_MS: "5000" },
      timeout: 3_000,
    });
    const combined = result.stdout.toString() + result.stderr.toString();
    // Should NOT be "Unknown command" — that would mean the router rejected it
    expect(combined).not.toContain("Unknown command");
  });
});

// ---------------------------------------------------------------------------
// Live integration tests (gated behind RUN_INTEGRATION=1)
// ---------------------------------------------------------------------------

const runIntegration =
  process.env.RUN_INTEGRATION === "1" &&
  Bun.spawnSync([process.platform === "win32" ? "where" : "which", "codex"]).exitCode === 0;

describe.skipIf(!runIntegration)("live integration", () => {
  // Import connect lazily so the module isn't loaded when tests are skipped
  let connect: typeof import("./client").connectDirect;

  beforeAll(async () => {
    const mod = await import("./client");
    connect = mod.connectDirect;
  });

  test("connect and list models", async () => {
    const client = await connect();
    try {
      const resp = await client.request<{ data: Array<{ id: string }> }>("model/list", {});
      expect(resp.data.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("start thread and read it back", async () => {
    const client = await connect();
    try {
      const startResp = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: process.cwd(),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      expect(startResp.thread.id).toBeTruthy();

      // Verify we can read the thread back from the same connection
      const readResp = await client.request<{ thread: { id: string } }>("thread/read", {
        threadId: startResp.thread.id,
        includeTurns: false,
      });
      expect(readResp.thread.id).toBe(startResp.thread.id);

      // Cleanup: archive the thread (may fail if not yet persisted; that's OK)
      try {
        await client.request("thread/archive", { threadId: startResp.thread.id });
      } catch {
        // Not yet persisted to global store — acceptable
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  test("health command succeeds end-to-end", () => {
    const r = runCli(["health"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Health check passed");
  }, 30_000);
});

describe("peek command", () => {
  test("peek with no id prints usage and exits 1", () => {
    const r = runCli(["peek"], { HOME: TEST_DATA_DIR });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).toContain("peek");
  });

  test("peek with invalid id prints error and exits 1", () => {
    const r = runCli(["peek", "bad/id"], { HOME: TEST_DATA_DIR });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid ID");
  });
});

describe("CLI help mentions peek", () => {
  test("--help lists peek command", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("peek");
  });

  test("--help lists --full option", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--full");
  });
});
