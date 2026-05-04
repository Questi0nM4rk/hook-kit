import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerPaths, ensureSession } from "../../src/escalation/broker.js";
import {
  hasParentListener,
  liveListeners,
  registerListener,
} from "../../src/escalation/listeners.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-listeners-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("registerListener", () => {
  test("creates a marker file for the current pid", () => {
    ensureSession("s1", { root: workDir });
    const cleanup = registerListener("s1", "subscribe", { root: workDir });
    const live = liveListeners("s1", { root: workDir });
    expect(live).toHaveLength(1);
    expect(live[0]?.pid).toBe(process.pid);
    expect(live[0]?.mode).toBe("subscribe");
    cleanup();
  });

  test("cleanup removes the marker", () => {
    ensureSession("s1", { root: workDir });
    const cleanup = registerListener("s1", "watch", { root: workDir });
    expect(liveListeners("s1", { root: workDir })).toHaveLength(1);
    cleanup();
    expect(liveListeners("s1", { root: workDir })).toHaveLength(0);
  });
});

describe("liveListeners", () => {
  test("returns [] for a session with no listeners dir", () => {
    expect(liveListeners("missing", { root: workDir })).toEqual([]);
  });

  test("prunes stale markers (dead pid)", () => {
    ensureSession("s1", { root: workDir });
    const dir = join(brokerPaths("s1", workDir).sessionDir, "listeners");
    mkdirSync(dir, { recursive: true });
    // PID 1 is init; we definitely can't kill it without root, but it's
    // alive. Use a clearly-dead PID (max-int hardly ever matches a running
    // process on standard Linux).
    const fakePid = 999_999_999;
    writeFileSync(
      join(dir, `${fakePid}.lock`),
      JSON.stringify({
        pid: fakePid,
        mode: "subscribe",
        sessionId: "s1",
        startedAt: new Date().toISOString(),
      }),
    );
    const live = liveListeners("s1", { root: workDir });
    expect(live).toEqual([]);
  });

  test("ignores malformed marker files (and tries to clean them up)", () => {
    ensureSession("s1", { root: workDir });
    const dir = join(brokerPaths("s1", workDir).sessionDir, "listeners");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "garbage.lock"), "{ not json");
    const live = liveListeners("s1", { root: workDir });
    expect(live).toEqual([]);
  });
});

describe("hasParentListener", () => {
  test("true when the session itself has a listener", () => {
    ensureSession("s1", { root: workDir });
    const cleanup = registerListener("s1", "subscribe", { root: workDir });
    expect(hasParentListener("s1", { root: workDir })).toBe(true);
    cleanup();
  });

  test("true when an ancestor has a listener (parent chain)", () => {
    ensureSession("root", { root: workDir });
    ensureSession("mid", { root: workDir, parentSessionId: "root" });
    ensureSession("leaf", { root: workDir, parentSessionId: "mid" });
    const cleanup = registerListener("root", "watch", { root: workDir });
    expect(hasParentListener("leaf", { root: workDir })).toBe(true);
    cleanup();
  });

  test("false when no listener exists anywhere in the chain", () => {
    ensureSession("root", { root: workDir });
    ensureSession("mid", { root: workDir, parentSessionId: "root" });
    ensureSession("leaf", { root: workDir, parentSessionId: "mid" });
    expect(hasParentListener("leaf", { root: workDir })).toBe(false);
  });

  test("cycle-safe — does not infinite-loop on a corrupted parent chain", () => {
    ensureSession("a", { root: workDir });
    ensureSession("b", { root: workDir, parentSessionId: "a" });
    // Corrupt the chain so a's parent is b (a→b→a cycle)
    const aMeta = brokerPaths("a", workDir).metaPath;
    writeFileSync(
      aMeta,
      JSON.stringify({
        sessionId: "a",
        parentSessionId: "b",
        startedAt: new Date().toISOString(),
        pid: process.pid,
      }),
    );
    expect(hasParentListener("a", { root: workDir })).toBe(false);
  });

  test("returns false when the session has no meta.json yet", () => {
    expect(hasParentListener("never-existed", { root: workDir })).toBe(false);
  });
});
