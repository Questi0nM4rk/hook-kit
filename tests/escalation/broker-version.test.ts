// biome-ignore-all lint/style/noMagicNumbers: broker-version tests pass literal protocol-version values (1, 2, 99) inline so the field-mapping intent stays readable; named constants would obscure the test fixtures.

// TASK-037 — Protocol-version validation tests.
//
// The envelope's `version` field is a Zod `z.literal(PROTOCOL_VERSION)` so
// any mismatch fails parsing. parseAskRequest pre-validates the field and
// throws ProtocolVersionError (a typed subclass) rather than letting the
// generic Zod error surface as EnvelopeValidationError — so observability
// layers can route version skew separately from shape errors.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolVersionError } from "../../src/core/errors.js";
import { brokerAskpass, ensureSession } from "../../src/escalation/broker.js";
import { createAskRequest, parseAskRequest } from "../../src/escalation/envelope.js";
import { registerListener } from "../../src/escalation/listeners.js";

describe("parseAskRequest — protocol-version validation", () => {
  test("version=2 (current) is accepted", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    expect(req.version).toBe(2);
    const parsed = parseAskRequest(JSON.stringify(req));
    expect(parsed.version).toBe(2);
    expect(parsed.id).toBe(req.id);
  });

  test("version=1 (legacy) is rejected with ProtocolVersionError", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const v1 = { ...req, version: 1 };
    try {
      parseAskRequest(JSON.stringify(v1));
      throw new Error("expected ProtocolVersionError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolVersionError);
      if (err instanceof ProtocolVersionError) {
        expect(err.code).toBe("ProtocolVersionError");
        expect(err.context.expected).toBe(2);
        expect(err.context.actual).toBe(1);
        expect(err.message).toMatch(/protocol version mismatch/);
      }
    }
  });

  test("version=99 (future) is rejected with ProtocolVersionError", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const evil = { ...req, version: 99 };
    try {
      parseAskRequest(JSON.stringify(evil));
      throw new Error("expected ProtocolVersionError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolVersionError);
      if (err instanceof ProtocolVersionError) {
        expect(err.context.actual).toBe(99);
      }
    }
  });

  test("missing version field — falls through to EnvelopeValidationError (Zod)", () => {
    // No `version` key at all is a Zod shape failure, not a version mismatch.
    // ProtocolVersionError fires only when the field exists but does not match.
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const { version: _omit, ...noVersion } = req;
    expect(() => parseAskRequest(JSON.stringify(noVersion))).toThrow();
    let caught: unknown;
    try {
      parseAskRequest(JSON.stringify(noVersion));
    } catch (e) {
      caught = e;
    }
    // Not a ProtocolVersionError — it's a Zod ZodError (caller wraps as
    // EnvelopeValidationError at the boundary).
    expect(caught instanceof ProtocolVersionError).toBe(false);
  });
});

describe("brokerAskpass — protocol-version mismatch routing", () => {
  test("rejects an envelope with version=99 and surfaces in the deny reason", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "hook-kit-broker-pv-"));
    try {
      const req = createAskRequest({
        sessionId: "s-pv",
        toolName: "Bash",
        toolInput: { command: "x" },
        reason: "r",
      });
      ensureSession("s-pv", { root: workDir });
      // The broker's parse step runs BEFORE the listener validator, so we
      // don't need a listener for this case.
      const evil = JSON.stringify({ ...req, version: 99 });
      const response = await brokerAskpass(evil, { root: workDir });
      expect(response.decision).toBe("deny");
      expect(response.reason).toMatch(/protocol version mismatch/);
      expect(response.reason).toMatch(/expected 2, got 99/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("rejects an envelope with version=1 (legacy) and surfaces in the deny reason", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "hook-kit-broker-pv-"));
    try {
      const req = createAskRequest({
        sessionId: "s-pv-1",
        toolName: "Bash",
        toolInput: { command: "x" },
        reason: "r",
      });
      ensureSession("s-pv-1", { root: workDir });
      const cleanup = registerListener("s-pv-1", "watch", { root: workDir });
      try {
        const legacy = JSON.stringify({ ...req, version: 1 });
        const response = await brokerAskpass(legacy, { root: workDir });
        expect(response.decision).toBe("deny");
        expect(response.reason).toMatch(/protocol version mismatch/);
        expect(response.reason).toMatch(/expected 2, got 1/);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("accepts current-version (v2) envelopes — version-check does not block valid traffic", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "hook-kit-broker-pv-"));
    try {
      const req = createAskRequest({
        sessionId: "s-pv-2",
        toolName: "Bash",
        toolInput: { command: "ls" },
        reason: "r",
      });
      ensureSession("s-pv-2", { root: workDir });
      const cleanup = registerListener("s-pv-2", "watch", { root: workDir });
      try {
        // Pre-stage a decision so the broker's poll resolves immediately
        // instead of hanging on this test's wall clock.
        const decidedPath = join(workDir, "s-pv-2", "decided", `${req.id}.json`);
        await Bun.write(
          decidedPath,
          JSON.stringify({
            id: req.id,
            decision: "allow",
            decidedAt: new Date().toISOString(),
          }),
        );
        const response = await brokerAskpass(JSON.stringify(req), { root: workDir });
        expect(response.decision).toBe("allow");
        // The version-check did not surface — no "protocol version mismatch" in the reason.
        expect(response.reason ?? "").not.toMatch(/protocol version/);
      } finally {
        cleanup();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
