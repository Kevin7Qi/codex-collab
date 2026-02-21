// CLI invocation tests — spawn bun to exercise argument parsing and commands

import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { spawnSync } from "child_process";

setDefaultTimeout(10_000);

const CLI = "src/cli.ts";

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", ["run", CLI, ...args], {
    encoding: "utf-8",
    cwd: import.meta.dir + "/..",
    stdio: ["pipe", "pipe", "pipe"],
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
    // May fail if codex not installed, but should not crash with unhandled exception
    const { exitCode } = run("health");
    expect([0, 1]).toContain(exitCode);
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

  it("run without prompt exits 1", () => {
    const { exitCode } = run("run");
    expect(exitCode).toBe(1);
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
