// src/commands/shared.test.ts — Tests for shared CLI utilities

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  parseOptions,
  pickBestModel,
  validateGitRef,
  applyUserConfig,
  startOrResumeThread,
  turnOverrides,
  resolveApproval,
  formatDuration,
  isThreadProcessAlive,
  defaultOptions,
  VALID_REVIEW_MODES,
  type WorkspacePaths,
  type Options,
} from "./shared";
import { config } from "../config";
import type { AppServerClient } from "../client";
import type { Model, ThreadStartResponse } from "../types";

// ─── helpers ───────────────────────────────────────────────────────────────

const tmpRoot = join(process.env.TMPDIR ?? "/tmp", "shared-test-" + process.pid);

function freshTmpDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function freshWorkspace(name: string): WorkspacePaths {
  const stateDir = freshTmpDir(name);
  const ws = {
    stateDir,
    threadsFile: join(stateDir, "threads.json"),
    logsDir: join(stateDir, "logs"),
    approvalsDir: join(stateDir, "approvals"),
    killSignalsDir: join(stateDir, "kill-signals"),
    pidsDir: join(stateDir, "pids"),
    runsDir: join(stateDir, "runs"),
  };
  for (const dir of [ws.logsDir, ws.approvalsDir, ws.killSignalsDir, ws.pidsDir, ws.runsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return ws;
}

function threadStartResponse(threadId: string, cwd: string): ThreadStartResponse {
  return {
    thread: {
      id: threadId,
      preview: "",
      modelProvider: "openai",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: { type: "idle" },
      path: null,
      cwd,
      cliVersion: "0.1.0",
      source: "mock",
      name: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [],
    },
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    cwd,
    approvalPolicy: "never",
    sandbox: { type: "readOnly" },
  };
}

beforeEach(() => {
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── parseOptions ──────────────────────────────────────────────────────────

describe("parseOptions", () => {
  // -- model ---

  test("--model sets model and marks explicit", () => {
    const { options } = parseOptions(["--model", "o4-mini"]);
    expect(options.model).toBe("o4-mini");
    expect(options.explicit.has("model")).toBe(true);
  });

  test("-m shorthand works", () => {
    const { options } = parseOptions(["-m", "gpt-5"]);
    expect(options.model).toBe("gpt-5");
    expect(options.explicit.has("model")).toBe(true);
  });

  test("--model resolves aliases (e.g., spark)", () => {
    const { options } = parseOptions(["--model", "spark"]);
    expect(options.model).toBe("gpt-5.3-codex-spark");
  });

  test("--model allows dots, dashes, slashes, colons", () => {
    const { options } = parseOptions(["--model", "org/gpt-5.1:latest"]);
    expect(options.model).toBe("org/gpt-5.1:latest");
  });

  test("--model rejects shell chars (calls process.exit)", () => {
    // Model names with shell metacharacters trigger process.exit(1).
    // We verify via subprocess to avoid killing the test runner.
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--model", "foo;rm -rf /"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid model name");
  });

  test("--model missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--model"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--model requires a value");
  });

  // -- reasoning ---

  test("--reasoning sets level and marks explicit", () => {
    for (const level of config.reasoningEfforts) {
      const { options } = parseOptions(["--reasoning", level]);
      expect(options.reasoning).toBe(level);
      expect(options.explicit.has("reasoning")).toBe(true);
    }
  });

  test("-r shorthand works", () => {
    const { options } = parseOptions(["-r", "high"]);
    expect(options.reasoning).toBe("high");
  });

  test("--reasoning invalid level exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--reasoning", "turbo"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid reasoning level");
  });

  test("--reasoning missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--reasoning"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--reasoning requires a value");
  });

  // -- sandbox ---

  test("--sandbox sets all valid modes", () => {
    for (const mode of config.sandboxModes) {
      const { options } = parseOptions(["--sandbox", mode]);
      expect(options.sandbox).toBe(mode);
      expect(options.explicit.has("sandbox")).toBe(true);
    }
  });

  test("-s shorthand works", () => {
    const { options } = parseOptions(["-s", "read-only"]);
    expect(options.sandbox).toBe("read-only");
  });

  test("--sandbox invalid mode exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--sandbox", "yolo"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid sandbox mode");
  });

  test("--sandbox missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--sandbox"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--sandbox requires a value");
  });

  // -- approval ---

  test("--approval sets all valid policies", () => {
    for (const policy of config.approvalPolicies) {
      const { options } = parseOptions(["--approval", policy]);
      expect(options.approval).toBe(policy);
      expect(options.explicit.has("approval")).toBe(true);
    }
  });

  test("--approval invalid policy exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--approval", "always"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid approval policy");
  });

  test("--approval missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--approval"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--approval requires a value");
  });

  // -- timeout ---

  test("--timeout sets valid number", () => {
    const { options } = parseOptions(["--timeout", "300"]);
    expect(options.timeout).toBe(300);
    expect(options.explicit.has("timeout")).toBe(true);
  });

  test("--timeout rejects NaN", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--timeout", "abc"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid timeout");
  });

  test("--timeout rejects negative", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--timeout", "-5"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid timeout");
  });

  test("--timeout rejects zero", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--timeout", "0"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid timeout");
  });

  test("--timeout missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--timeout"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--timeout requires a value");
  });

  // -- limit ---

  test("--limit sets valid number (floors to integer)", () => {
    const { options } = parseOptions(["--limit", "5"]);
    expect(options.limit).toBe(5);
  });

  test("--limit floors fractional values", () => {
    const { options } = parseOptions(["--limit", "7.9"]);
    expect(options.limit).toBe(7);
  });

  test("--limit rejects zero", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--limit", "0"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid limit");
  });

  test("--limit rejects NaN", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--limit", "abc"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid limit");
  });

  test("--limit missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--limit"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--limit requires a value");
  });

  // -- dir ---

  test("--dir sets dir and marks explicit", () => {
    const testDir = process.platform === "win32" ? "C:\\tmp\\myproject" : "/tmp/myproject";
    const { options } = parseOptions(["--dir", testDir]);
    expect(options.dir).toBe(testDir);
    expect(options.explicit.has("dir")).toBe(true);
  });

  test("-d shorthand works", () => {
    const testDir = process.platform === "win32" ? "C:\\tmp\\other" : "/tmp/other";
    const { options } = parseOptions(["-d", testDir]);
    expect(options.dir).toBe(testDir);
  });

  test("--dir missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--dir"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--dir requires a value");
  });

  // -- resume ---

  test("--resume sets resumeId", () => {
    const { options } = parseOptions(["--resume", "abc12345"]);
    expect(options.resumeId).toBe("abc12345");
  });

  test("--resume missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--resume"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--resume requires a value");
  });

  // -- mode ---

  test("--mode sets valid review modes", () => {
    for (const mode of VALID_REVIEW_MODES) {
      const { options } = parseOptions(["--mode", mode]);
      expect(options.reviewMode).toBe(mode);
    }
  });

  test("--mode rejects invalid mode", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--mode", "invalid"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid review mode");
  });

  test("--mode missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--mode"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--mode requires a value");
  });

  // -- ref, base ---

  test("--ref sets reviewRef", () => {
    const { options } = parseOptions(["--ref", "abc123"]);
    expect(options.reviewRef).toBe("abc123");
  });

  test("--ref missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--ref"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--ref requires a value");
  });

  test("--base sets base and marks explicit", () => {
    const { options } = parseOptions(["--base", "develop"]);
    expect(options.base).toBe("develop");
    expect(options.explicit.has("base")).toBe(true);
  });

  test("--base missing value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--base"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--base requires a value");
  });

  // -- boolean flags ---

  test("--discover sets discover flag", () => {
    const { options } = parseOptions(["--discover"]);
    expect(options.discover).toBe(true);
  });

  test("--template sets template name", () => {
    const { options } = parseOptions(["--template", "plan-review"]);
    expect(options.template).toBe("plan-review");
  });

  test("--template without value exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli.ts", "run", "--template"],
      cwd: process.cwd(),
      env: { ...process.env, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("--template requires a name");
  });

  test("--all sets limit to Infinity", () => {
    const { options } = parseOptions(["--all"]);
    expect(options.limit).toBe(Infinity);
  });

  test("--json sets json flag", () => {
    const { options } = parseOptions(["--json"]);
    expect(options.json).toBe(true);
  });

  test("--content-only sets contentOnly flag", () => {
    const { options } = parseOptions(["--content-only"]);
    expect(options.contentOnly).toBe(true);
  });

  test("--unset adds 'unset' to explicit set", () => {
    const { options } = parseOptions(["--unset"]);
    expect(options.explicit.has("unset")).toBe(true);
  });

  // -- positional arguments ---

  test("collects positional arguments", () => {
    const { positional } = parseOptions(["run", "fix the bug", "--model", "o4-mini"]);
    expect(positional).toEqual(["run", "fix the bug"]);
  });

  test("--help sets help flag", () => {
    const { options } = parseOptions(["--help"]);
    expect(options.help).toBe(true);
  });

  test("-h sets help flag", () => {
    const { options } = parseOptions(["-h"]);
    expect(options.help).toBe(true);
  });

  // -- unknown flags ---

  test("unknown flag exits", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--bogus"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Unknown option");
  });

  // -- combined flags ---

  test("multiple flags combine correctly", () => {
    const { positional, options } = parseOptions([
      "-m", "o4-mini",
      "-r", "high",
      "-s", "read-only",
      "--approval", "on-failure",
      "--timeout", "600",
      "--json",
      "do stuff",
    ]);
    expect(options.model).toBe("o4-mini");
    expect(options.reasoning).toBe("high");
    expect(options.sandbox).toBe("read-only");
    expect(options.approval).toBe("on-failure");
    expect(options.timeout).toBe(600);
    expect(options.json).toBe(true);
    expect(positional).toEqual(["do stuff"]);
    expect(options.explicit.has("model")).toBe(true);
    expect(options.explicit.has("reasoning")).toBe(true);
    expect(options.explicit.has("sandbox")).toBe(true);
    expect(options.explicit.has("approval")).toBe(true);
    expect(options.explicit.has("timeout")).toBe(true);
  });

  // -- defaults ---

  test("defaults are sane when no args given", () => {
    const { positional, options } = parseOptions([]);
    expect(positional).toEqual([]);
    expect(options.model).toBeUndefined(); // resolveModel(undefined) -> undefined
    expect(options.reasoning).toBeUndefined();
    expect(options.sandbox).toBe(config.defaultSandbox);
    expect(options.approval).toBe(config.defaultApprovalPolicy);
    expect(options.timeout).toBe(config.defaultTimeout);
    expect(options.limit).toBe(config.threadsListLimit);
    expect(options.resumeId).toBeNull();
    expect(options.reviewMode).toBeNull();
    expect(options.reviewRef).toBeNull();
    expect(options.base).toBe("main");
    expect(options.discover).toBe(false);
    expect(options.json).toBe(false);
    expect(options.contentOnly).toBe(false);
    expect(options.explicit.size).toBe(0);
  });
});

