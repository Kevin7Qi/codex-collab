import { describe, expect, test } from "bun:test";
import { applyDiscoverLimit } from "./threads";

describe("applyDiscoverLimit", () => {
  test("caps to 5 when discover=true and limit not explicit", () => {
    const opts = { discover: true, limit: 20, explicit: new Set<string>() };
    expect(applyDiscoverLimit(opts)).toBe(5);
  });

  test("uses explicit limit when discover=true and --limit provided", () => {
    const opts = { discover: true, limit: 30, explicit: new Set(["limit"]) };
    expect(applyDiscoverLimit(opts)).toBe(30);
  });

  test("returns original limit when discover=false (no cap)", () => {
    const opts = { discover: false, limit: 20, explicit: new Set<string>() };
    expect(applyDiscoverLimit(opts)).toBe(20);
  });

  test("returns Infinity when discover=false and --all", () => {
    const opts = { discover: false, limit: Infinity, explicit: new Set(["limit"]) };
    expect(applyDiscoverLimit(opts)).toBe(Infinity);
  });
});
