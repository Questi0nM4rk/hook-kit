import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerPaths, ensureSession, submitDecision } from "../../src/escalation/broker.js";
import { createAskRequest } from "../../src/escalation/envelope.js";
import { forwardUp } from "../../src/escalation/forward.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-forward-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function stagePending(sessionId: string, parentSessionId?: string) {
  ensureSession(sessionId, {
    root: workDir,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  });
  const req = createAskRequest({
    sessionId,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    toolName: "Bash",
    toolInput: { command: "ls" },
    reason: "test",
  });
  const pendingPath = join(brokerPaths(sessionId, workDir).pendingDir, `${req.id}.json`);
  writeFileSync(pendingPath, JSON.stringify(req));
  return req;
}

describe("forwardUp — missing pending", () => {
  test("returns missing-pending when no envelope exists", async () => {
    ensureSession("empty", { root: workDir });
    const result = await forwardUp("empty", "no-such-id", { root: workDir });
    expect(result.kind).toBe("missing-pending");
  });
});

describe("forwardUp — chain end (no parent)", () => {
  test("returns harness-ask when the source has no parent", async () => {
    const req = stagePending("root-only");
    const result = await forwardUp("root-only", req.id, { root: workDir });
    expect(result.kind).toBe("harness-ask");
    expect(result.response?.decision).toBe("harness-ask");
    // Source's decided/<id>.json should be written.
    const decided = join(brokerPaths("root-only", workDir).decidedDir, `${req.id}.json`);
    expect(existsSync(decided)).toBe(true);
  });
});

describe("forwardUp — happy path (one hop)", () => {
  test("republishes at parent and copies back the parent's decision", async () => {
    ensureSession("parent", { root: workDir });
    const req = stagePending("child", "parent");

    // Start the forward in the background.
    const forward = forwardUp("child", req.id, { root: workDir, pollMs: 10 });

    // Simulate a listener at the parent submitting after a brief delay.
    setTimeout(() => {
      submitDecision("parent", req.id, "allow", "approved", {
        root: workDir,
        by: "parent-listener",
      });
    }, 50);

    const result = await forward;
    expect(result.kind).toBe("forwarded");
    expect(result.response?.decision).toBe("allow");
    expect(result.response?.reason).toBe("approved");
    expect(result.parentSessionId).toBe("parent");

    // Source's decided/<id>.json should mirror the parent's decision.
    const sourceDecided = join(brokerPaths("child", workDir).decidedDir, `${req.id}.json`);
    expect(existsSync(sourceDecided)).toBe(true);
    const sourceContent = JSON.parse(readFileSync(sourceDecided, "utf8"));
    expect(sourceContent.decision).toBe("allow");
  });

  test("preserves a deny + reason from the parent", async () => {
    ensureSession("parent", { root: workDir });
    const req = stagePending("child", "parent");
    const forward = forwardUp("child", req.id, { root: workDir, pollMs: 10 });
    setTimeout(() => {
      submitDecision("parent", req.id, "deny", "policy", { root: workDir });
    }, 30);
    const result = await forward;
    expect(result.response?.decision).toBe("deny");
    expect(result.response?.reason).toBe("policy");
  });

  test("includes forwarded_from on the republished pending envelope", async () => {
    ensureSession("parent", { root: workDir });
    const req = stagePending("child", "parent");

    // Don't actually answer; let the forwarder stage the parent pending then
    // submit the answer so it returns.
    const forward = forwardUp("child", req.id, { root: workDir, pollMs: 10 });
    setTimeout(() => {
      const parentPending = join(brokerPaths("parent", workDir).pendingDir, `${req.id}.json`);
      const envelope = JSON.parse(readFileSync(parentPending, "utf8"));
      expect(envelope.forwarded_from).toBe("child");
      submitDecision("parent", req.id, "allow", undefined, { root: workDir });
    }, 50);
    await forward;
  });
});

describe("forwardUp — opt-in timeout at the parent", () => {
  test("denies when the parent never responds within timeoutMs", async () => {
    ensureSession("parent", { root: workDir });
    const req = stagePending("child", "parent");
    const result = await forwardUp("child", req.id, {
      root: workDir,
      pollMs: 10,
      timeoutMs: 100,
    });
    expect(result.kind).toBe("forwarded");
    expect(result.response?.decision).toBe("deny");
    expect(result.response?.reason).toContain("no parent decision");
  });
});
