import { describe, expect, test } from "bun:test";
import {
  createAskRequest,
  parseAskRequest,
  parseAskResponse,
} from "../../src/escalation/envelope.js";

describe("createAskRequest", () => {
  test("populates required fields", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "rm -rf /tmp" },
      reason: "looks dangerous",
    });
    expect(req.sessionId).toBe("s1");
    expect(req.toolName).toBe("Bash");
    expect(req.toolInput).toEqual({ command: "rm -rf /tmp" });
    expect(req.reason).toBe("looks dangerous");
    expect(req.version).toBe(1);
    expect(req.id.length).toBeGreaterThan(10);
    expect(typeof req.createdAt).toBe("string");
    expect(typeof req.expiresAt).toBe("string");
  });

  test("expiresAt = createdAt + ttlMs (default 60s)", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const created = Date.parse(req.createdAt);
    const expires = Date.parse(req.expiresAt);
    expect(expires - created).toBe(60_000);
  });

  test("ttlMs override is honored", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
      ttlMs: 30_000,
    });
    const created = Date.parse(req.createdAt);
    const expires = Date.parse(req.expiresAt);
    expect(expires - created).toBe(30_000);
  });

  test("optional fields are omitted when not provided", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    expect(req.parentSessionId).toBeUndefined();
    expect(req.label).toBeUndefined();
  });

  test("optional fields are preserved when provided", () => {
    const req = createAskRequest({
      sessionId: "s1",
      parentSessionId: "parent-s",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
      label: "[strict-review]",
    });
    expect(req.parentSessionId).toBe("parent-s");
    expect(req.label).toBe("[strict-review]");
  });

  test("each request gets a unique id", () => {
    const a = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const b = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe("parseAskRequest", () => {
  test("round-trips a valid request", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const parsed = parseAskRequest(JSON.stringify(req));
    expect(parsed.id).toBe(req.id);
    expect(parsed.sessionId).toBe(req.sessionId);
    expect(parsed.reason).toBe(req.reason);
  });

  test("throws on malformed JSON", () => {
    expect(() => parseAskRequest("{ not json")).toThrow();
  });

  test("throws on missing required fields", () => {
    expect(() => parseAskRequest(JSON.stringify({ id: "x" }))).toThrow();
  });

  test("rejects an unknown protocol version", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    const evil = { ...req, version: 99 };
    expect(() => parseAskRequest(JSON.stringify(evil))).toThrow();
  });
});

describe("parseAskResponse", () => {
  test("parses an allow response", () => {
    const r = parseAskResponse(
      JSON.stringify({ id: "abc", decision: "allow", decidedAt: new Date().toISOString() }),
    );
    expect(r.decision).toBe("allow");
    expect(r.id).toBe("abc");
  });

  test("parses a deny response with reason", () => {
    const r = parseAskResponse(
      JSON.stringify({
        id: "abc",
        decision: "deny",
        reason: "policy violation",
        decidedAt: new Date().toISOString(),
      }),
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("policy violation");
  });

  test("parses a harness-ask response", () => {
    const r = parseAskResponse(
      JSON.stringify({ id: "abc", decision: "harness-ask", decidedAt: new Date().toISOString() }),
    );
    expect(r.decision).toBe("harness-ask");
  });

  test("rejects an unknown decision kind", () => {
    expect(() =>
      parseAskResponse(
        JSON.stringify({
          id: "abc",
          decision: "maybe",
          decidedAt: new Date().toISOString(),
        }),
      ),
    ).toThrow();
  });

  test("throws on malformed JSON", () => {
    expect(() => parseAskResponse("not json")).toThrow();
  });
});
