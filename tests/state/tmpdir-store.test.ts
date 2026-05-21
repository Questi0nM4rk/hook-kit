import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWriteError } from "../../src/core/errors.js";
import { TmpdirStore } from "../../src/state/tmpdir-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("TmpdirStore — basic operations", () => {
  test("get/set/has/delete on a fresh store", () => {
    const s = new TmpdirStore({ namespace: "ns", sessionId: "s1", root: workDir });
    expect(s.has("k")).toBe(false);
    expect(s.get("k")).toBeUndefined();

    s.set("k", "value");
    expect(s.has("k")).toBe(true);
    expect(s.get("k")).toBe("value");

    s.delete("k");
    expect(s.has("k")).toBe(false);
    expect(s.get("k")).toBeUndefined();
  });

  test("supports JSON-serializable values", () => {
    const s = new TmpdirStore({ namespace: "ns", sessionId: "s1", root: workDir });
    // biome-ignore lint/style/noMagicNumbers: 42 is the literal value under round-trip serialization test.
    s.set("count", 42);
    s.set("flags", ["a", "b"]);
    s.set("obj", { x: 1, y: { z: "nested" } });

    // biome-ignore lint/style/noMagicNumbers: 42 is the literal value under round-trip serialization test.
    expect(s.get("count")).toBe(42);
    expect(s.get("flags")).toEqual(["a", "b"]);
    expect(s.get("obj")).toEqual({ x: 1, y: { z: "nested" } });
  });
});

describe("TmpdirStore — persistence", () => {
  test("flush + new instance round-trips state", () => {
    const s1 = new TmpdirStore({ namespace: "ns", sessionId: "round-trip", root: workDir });
    s1.set("a", 1);
    s1.set("b", "two");
    s1.flush();

    const s2 = new TmpdirStore({ namespace: "ns", sessionId: "round-trip", root: workDir });
    expect(s2.get("a")).toBe(1);
    expect(s2.get("b")).toBe("two");
  });

  test("namespace isolation — same sessionId, different namespace", () => {
    const s1 = new TmpdirStore({ namespace: "ns-a", sessionId: "shared", root: workDir });
    s1.set("k", "from-a");
    s1.flush();

    const s2 = new TmpdirStore({ namespace: "ns-b", sessionId: "shared", root: workDir });
    expect(s2.has("k")).toBe(false);
  });

  test("session isolation — same namespace, different sessionId", () => {
    const s1 = new TmpdirStore({ namespace: "ns", sessionId: "session-a", root: workDir });
    s1.set("k", "from-a");
    s1.flush();

    const s2 = new TmpdirStore({ namespace: "ns", sessionId: "session-b", root: workDir });
    expect(s2.has("k")).toBe(false);
  });
});

describe("TmpdirStore — error surfacing (0.5 contract)", () => {
  test("starts empty when the state file does not exist", () => {
    const s = new TmpdirStore({ namespace: "ns", sessionId: "missing", root: workDir });
    expect(s.has("anything")).toBe(false);
  });

  test("starts empty when the state file is corrupt JSON (load fails open, error to stderr)", () => {
    // Constructor load failures emit a typed error line to stderr (visible)
    // and continue with an empty map. No exception propagates out of the
    // constructor — there's no EvaluationOutcome channel at construction time,
    // so stderr is the surfacing path.
    const corrupt = join(workDir, "hook-kit-ns-corrupt.json");
    writeFileSync(corrupt, "{ not valid json", "utf8");

    const s = new TmpdirStore({ namespace: "ns", sessionId: "corrupt", root: workDir });
    expect(s.has("anything")).toBe(false);
  });

  test("starts empty when the state file is not an object", () => {
    const wrongShape = join(workDir, "hook-kit-ns-wrong-shape.json");
    writeFileSync(wrongShape, '"a string"', "utf8");

    const s = new TmpdirStore({ namespace: "ns", sessionId: "wrong-shape", root: workDir });
    expect(s.has("anything")).toBe(false);
  });

  test("flush throws FileWriteError when the directory is unwritable", () => {
    // 0.5 contract: flush throws a typed FileWriteError. The engine catches it
    // and surfaces it as an `error` annotation in the EvaluationOutcome — the
    // hook never blocks the user, but the failure is visible. (Old 0.4
    // behavior was silent-swallow per Iron Law 4; new behavior is typed-throw.)
    const s = new TmpdirStore({
      namespace: "ns",
      sessionId: "unwritable",
      root: "/this/path/does/not/exist",
    });
    s.set("k", "v");
    expect(() => {
      s.flush();
    }).toThrow(FileWriteError);
  });
});
