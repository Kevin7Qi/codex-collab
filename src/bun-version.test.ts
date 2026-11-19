import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import { MIN_BUN, bunTooOld, bunTooOldMessage } from "./bun-version";

const root = join(import.meta.dir, "..");

describe("the oldest Bun codex-collab runs on", () => {
  test("is package.json's engines.bun", () => {
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN}`);
    expect(MIN_BUN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("an older Bun is too old; the same one and a newer one are not", () => {
    const [major, minor, patch] = MIN_BUN.split(".").map(Number);
    expect(bunTooOld(`${major}.${minor}.${patch - 1}`)).toBe(true);
    expect(bunTooOld(`${major}.${minor - 1}.99`)).toBe(true);
    expect(bunTooOld("1.2.10")).toBe(true);
    expect(bunTooOld(MIN_BUN)).toBe(false);
    expect(bunTooOld(`${major}.${minor}.${patch + 1}`)).toBe(false);
    expect(bunTooOld(`${major + 1}.0.0`)).toBe(false);
  });

  test("the message names both versions, and there is none for a Bun that will do", () => {
    const message = bunTooOldMessage("1.2.10");
    expect(message).toContain(`Bun ${MIN_BUN} or newer`);
    expect(message).toContain("this is Bun 1.2.10");
    expect(bunTooOldMessage(MIN_BUN)).toBeNull();
    // The Bun running this suite is one the suite passes on.
    expect(bunTooOldMessage()).toBeNull();
  });

  test("the docs and CI name the same version", () => {
    for (const file of ["README.md", "README.zh-CN.md", "CONTRIBUTING.md"]) {
      expect(readFileSync(join(root, file), "utf-8")).toContain(`>= ${MIN_BUN}`);
    }
    // One CI job runs the suite on the oldest Bun, so the number stays true.
    expect(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8")).toContain(`"${MIN_BUN}"`);
  });

  test("both installers check before they build", () => {
    const sh = readFileSync(join(root, "install.sh"), "utf-8");
    expect(sh.indexOf("scripts/check-bun.ts")).toBeGreaterThan(-1);
    expect(sh.indexOf("scripts/check-bun.ts")).toBeLessThan(sh.indexOf("bun install"));
    const ps = readFileSync(join(root, "install.ps1"), "utf-8");
    expect(ps.indexOf("check-bun.ts")).toBeGreaterThan(-1);
    expect(ps.indexOf("check-bun.ts")).toBeLessThan(ps.indexOf("bun install"));
  });
});