describe("parseOptions: end-of-options, =-form, and value guards", () => {
  test("-- terminates option parsing; the rest is positional", () => {
    const { positional, options } = parseOptions(["--content-only", "--", "--explain", "-v", "what do these flags do"]);
    expect(options.contentOnly).toBe(true);
    expect(positional).toEqual(["--explain", "-v", "what do these flags do"]);
  });

  test("--name=value form is expanded", () => {
    const { options } = parseOptions(["--model=gpt-5", "--timeout=90"]);
    expect(options.model).toBe("gpt-5");
    expect(options.timeout).toBe(90);
  });

  test("tokens after -- are not =-expanded", () => {
    const { positional } = parseOptions(["--", "--foo=bar"]);
    expect(positional).toEqual(["--foo=bar"]);
  });

  test("a value flag does not swallow a following flag", () => {
    // --template --content-only used to yield template="--content-only" and
    // drop the boolean, surfacing later as "Template not found: --content-only".
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--template", "--content-only", "prompt"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--template requires a name");
  });

  test("--timeout rejects values that would overflow the 32-bit timer", () => {
    // setTimeout(sec * 1000) with sec > 2_147_483 clamps to ~1ms, making
    // every turn instantly "time out".
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["--timeout", "3000000"]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid timeout");
  });

  test("--model rejects the empty string", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { parseOptions } from "./src/commands/shared";
        parseOptions(["-m", ""]);
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });
});

