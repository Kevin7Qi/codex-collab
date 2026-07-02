// CLI invocation tests — spawn bun to exercise argument parsing and commands

import { describe, it, expect, setDefaultTimeout, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pkg from "../package.json";

setDefaultTimeout(10_000);

const CLI = "src/cli.ts";

// Isolated HOME so commands that spawn a broker (e.g. `health`) never touch the
// real ~/.codex-collab, plus a short broker idle timeout so any detached broker
// self-exits in seconds instead of lingering for 30 min and orphaning across runs.
const TEST_HOME = mkdtempSync(join(tmpdir(), "codex-collab-cli-home-"));

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf-8",
    cwd: import.meta.dir + "/..",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5000,
    env: { ...process.env, HOME: TEST_HOME, CODEX_COLLAB_BROKER_IDLE_TIMEOUT_MS: "5000" },
  });
  return {
    stdout: (result.stdout ?? "") as string,
    stderr: (result.stderr ?? "") as string,
    exitCode: result.status ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Valid commands
// ---------------------------------------------------------------------------

describe("CLI version", () => {
  const expected = `codex-collab ${pkg.version}`;

  it("--version prints version and exits 0", () => {
    const { stdout, exitCode } = run("--version");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(expected);
  });

  it("-v prints version and exits 0", () => {
    const { stdout, exitCode } = run("-v");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(expected);
  });

  it("version command prints version and exits 0", () => {
    const { stdout, exitCode } = run("version");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(expected);
  });

  it("-v after a command is an unknown option, not a silent version no-op", () => {
    // Regression: `run "prompt" -v` used to print the version and exit 0
    // without running anything — dangerous in scripts expecting the run.
    const { stderr, exitCode } = run("run", "test prompt", "-v");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown option: -v");
  });
});

describe("CLI valid commands", () => {
  it("--help prints usage and exits 0", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("codex-collab");
    expect(stdout).toContain("Usage:");
  });

  it("no args prints help and exits 0", () => {
    const { stdout, exitCode } = run();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("health command runs without crashing", () => {
    // May fail if codex not installed, but should not crash with unhandled exception.
    // Exit code 143 = SIGTERM during app-server cleanup (our signal handler).
    const { exitCode } = run("health");
    expect([0, 1, 143]).toContain(exitCode);
  });
});

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

describe("CLI flag parsing", () => {
  it("--all does not error", () => {
    // Use 'health' instead of 'run' to avoid starting app server (hangs if codex installed)
    const { stderr } = run("health", "--all");
    expect(stderr).not.toContain("Unknown option");
  });

  it("--content-only does not error", () => {
    // Use 'health' instead of 'run' to avoid starting app server (hangs if codex installed)
    const { stderr } = run("health", "--content-only");
    expect(stderr).not.toContain("Unknown option");
  });
});

// ---------------------------------------------------------------------------
// Invalid inputs
// ---------------------------------------------------------------------------

describe("CLI invalid inputs", () => {
  it("unknown command exits 1", () => {
    const { stderr, exitCode } = run("nonexistent");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  it("invalid reasoning level exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--reasoning", "invalid");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid reasoning level");
  });

  it("invalid sandbox mode exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--sandbox", "invalid");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid sandbox mode");
  });

  it("run without prompt exits with error message", () => {
    const { stderr, exitCode } = run("run");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No prompt provided");
  });

  it("unknown option exits 1", () => {
    const { stderr, exitCode } = run("--bogus");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown option");
  });

  it("--model without value exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--model");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--model requires a value");
  });

  it("--model with shell metacharacters exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--model", "foo;rm -rf /");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid model name");
  });

  it("--reasoning without value exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--reasoning");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--reasoning requires a value");
  });

  it("--dir without value exits 1", () => {
    const { stderr, exitCode } = run("run", "test", "--dir");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--dir requires a value");
  });
});

// ---------------------------------------------------------------------------
// Global options placed before the command
// ---------------------------------------------------------------------------

describe("CLI global options before command", () => {
  // Pre-scan regression: with a naive `break on first flag`, args like
  // `codex-collab --dir /repo run "…"` were misread as a bare flag invocation
  // and rejected with "Unknown option". The pre-scan now skips known value-
  // flag/value pairs (and known boolean flags) when locating the command, so
  // these legacy invocation forms still route to the right subcommand.

  it("--dir <value> before health does not report Unknown option", () => {
    // 'health' is the only command we can safely run without spawning an
    // app-server; it exercises the routing path without side effects.
    const { stderr } = run("--dir", import.meta.dir + "/..", "health");
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain("Unknown command");
  });

  it("--content-only (boolean) before health does not report Unknown option", () => {
    const { stderr } = run("--content-only", "health");
    expect(stderr).not.toContain("Unknown option");
    expect(stderr).not.toContain("Unknown command");
  });

  it("bare known value-flag with no command falls through to help without unknown-option error", () => {
    // `codex-collab --dir /tmp` (no subcommand) should not say "Unknown
    // option: --dir" — --dir is known; the user just didn't supply a command.
    const { stderr, stdout, exitCode } = run("--dir", "/tmp");
    expect(stderr).not.toContain("Unknown option");
    // Either help is printed (exit 0) or another command-missing path fires
    // (exit 1) — both are acceptable; what's NOT acceptable is misclassifying
    // --dir as unknown.
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) expect(stdout).toContain("Usage:");
  });

  it("pre-command flags are forwarded to the command's parseOptions", () => {
    // Without preserving pre-command args, `--reasoning invalid` would be
    // silently discarded and the command would run with default reasoning.
    // parseOptions rejects "invalid" with a specific error, so observing that
    // error proves the flag actually made it through.
    const { stderr, exitCode } = run("--reasoning", "invalid", "run", "prompt");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid reasoning level");
  });
});
