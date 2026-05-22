// biome-ignore-all lint/style/noMagicNumbers: broker-version tests pass literal protocol-version values (1, 2, 99) inline so the field-mapping intent stays readable; named constants would obscure the test fixtures.

// TASK-037 — Protocol-version validation tests.
//
// The envelope's `version` field is a Zod `z.literal(PROTOCOL_VERSION)` so
// any mismatch fails parsing. parseAskRequest pre-validates the field and
// throws ProtocolVersionError (a typed subclass) rather than letting the
// generic Zod error surface as EnvelopeValidationError — so observability
// layers can route version skew separately from shape errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolVersionError } from "../../src/core/errors.js";
import { brokerAskpass, ensureSession } from "../../src/escalation/broker.js";
import { createAskRequest, parseAskRequest } from "../../src/escalation/envelope.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-broker-pv-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

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

  // Parameterized: v=1 (legacy) and v=99 (future) both reject with
  // ProtocolVersionError. Only the literal version value differs.
  test.each([
    1, 99,
  ])("version=%i (mismatch) is rejected with ProtocolVersionError", (badVersion) => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const bad = JSON.stringify({ ...req, version: badVersion });
    expect(() => parseAskRequest(bad)).toThrow(ProtocolVersionError);
    let caught: unknown;
    try {
      parseAskRequest(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({
      code: "ProtocolVersionError",
      context: { expected: 2, actual: badVersion },
    });
    expect((caught as Error).message).toMatch(/protocol version mismatch/);
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
    expect(() => parseAskRequest(JSON.stringify(noVersion))).not.toThrow(ProtocolVersionError);
  });
});

describe("brokerAskpass — protocol-version mismatch routing", () => {
  // Parameterized: v=1 (legacy) and v=99 (future). The broker's parse step
  // runs BEFORE the listener validator, so the listener is irrelevant here —
  // both cases surface as the same "protocol version mismatch" deny shape.
  test.each([
    1, 99,
  ])("rejects an envelope with version=%i and surfaces in the deny reason", async (badVersion) => {
    const req = createAskRequest({
      sessionId: `s-pv-${String(badVersion)}`,
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    ensureSession(`s-pv-${String(badVersion)}`, { root: workDir });
    const bad = JSON.stringify({ ...req, version: badVersion });
    const response = await brokerAskpass(bad, { root: workDir });
    expect(response.decision).toBe("deny");
    expect(response.reason).toMatch(/protocol version mismatch/);
    expect(response.reason).toMatch(new RegExp(`expected 2, got ${String(badVersion)}`));
  });

  test("accepts current-version (v2) envelopes — version-check does not block valid traffic", async () => {
    const req = createAskRequest({
      sessionId: "s-pv-2",
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "r",
    });
    ensureSession("s-pv-2", { root: workDir });
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
    const response = await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      skipValidator: true,
    });
    expect(response.decision).toBe("allow");
    // The version-check did not surface — no "protocol version mismatch" in the reason.
    expect(response.reason ?? "").not.toMatch(/protocol version/);
  });
});