describe("parseOptions: --full and explicit --limit", () => {
  test("--full sets full=true", () => {
    const { options } = parseOptions(["--full"]);
    expect(options.full).toBe(true);
  });

  test("full defaults to false", () => {
    const { options } = parseOptions([]);
    expect(options.full).toBe(false);
  });

  test("--limit marks limit as explicit", () => {
    const { options } = parseOptions(["--limit", "5"]);
    expect(options.limit).toBe(5);
    expect(options.explicit.has("limit")).toBe(true);
  });

  test("default limit is not marked explicit", () => {
    const { options } = parseOptions([]);
    expect(options.explicit.has("limit")).toBe(false);
  });

  test("--all marks limit as explicit", () => {
    const { options } = parseOptions(["--all"]);
    expect(options.limit).toBe(Infinity);
    expect(options.explicit.has("limit")).toBe(true);
  });
});

// ─── pickBestModel ────────────────────────────────────────────────────────

describe("parseOptions: --approval auto and --memory", () => {
  test("--approval auto is accepted and marked explicit", () => {
    const { options } = parseOptions(["run", "task", "--approval", "auto"]);
    expect(options.approval).toBe("auto");
    expect(options.explicit.has("approval")).toBe(true);
  });

  test("--memory opts in and is marked explicit", () => {
    const { options } = parseOptions(["run", "task", "--memory"]);
    expect(options.memory).toBe(true);
    expect(options.explicit.has("memory")).toBe(true);
  });

  test("memory defaults to false (created threads excluded from Codex memory)", () => {
    const { options } = parseOptions(["run", "task"]);
    expect(options.memory).toBe(false);
  });
});

