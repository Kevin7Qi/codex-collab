import { describe, expect, test, beforeEach } from "bun:test";
import {
  generateShortId, loadThreadMapping, saveThreadMapping,
  resolveThreadId, registerThread, findShortId, removeThread,
} from "./threads";
import { rmSync, existsSync } from "fs";

const TEST_THREADS_FILE = `${process.env.TMPDIR || "/tmp/claude-1000"}/codex-collab-test-threads.json`;

beforeEach(() => {
  if (existsSync(TEST_THREADS_FILE)) rmSync(TEST_THREADS_FILE);
});

describe("generateShortId", () => {
  test("returns 8-char hex string", () => {
    const id = generateShortId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateShortId()));
    expect(ids.size).toBe(100);
  });
});

describe("thread mapping", () => {
  test("save and load round-trips", () => {
    const mapping = { abc12345: { threadId: "thr-long-id", createdAt: "2026-01-01T00:00:00Z" } };
    saveThreadMapping(TEST_THREADS_FILE, mapping);
    const loaded = loadThreadMapping(TEST_THREADS_FILE);
    expect(loaded.abc12345.threadId).toBe("thr-long-id");
  });

  test("load returns empty object for missing file", () => {
    const loaded = loadThreadMapping(TEST_THREADS_FILE);
    expect(loaded).toEqual({});
  });

  test("registerThread adds to mapping", () => {
    const mapping = registerThread(TEST_THREADS_FILE, "thr-new-id", { model: "gpt-5.3", cwd: "/proj" });
    expect(Object.keys(mapping).length).toBe(1);
    const shortId = Object.keys(mapping)[0];
    expect(shortId).toMatch(/^[0-9a-f]{8}$/);
    expect(mapping[shortId].threadId).toBe("thr-new-id");
    expect(mapping[shortId].model).toBe("gpt-5.3");
    expect(mapping[shortId].cwd).toBe("/proj");
  });

  test("resolveThreadId finds by exact short ID", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: { threadId: "thr-long-id", createdAt: "2026-01-01T00:00:00Z" },
    });
    const threadId = resolveThreadId(TEST_THREADS_FILE, "abc12345");
    expect(threadId).toBe("thr-long-id");
  });

  test("resolveThreadId finds by prefix", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: { threadId: "thr-long-id", createdAt: "2026-01-01T00:00:00Z" },
    });
    const threadId = resolveThreadId(TEST_THREADS_FILE, "abc1");
    expect(threadId).toBe("thr-long-id");
  });

  test("resolveThreadId throws for ambiguous prefix", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: { threadId: "thr-1", createdAt: "2026-01-01T00:00:00Z" },
      abc12399: { threadId: "thr-2", createdAt: "2026-01-01T00:00:00Z" },
    });
    expect(() => resolveThreadId(TEST_THREADS_FILE, "abc12")).toThrow(/ambiguous/i);
  });

  test("resolveThreadId throws for unknown ID", () => {
    saveThreadMapping(TEST_THREADS_FILE, {});
    expect(() => resolveThreadId(TEST_THREADS_FILE, "ffffffff")).toThrow(/not found/i);
  });

  test("findShortId returns short ID for known thread", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: { threadId: "thr-long-id", createdAt: "2026-01-01T00:00:00Z" },
    });
    const shortId = findShortId(TEST_THREADS_FILE, "thr-long-id");
    expect(shortId).toBe("abc12345");
  });

  test("findShortId returns null for unknown thread", () => {
    saveThreadMapping(TEST_THREADS_FILE, {});
    const shortId = findShortId(TEST_THREADS_FILE, "thr-nonexistent");
    expect(shortId).toBeNull();
  });

  test("removeThread deletes from mapping", () => {
    saveThreadMapping(TEST_THREADS_FILE, {
      abc12345: { threadId: "thr-1", createdAt: "2026-01-01T00:00:00Z" },
      def67890: { threadId: "thr-2", createdAt: "2026-01-01T00:00:00Z" },
    });
    removeThread(TEST_THREADS_FILE, "abc12345");
    const loaded = loadThreadMapping(TEST_THREADS_FILE);
    expect(loaded.abc12345).toBeUndefined();
    expect(loaded.def67890).toBeDefined();
  });
});
