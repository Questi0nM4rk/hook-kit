// biome-ignore-all lint/style/noMagicNumbers: broker tests use literal pollMs / timeoutMs fixtures inline for control-flow clarity; named constants would obscure timing intent.

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
import { registerListener } from "../../src/escalation/listeners.js";

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

    ensureSession("s1", { root: workDir });
    const decidedPath = join(brokerPaths("s1", workDir).decidedDir, `${req.id}.json`);
    await Bun.write(
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
      skipValidator: true,
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
      skipValidator: true,
    });
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
    await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 500,
      skipValidator: true,
    });

    const paths = brokerPaths("s-cleanup", workDir);
    expect(existsSync(join(paths.pendingDir, `${req.id}.json`))).toBe(false);
    expect(existsSync(join(paths.decidedDir, `${req.id}.json`))).toBe(false);
  });
});

describe("brokerAskpass — opt-in timeout", () => {
  test("auto-denies on timeout when timeoutMs is set explicitly", async () => {
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
      skipValidator: true,
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("no decision");
    expect(res.reason).toContain("original reason");
    expect(res.by).toBe("broker:auto-deny");
  });
});

describe("brokerAskpass — NO PARENT ATTACHED validator", () => {
  test("denies immediately when no listener is attached anywhere in the chain", async () => {
    const req = createAskRequest({
      sessionId: "no-parent",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "needs human",
    });
    const res = await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 50, // never reached — validator denies first
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("NO PARENT ATTACHED");
    expect(res.reason).toContain("needs human");
    expect(res.by).toBe("broker:validator");
  });

  test("proceeds normally when a listener exists at the same session level", async () => {
    const req = createAskRequest({
      sessionId: "with-listener",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    ensureSession("with-listener", { root: workDir });
    const cleanup = registerListener("with-listener", "subscribe", { root: workDir });
    try {
      const promise = brokerAskpass(JSON.stringify(req), {
        root: workDir,
        pollMs: 10,
        timeoutMs: 1000,
      });
      setTimeout(() => {
        submitDecision("with-listener", req.id, "allow", undefined, { root: workDir });
      }, 30);
      const res = await promise;
      expect(res.decision).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("proceeds normally when a listener exists higher up the parent chain", async () => {
    ensureSession("root", { root: workDir });
    ensureSession("leaf", { root: workDir, parentSessionId: "root" });
    const cleanup = registerListener("root", "watch", { root: workDir });
    const req = createAskRequest({
      sessionId: "leaf",
      parentSessionId: "root",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    try {
      const promise = brokerAskpass(JSON.stringify(req), {
        root: workDir,
        pollMs: 10,
        timeoutMs: 1000,
      });
      setTimeout(() => {
        submitDecision("leaf", req.id, "allow", undefined, { root: workDir });
      }, 30);
      const res = await promise;
      expect(res.decision).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("skipValidator: true bypasses the check (for tests)", async () => {
    const req = createAskRequest({
      sessionId: "bypass",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    submitDecision("bypass", req.id, "allow", undefined, { root: workDir });
    const res = await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 10,
      timeoutMs: 200,
      skipValidator: true,
    });
    expect(res.decision).toBe("allow");
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

  test("includes pendingCount", async () => {
    const req = createAskRequest({
      sessionId: "s-pending",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    ensureSession("s-pending", { root: workDir });
    await Bun.write(
      join(brokerPaths("s-pending", workDir).pendingDir, `${req.id}.json`),
      JSON.stringify(req),
    );
    const sessions = listSessions({ root: workDir });
    const found = sessions.find((s) => s.sessionId === "s-pending");
    expect(found?.pendingCount).toBe(1);
  });
});

describe("listPending + submitDecision", () => {
  test("listPending returns each request envelope on disk", async () => {
    const req = createAskRequest({
      sessionId: "s-list",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "x",
    });
    ensureSession("s-list", { root: workDir });
    await Bun.write(
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
