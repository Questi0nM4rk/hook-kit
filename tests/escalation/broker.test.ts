import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brokerAskpass,
  brokerPaths,
  ensureSession,
  listPending,
  listSessions,
  submitDecision,
} from "../../src/escalation/broker.js";
import { createAskRequest } from "../../src/escalation/envelope.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-broker-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("ensureSession", () => {
  test("creates the spool tree and writes meta.json", () => {
    const paths = ensureSession("s1", { root: workDir, parentSessionId: "p1" });
    expect(existsSync(paths.pendingDir)).toBe(true);
    expect(existsSync(paths.decidedDir)).toBe(true);
    expect(existsSync(paths.metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(paths.metaPath, "utf8"));
    expect(meta.sessionId).toBe("s1");
    expect(meta.parentSessionId).toBe("p1");
    expect(typeof meta.pid).toBe("number");
    expect(typeof meta.startedAt).toBe("string");
  });

  test("is idempotent — does not overwrite existing meta.json", () => {
    ensureSession("s1", { root: workDir });
    const meta1 = readFileSync(brokerPaths("s1", workDir).metaPath, "utf8");
    ensureSession("s1", { root: workDir, parentSessionId: "p2" });
    const meta2 = readFileSync(brokerPaths("s1", workDir).metaPath, "utf8");
    expect(meta1).toBe(meta2);
  });
});

describe("brokerAskpass — happy path", () => {
  test("writes decision file → broker reads it and returns AskResponse", async () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "test",
    });

    // Pre-write a decision so the broker doesn't have to wait.
    ensureSession("s1", { root: workDir });
    const decidedPath = join(brokerPaths("s1", workDir).decidedDir, `${req.id}.json`);
    Bun.write(
      decidedPath,
      JSON.stringify({
        id: req.id,
        decision: "allow",
        decidedAt: new Date().toISOString(),
      }),
    );

    const res = await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 1000,
    });
    expect(res.decision).toBe("allow");
    expect(res.id).toBe(req.id);
  });

  test("submitDecision unblocks an in-flight broker call", async () => {
    const req = createAskRequest({
      sessionId: "s2",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "test",
    });

    const promise = brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 2000,
    });
    // Submit the decision after a brief delay to simulate a listener.
    setTimeout(() => {
      submitDecision("s2", req.id, "deny", "policy", { root: workDir, by: "test" });
    }, 50);
    const res = await promise;
    expect(res.decision).toBe("deny");
    expect(res.reason).toBe("policy");
    expect(res.by).toBe("test");
  });

  test("cleans up pending and decided files after returning", async () => {
    const req = createAskRequest({
      sessionId: "s-cleanup",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    submitDecision("s-cleanup", req.id, "allow", undefined, { root: workDir });
    await brokerAskpass(JSON.stringify(req), { root: workDir, pollMs: 10, timeoutMs: 500 });

    const paths = brokerPaths("s-cleanup", workDir);
    expect(existsSync(join(paths.pendingDir, `${req.id}.json`))).toBe(false);
    expect(existsSync(join(paths.decidedDir, `${req.id}.json`))).toBe(false);
  });
});

describe("brokerAskpass — timeout", () => {
  test("auto-denies when no decision is submitted within the timeout", async () => {
    const req = createAskRequest({
      sessionId: "s-timeout",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "original reason",
    });
    const res = await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 100,
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("no decision");
    expect(res.reason).toContain("original reason");
    expect(res.by).toBe("broker:auto-deny");
  });
});

describe("brokerAskpass — bad input", () => {
  test("malformed envelope produces a deny without crashing", async () => {
    const res = await brokerAskpass("{ not json", { root: workDir, pollMs: 10, timeoutMs: 100 });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("malformed");
  });
});

describe("listSessions", () => {
  test("enumerates active sessions", () => {
    ensureSession("a", { root: workDir });
    ensureSession("b", { root: workDir, parentSessionId: "a" });
    ensureSession("c", { root: workDir });

    const all = listSessions({ root: workDir });
    expect(all.map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"]);
  });

  test("filters by parent_session_id when childrenOf is provided", () => {
    ensureSession("parent", { root: workDir });
    ensureSession("child-1", { root: workDir, parentSessionId: "parent" });
    ensureSession("child-2", { root: workDir, parentSessionId: "parent" });
    ensureSession("orphan", { root: workDir });

    const children = listSessions({ root: workDir, childrenOf: "parent" });
    expect(children.map((s) => s.sessionId).sort()).toEqual(["child-1", "child-2"]);
  });

  test("returns [] for a missing root", () => {
    const out = listSessions({ root: join(workDir, "does-not-exist") });
    expect(out).toEqual([]);
  });

  test("includes pendingCount", () => {
    const req = createAskRequest({
      sessionId: "s-pending",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    ensureSession("s-pending", { root: workDir });
    Bun.write(
      join(brokerPaths("s-pending", workDir).pendingDir, `${req.id}.json`),
      JSON.stringify(req),
    );
    const sessions = listSessions({ root: workDir });
    const found = sessions.find((s) => s.sessionId === "s-pending");
    expect(found?.pendingCount).toBe(1);
  });
});

describe("listPending + submitDecision", () => {
  test("listPending returns each request envelope on disk", () => {
    const req = createAskRequest({
      sessionId: "s-list",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    ensureSession("s-list", { root: workDir });
    Bun.write(
      join(brokerPaths("s-list", workDir).pendingDir, `${req.id}.json`),
      JSON.stringify(req),
    );
    const pending = listPending("s-list", { root: workDir });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(req.id);
  });

  test("submitDecision creates the decided file", () => {
    ensureSession("s-submit", { root: workDir });
    const ok = submitDecision("s-submit", "req-1", "allow", undefined, { root: workDir });
    expect(ok).toBe(true);
    const decided = readFileSync(
      join(brokerPaths("s-submit", workDir).decidedDir, "req-1.json"),
      "utf8",
    );
    expect(JSON.parse(decided).decision).toBe("allow");
  });

  test("submitDecision is first-writer-wins (atomic)", () => {
    ensureSession("s-race", { root: workDir });
    const a = submitDecision("s-race", "req", "allow", undefined, { root: workDir, by: "a" });
    const b = submitDecision("s-race", "req", "deny", "late", { root: workDir, by: "b" });
    expect(a).toBe(true);
    expect(b).toBe(false);
    const stored = JSON.parse(
      readFileSync(join(brokerPaths("s-race", workDir).decidedDir, "req.json"), "utf8"),
    );
    expect(stored.decision).toBe("allow");
    expect(stored.by).toBe("a");
  });
});
