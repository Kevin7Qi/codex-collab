// Tests for run.ts — launch-time guards.
import { describe, expect, test } from "bun:test";
import { advertisesAskChannel } from "./run";

describe("advertisesAskChannel (run --template under -s read-only)", () => {
  test("only templates that mention the ask command count", () => {
    expect(advertisesAskChannel("If you need a decision, run `codex-collab ask \"…\"`.")).toBe(true);
    expect(advertisesAskChannel("Implement the feature. codex-collab askew")).toBe(false);
    expect(advertisesAskChannel("Plain task with no channel")).toBe(false);
  });
});