describe("resolveApproval", () => {
  test("auto maps to on-request reviewed by the Guardian subagent", () => {
    expect(resolveApproval("auto")).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  test("server policies pass through with the user reviewer (reversibility)", () => {
    // approvalsReviewer persists per-thread, so an explicit non-auto mode
    // must actively reset it — otherwise a thread once run with "auto" keeps
    // Guardian even after the user asks for interactive control.
    for (const mode of ["never", "on-request", "on-failure", "untrusted"] as const) {
      expect(resolveApproval(mode)).toEqual({ approvalPolicy: mode, approvalsReviewer: "user" });
    }
  });
});

describe("pickBestModel", () => {
  const m = (id: string, opts: { upgrade?: string; isDefault?: boolean } = {}): Model => ({
    id,
    model: id,
    upgrade: opts.upgrade ?? null,
    isDefault: opts.isDefault ?? false,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
  });

  test("follows upgrade chain to latest model", () => {
    const models = [
      m("old", { upgrade: "mid", isDefault: true }),
      m("mid", { upgrade: "new" }),
      m("new"),
    ];
    expect(pickBestModel(models)).toBe("new");
  });

  test("prefers -codex variant at end of chain", () => {
    const models = [
      m("gpt-5", { isDefault: true }),
      m("gpt-5-codex"),
    ];
    expect(pickBestModel(models)).toBe("gpt-5-codex");
  });

  test("does not prefer -codex variant if it has an upgrade itself", () => {
    const models = [
      m("gpt-5", { isDefault: true }),
      m("gpt-5-codex", { upgrade: "gpt-6-codex" }),
    ];
    // codexVariant.upgrade !== null, so returns current (gpt-5)
    expect(pickBestModel(models)).toBe("gpt-5");
  });

  test("returns undefined when no default model", () => {
    const models = [m("gpt-5")];
    expect(pickBestModel(models)).toBeUndefined();
  });

  test("handles circular upgrade chain via visited guard", () => {
    const models = [
      m("a", { upgrade: "b", isDefault: true }),
      m("b", { upgrade: "a" }),
    ];
    // a -> b (visited={a}), b -> a (visited={a,b}), a: visited.has(a) -> exit loop, current = a
    expect(pickBestModel(models)).toBe("a");
  });

  test("returns default when upgrade target not in list", () => {
    const models = [m("gpt-5", { upgrade: "nonexistent", isDefault: true })];
    expect(pickBestModel(models)).toBe("gpt-5");
  });

  test("already a -codex model stays as-is", () => {
    const models = [m("gpt-5-codex", { isDefault: true })];
    expect(pickBestModel(models)).toBe("gpt-5-codex");
  });
});

// ─── validateGitRef ────────────────────────────────────────────────────────

describe("validateGitRef", () => {
  test("accepts valid refs", () => {
    expect(validateGitRef("main", "branch")).toBe("main");
    expect(validateGitRef("feature/my-branch", "branch")).toBe("feature/my-branch");
    expect(validateGitRef("v1.2.3", "tag")).toBe("v1.2.3");
    expect(validateGitRef("abc123", "commit")).toBe("abc123");
    expect(validateGitRef("HEAD~3", "ref")).toBe("HEAD~3");
    expect(validateGitRef("origin/main", "remote")).toBe("origin/main");
  });

  test("rejects semicolon", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main;echo pwned", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Invalid ref");
  });

  test("rejects pipe", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main|cat", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects backtick", () => {
    // Backtick — use String.fromCharCode to avoid shell quoting issues
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main" + String.fromCharCode(96) + "id" + String.fromCharCode(96), "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects dollar sign", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("$HOME", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects ampersand", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main&echo", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects whitespace", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main branch", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects parentheses", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main()", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects angle brackets", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main<file", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects backslash", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("main\\\\path", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects a leading dash (option injection into downstream git)", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("--output=/tmp/x", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("rejects an empty ref", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `
        import { validateGitRef } from "./src/commands/shared";
        validateGitRef("", "ref");
      `],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
  });

  test("accepts reflog refs like HEAD@{1}", () => {
    // Braces are safe: git is always invoked with an argv array, never a shell.
    expect(validateGitRef("HEAD@{1}", "ref")).toBe("HEAD@{1}");
  });
});

// ─── applyUserConfig ──────────────────────────────────────────────────────

describe("applyUserConfig", () => {
  // applyUserConfig reads from config.configFile which derives from os.homedir().
  // Since the config object is frozen, we override HOME env var in subprocesses
  // so homedir() returns our temp dir, making configFile = <tmpHome>/.codex-collab/config.json.
  // The script file must live in the project directory so relative imports resolve.

  const projectDir = process.cwd();
  const scriptPath = join(projectDir, `_applyconfig_test_${process.pid}.ts`);

  afterEach(() => {
    try { rmSync(scriptPath); } catch {}
  });

  function runApplyConfig(
    configJson: string,
    explicitFlags: string[] = [],
    checkExpression: string,
  ): { stdout: string; exitCode: number; stderr: string } {
    const fakeHome = freshTmpDir("fake-home");
    const configDir = join(fakeHome, ".codex-collab");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), configJson);

    // Build explicit flag setup lines
    const addExplicit = explicitFlags.map(f => `opts.explicit.add("${f}");`).join("\n");
    const setValues = explicitFlags.map(f => {
      if (f === "model") return `opts.model = "cli-model";`;
      if (f === "reasoning") return `opts.reasoning = "low";`;
      if (f === "sandbox") return `opts.sandbox = "danger-full-access";`;
      if (f === "approval") return `opts.approval = "untrusted";`;
      if (f === "timeout") return `opts.timeout = 999;`;
      return "";
    }).filter(Boolean).join("\n");

    // Write script inside the project directory so relative imports resolve
    writeFileSync(scriptPath, `
import { defaultOptions, applyUserConfig } from "./src/commands/shared";
const opts = defaultOptions();
${addExplicit}
${setValues}
applyUserConfig(opts);
console.log(JSON.stringify(${checkExpression}));
`);

    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    return {
      stdout: result.stdout.toString().trim(),
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
    };
  }

  test("config values populate options when no explicit flags", () => {
    const { stdout, exitCode } = runApplyConfig(
      JSON.stringify({ model: "gpt-5", reasoning: "high", sandbox: "read-only", approval: "on-request", timeout: 500 }),
      [],
      `{ model: opts.model, reasoning: opts.reasoning, sandbox: opts.sandbox, approval: opts.approval, timeout: opts.timeout }`,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.model).toBe("gpt-5");
    expect(result.reasoning).toBe("high");
    expect(result.sandbox).toBe("read-only");
    expect(result.approval).toBe("on-request");
    expect(result.timeout).toBe(500);
  });

  test("CLI explicit flags beat config values", () => {
    const { stdout, exitCode } = runApplyConfig(
      JSON.stringify({ model: "gpt-5", reasoning: "high" }),
      ["model", "reasoning"],
      `{ model: opts.model, reasoning: opts.reasoning }`,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.model).toBe("cli-model");
    expect(result.reasoning).toBe("low");
  });

  test("config values go to configured set, not explicit", () => {
    const { stdout, exitCode } = runApplyConfig(
      JSON.stringify({ model: "gpt-5", sandbox: "read-only" }),
      [],
      `{ configured: [...opts.configured], explicit: [...opts.explicit] }`,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.configured).toContain("model");
    expect(result.configured).toContain("sandbox");
    expect(result.explicit).toEqual([]);
  });

  test("invalid model in config is ignored with warning", () => {
    const { stdout, stderr, exitCode } = runApplyConfig(
      JSON.stringify({ model: "bad;model" }),
      [],
      `{ model: opts.model ?? null }`,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ignoring invalid model");
    const result = JSON.parse(stdout);
    expect(result.model).toBeNull();
  });

  test("invalid reasoning in config is ignored with warning", () => {
    const { stdout, stderr, exitCode } = runApplyConfig(
      JSON.stringify({ reasoning: "turbo" }),
      [],
      `{ reasoning: opts.reasoning ?? null }`,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ignoring invalid reasoning");
    const result = JSON.parse(stdout);
    expect(result.reasoning).toBeNull();
  });

  test("invalid sandbox in config is ignored with warning", () => {
    const { stderr, exitCode } = runApplyConfig(
      JSON.stringify({ sandbox: "yolo" }),
      [],
      `{ sandbox: opts.sandbox }`,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ignoring invalid sandbox");
  });

  test("invalid approval in config is ignored with warning", () => {
    const { stderr, exitCode } = runApplyConfig(
      JSON.stringify({ approval: "always" }),
      [],
      `{ approval: opts.approval }`,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ignoring invalid approval");
  });

  test("invalid timeout in config is ignored with warning", () => {
    const { stderr, exitCode } = runApplyConfig(
      JSON.stringify({ timeout: -5 }),
      [],
      `{ timeout: opts.timeout }`,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ignoring invalid timeout");
  });

  test("model alias is resolved from config", () => {
    const { stdout, exitCode } = runApplyConfig(
      JSON.stringify({ model: "spark" }),
      [],
      `{ model: opts.model }`,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.model).toBe("gpt-5.3-codex-spark");
  });

  test("missing config file is tolerated", () => {
    const fakeHome = freshTmpDir("no-config-home");
    // Don't create .codex-collab/config.json — it should be missing

    writeFileSync(scriptPath, `
import { defaultOptions, applyUserConfig } from "./src/commands/shared";
const opts = defaultOptions();
applyUserConfig(opts);
console.log("ok");
`);

    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    expect(result.stdout.toString().trim()).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  test("invalid JSON in config aborts with non-zero exit instead of silently using defaults", () => {
    const fakeHome = freshTmpDir("fake-home");
    const configDir = join(fakeHome, ".codex-collab");
    mkdirSync(configDir, { recursive: true });
    // Trailing comma — valid prose but invalid JSON. Old behavior: silent {}.
    // New behavior: die() with a clear message.
    writeFileSync(join(configDir, "config.json"), '{"model": "gpt-5",}');

    writeFileSync(scriptPath, `
import { defaultOptions, applyUserConfig } from "./src/commands/shared";
const opts = defaultOptions();
applyUserConfig(opts);
console.log("should not reach here");
`);

    const result = Bun.spawnSync({
      cmd: ["bun", "run", scriptPath],
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Invalid JSON");
    expect(result.stderr.toString()).toContain("config.json");
    expect(result.stdout.toString()).not.toContain("should not reach here");
  });

  test("approval: auto and memory: true from config populate options", () => {
    const { stdout, exitCode } = runApplyConfig(
      JSON.stringify({ approval: "auto", memory: true }),
      [],
      `{ approval: opts.approval, memory: opts.memory }`,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.approval).toBe("auto");
    expect(result.memory).toBe(true);
  });

  test("non-boolean memory in config is ignored with a warning", () => {
    const { stdout, exitCode, stderr } = runApplyConfig(
      JSON.stringify({ memory: "yes" }),
      [],
      `{ memory: opts.memory }`,
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).memory).toBe(false);
    expect(stderr).toContain("invalid memory");
  });
});

// ─── startOrResumeThread ───────────────────────────────────────────────────

describe("startOrResumeThread", () => {
  test("review --resume forks source context into an ephemeral read-only review thread", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const sourceThreadId = "01900000000070008000000000000001";
    const forkedThreadId = "01900000000070008000000000000002";
    const client: AppServerClient = {
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "thread/fork") {
          return threadStartResponse(forkedThreadId, "/tmp/review-project") as T;
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      notify: () => {},
      on: () => () => {},
      onAny: () => () => {},
      onRequest: () => () => {},
      respond: () => {},
      onClose: () => () => {},
      close: async () => {},
      userAgent: "mock",
      brokerBusy: false,
    };
    const opts = defaultOptions();
    opts.resumeId = sourceThreadId;
    opts.model = "gpt-5";
    opts.dir = "/tmp/review-project";
    opts.approval = "on-request";
    opts.sandbox = "danger-full-access";
    opts.explicit.add("model");
    opts.explicit.add("dir");
    opts.explicit.add("approval");
    opts.explicit.add("sandbox");

    const result = await startOrResumeThread(
      client,
      opts,
      freshWorkspace("review-resume-fork"),
      { sandbox: "read-only" },
      "Review PR",
      true,
    );

    expect(result.threadId).toBe(forkedThreadId);
    expect(result.shortId).not.toBe(sourceThreadId);
    // Exactly one RPC: ephemeral review threads never hit disk, so no
    // thread/memoryMode/set (the server rejects metadata updates on them).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "thread/fork",
      params: {
        threadId: sourceThreadId,
        ephemeral: true,
        model: "gpt-5",
        cwd: "/tmp/review-project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
      },
    });
  });

  /** Mock client that records calls and answers from a method→response map.
   *  Unlisted methods resolve to {} so incidental RPCs (thread/name/set)
   *  don't need enumerating in every test. */
  function recordingClient(
    calls: Array<{ method: string; params: unknown }>,
    respond: Record<string, (params: unknown) => unknown>,
  ): AppServerClient {
    return {
      request: async <T,>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        const handler = respond[method];
        return (handler ? handler(params) : {}) as T;
      },
      notify: () => {},
      on: () => () => {},
      onAny: () => () => {},
      onRequest: () => () => {},
      respond: () => {},
      onClose: () => () => {},
      close: async () => {},
      userAgent: "mock",
      brokerBusy: false,
    };
  }

  const newThreadId = "01900000000070008000000000000010";

  test("new thread: disables Codex memory by default, with Guardian reviewer under --approval auto", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = recordingClient(calls, {
      "thread/start": () => threadStartResponse(newThreadId, "/tmp/proj"),
    });
    const opts = defaultOptions();
    opts.dir = "/tmp/proj";
    opts.approval = "auto";

    await startOrResumeThread(client, opts, freshWorkspace("new-thread-memory"), undefined, "task", false);

    const start = calls.find(c => c.method === "thread/start");
    expect(start?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    const memory = calls.find(c => c.method === "thread/memoryMode/set");
    expect(memory?.params).toEqual({ threadId: newThreadId, mode: "disabled" });
  });

  test("new thread with --memory: no memoryMode call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = recordingClient(calls, {
      "thread/start": () => threadStartResponse(newThreadId, "/tmp/proj"),
    });
    const opts = defaultOptions();
    opts.dir = "/tmp/proj";
    opts.memory = true;

    await startOrResumeThread(client, opts, freshWorkspace("new-thread-memory-optin"), undefined, "task", false);

    expect(calls.some(c => c.method === "thread/memoryMode/set")).toBe(false);
  });

  test("memoryMode/set failure is non-fatal (older Codex / capability missing)", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = recordingClient(calls, {
      "thread/start": () => threadStartResponse(newThreadId, "/tmp/proj"),
      "thread/memoryMode/set": () => { throw new Error("requires experimentalApi capability"); },
    });
    const opts = defaultOptions();
    opts.dir = "/tmp/proj";

    const result = await startOrResumeThread(client, opts, freshWorkspace("new-thread-memory-fail"), undefined, "task", false);
    expect(result.threadId).toBe(newThreadId);
  });

  test("resume: never touches memoryMode on a user-owned thread", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = recordingClient(calls, {
      "thread/resume": () => threadStartResponse(newThreadId, "/tmp/proj"),
    });
    const opts = defaultOptions();
    opts.dir = "/tmp/proj";
    opts.resumeId = newThreadId;

    await startOrResumeThread(client, opts, freshWorkspace("resume-no-memory"), undefined, "task", false);

    expect(calls.some(c => c.method === "thread/resume")).toBe(true);
    expect(calls.some(c => c.method === "thread/memoryMode/set")).toBe(false);
  });
});

// ─── turnOverrides ─────────────────────────────────────────────────────────

describe("turnOverrides", () => {
  test("new thread: returns model, sandbox, effort, cwd, approval", () => {
    const opts = defaultOptions();
    opts.model = "gpt-5";
    opts.reasoning = "high";
    opts.sandbox = "read-only";
    opts.approval = "on-request";
    opts.dir = "/tmp/test";
    opts.resumeId = null; // new thread

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({
      cwd: "/tmp/test",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      model: "gpt-5",
      effort: "high",
    });
  });

  test("new thread: omits model and effort when not set", () => {
    const opts = defaultOptions();
    opts.resumeId = null;
    // model and reasoning are undefined by default

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({
      cwd: opts.dir,
      approvalPolicy: opts.approval,
      approvalsReviewer: "user",
    });
    expect("model" in overrides).toBe(false);
    expect("effort" in overrides).toBe(false);
  });

  test("resumed thread: only returns explicit overrides", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.model = "gpt-5";
    opts.reasoning = "high";
    opts.sandbox = "read-only";
    opts.dir = "/tmp/test";
    // Only model was explicitly set via CLI
    opts.explicit.add("model");

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({ model: "gpt-5" });
  });

  test("resumed thread: empty overrides when nothing explicit", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.model = "gpt-5";
    opts.reasoning = "high";
    opts.configured.add("model");
    opts.configured.add("reasoning");
    // Nothing in explicit set

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({});
  });

  test("resumed thread: all explicit flags forwarded", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.model = "o4-mini";
    opts.reasoning = "low";
    opts.dir = "/tmp/proj";
    opts.approval = "on-failure";
    opts.sandbox = "danger-full-access";
    opts.explicit.add("model");
    opts.explicit.add("reasoning");
    opts.explicit.add("dir");
    opts.explicit.add("approval");
    opts.explicit.add("sandbox");

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({
      model: "o4-mini",
      effort: "low",
      cwd: "/tmp/proj",
      approvalPolicy: "on-failure",
      // Explicit non-auto selection resets a possibly-persisted Guardian
      // reviewer back to interactive routing (reversibility).
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  // Regression: resuming a thread with a new -s must carry the sandbox as a
  // turn-context override. thread/resume's `sandbox` is ignored for a thread
  // already loaded in the long-lived (broker) app-server, so the per-turn
  // sandboxPolicy is the only thing that actually re-applies the new mode.
  test("resumed thread: explicit sandbox forwarded as sandboxPolicy", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.sandbox = "workspace-write";
    opts.explicit.add("sandbox");

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({ sandboxPolicy: { type: "workspaceWrite" } });
  });

  test("resumed thread: read-only sandbox maps to readOnly policy", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.sandbox = "read-only";
    opts.explicit.add("sandbox");

    const overrides = turnOverrides(opts);
    expect(overrides).toEqual({ sandboxPolicy: { type: "readOnly" } });
  });

  test("resumed thread: non-explicit sandbox is not forwarded", () => {
    const opts = defaultOptions();
    opts.resumeId = "abc12345";
    opts.sandbox = "workspace-write"; // the default, never typed on CLI

    const overrides = turnOverrides(opts);
    expect("sandboxPolicy" in overrides).toBe(false);
  });
});

describe("turnOverrides: Guardian auto mode", () => {
  test("new thread with approval auto sends on-request + auto_review per turn", () => {
    const opts = defaultOptions();
    opts.approval = "auto";
    opts.dir = "/tmp/test";
    opts.resumeId = null;

    expect(turnOverrides(opts)).toEqual({
      cwd: "/tmp/test",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  test("resumed thread with explicit approval auto forwards both wire params", () => {
    const opts = defaultOptions();
    opts.approval = "auto";
    opts.resumeId = "abc123";
    opts.explicit.add("approval");

    expect(turnOverrides(opts)).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  test("resumed thread without explicit approval forwards neither", () => {
    const opts = defaultOptions();
    opts.approval = "auto"; // e.g. from config — not explicit, so not forwarded
    opts.resumeId = "abc123";

    expect(turnOverrides(opts)).toEqual({});
  });
});

// ─── formatDuration ────────────────────────────────────────────────────────

describe("formatDuration", () => {
  test("formats 0ms as 0s", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  test("formats sub-second as 0s (rounds)", () => {
    expect(formatDuration(499)).toBe("0s");
  });

  test("formats sub-second rounding up to 1s", () => {
    expect(formatDuration(500)).toBe("1s");
  });

  test("formats exact seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  test("formats exactly 1 minute", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(134_000)).toBe("2m 14s");
  });

  test("formats large durations (hours expressed as minutes)", () => {
    // 1 hour = 3600s = 60m 0s
    expect(formatDuration(3_600_000)).toBe("60m 0s");
  });

  test("formats 90 seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});

// ─── isThreadProcessAlive ──────────────────────────────────────────────────

describe("isThreadProcessAlive", () => {
  test("missing PID file returns true (safety default)", () => {
    const pidsDir = freshTmpDir("pids-missing");
    expect(isThreadProcessAlive(pidsDir, "nosuchthread")).toBe(true);
  });

  test("PID of current process returns true", () => {
    const pidsDir = freshTmpDir("pids-alive");
    writeFileSync(join(pidsDir, "thread1"), String(process.pid));
    expect(isThreadProcessAlive(pidsDir, "thread1")).toBe(true);
  });

  test("PID of dead process returns false", async () => {
    const pidsDir = freshTmpDir("pids-dead");
    // Spawn a short-lived process and wait for it to exit, giving us a known-dead PID
    const deadProc = Bun.spawn({ cmd: ["true"] });
    await deadProc.exited; // wait for the process to fully terminate
    const deadPid = deadProc.pid;
    writeFileSync(join(pidsDir, "thread2"), String(deadPid));
    expect(isThreadProcessAlive(pidsDir, "thread2")).toBe(false);
  });

  test("invalid PID in file returns false", () => {
    const pidsDir = freshTmpDir("pids-invalid");
    writeFileSync(join(pidsDir, "thread4"), "not-a-number");
    expect(isThreadProcessAlive(pidsDir, "thread4")).toBe(false);
  });

  test("negative PID in file returns false", () => {
    const pidsDir = freshTmpDir("pids-negative");
    writeFileSync(join(pidsDir, "thread5"), "-1");
    expect(isThreadProcessAlive(pidsDir, "thread5")).toBe(false);
  });

  test("zero PID in file returns false", () => {
    const pidsDir = freshTmpDir("pids-zero");
    writeFileSync(join(pidsDir, "thread6"), "0");
    expect(isThreadProcessAlive(pidsDir, "thread6")).toBe(false);
  });
});
