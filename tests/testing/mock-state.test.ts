import { describe, expect, test } from "bun:test";
import { mockState } from "../../src/testing/mock-state.js";

describe("mockState", () => {
  test("empty store: no keys", () => {
    const s = mockState();
    expect(s.has("anything")).toBe(false);
    expect(s.get("anything")).toBeUndefined();
  });

  test("initial seed populates store", () => {
    const s = mockState({ foo: 1, bar: "x" });
    expect(s.get("foo")).toBe(1);
    expect(s.get("bar")).toBe("x");
    expect(s.has("foo")).toBe(true);
    expect(s.has("missing")).toBe(false);
  });

  test("set / get / has / delete cycle", () => {
    const s = mockState();
    s.set("k", "v1");
    expect(s.has("k")).toBe(true);
    expect(s.get("k")).toBe("v1");
    s.set("k", "v2");
    expect(s.get("k")).toBe("v2");
    s.delete("k");
    expect(s.has("k")).toBe(false);
    expect(s.get("k")).toBeUndefined();
  });

  test("flush is no-op by default", async () => {
    const s = mockState({ a: 1 });
    await s.flush();
    expect(s.get("a")).toBe(1);
  });

  test("custom flushFn is called", async () => {
    let flushed = 0;
    const s = mockState(
      {},
      {
        flushFn: () => {
          flushed++;
        },
      },
    );
    await s.flush();
    await s.flush();
    expect(flushed).toBe(2);
  });

  test("custom flushFn supports async", async () => {
    let flushed = 0;
    const s = mockState(
      {},
      {
        flushFn: async () => {
          await new Promise((r) => setTimeout(r, 1));
          flushed++;
        },
      },
    );
    await s.flush();
    expect(flushed).toBe(1);
  });

  test("custom flushFn that throws propagates (so engine can wrap as StateStoreError)", async () => {
    const s = mockState(
      {},
      {
        flushFn: () => {
          throw new Error("disk full");
        },
      },
    );
    // bun:test's `.rejects.toThrow()` types as void; use try/await/catch so eslint sees the awaited promise.
    let caught: unknown;
    try {
      await s.flush();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toBe("disk full");
  });

  test("two mockState calls produce independent stores", () => {
    const a = mockState({ k: 1 });
    const b = mockState({ k: 2 });
    // biome-ignore lint/style/noMagicNumbers: 99 is a sentinel value distinct from the seeded 1/2 to prove a.set doesn't leak into b.
    a.set("k", 99);
    expect(b.get("k")).toBe(2);
  });

  test("delete on missing key is silent", () => {
    const s = mockState();
    expect(() => {
      s.delete("missing");
    }).not.toThrow();
  });
});
