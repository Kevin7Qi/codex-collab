import { describe, expect, test } from "bun:test";
import { terminateProcessTree, isProcessAlive } from "./process";
import { spawn } from "child_process";

// ─── terminateProcessTree ──────────────────────────────────────────────────

describe("terminateProcessTree", () => {
  test("kills a spawned process", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    terminateProcessTree(pid);

    // Wait for exit
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(resolve, 2000);
    });

    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("does not throw for non-existent PID", () => {
    expect(() => terminateProcessTree(99999999)).not.toThrow();
  });
});

// ─── isProcessAlive ────────────────────────────────────────────────────────

describe("isProcessAlive", () => {
  test("returns true for own process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });

  test("treats EPERM as alive (PID 1 on Linux as non-root)", () => {
    // PID 1 (init/systemd) is always alive but owned by root.
    // As non-root, kill(1, 0) throws EPERM — should still report alive.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(isProcessAlive(1)).toBe(true);
    }
  });
});
