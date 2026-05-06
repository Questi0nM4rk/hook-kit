import { describe, expect, test } from "bun:test";
import { hostname } from "node:os";
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
    expect(req.version).toBe(2);
    expect(req.id.length).toBeGreaterThan(10);
    expect(typeof req.createdAt).toBe("string");
    expect(typeof req.expiresAt).toBe("string");
  });

  test("autofills pid/host/user/cwd/transcriptPath/harness when not provided", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
    });
    expect(req.pid).toBe(process.pid);
    expect(req.host).toBe(hostname());
    expect(req.user.length).toBeGreaterThan(0);
    expect(req.cwd).toBe(process.cwd());
    expect(req.transcriptPath).toBe("");
    expect(req.harness).toEqual({ name: "unknown" });
    expect(req.git).toBeUndefined();
  });

  test("explicit overrides take precedence over autofill", () => {
    const req = createAskRequest({
      sessionId: "s1",
      toolName: "Bash",
      toolInput: { command: "x" },
      reason: "r",
      pid: 4242,
      host: "ci-runner-7",
      user: "ci",
      cwd: "/work/repo",
      transcriptPath: "/tmp/t.jsonl",
      harness: { name: "claude-code", version: "1.0.0" },
      git: { sha: "abc123", branch: "main", dirty: false, remote: "git@x:y" },
    });
    expect(req.pid).toBe(4242);
    expect(req.host).toBe("ci-runner-7");
    expect(req.user).toBe("ci");
    expect(req.cwd).toBe("/work/repo");
    expect(req.transcriptPath).toBe("/tmp/t.jsonl");
    expect(req.harness).toEqual({ name: "claude-code", version: "1.0.0" });
    expect(req.git).toEqual({ sha: "abc123", branch: "main", dirty: false, remote: "git@x:y" });
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
