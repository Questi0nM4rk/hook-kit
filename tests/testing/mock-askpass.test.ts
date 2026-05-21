// Verifies mockAskpass produces a working askpass script.
// Exercises the real callAskpass path so any divergence between the test
// helper's script and the production envelope contract surfaces here.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { callAskpass } from "../../src/escalation/askpass.js";
import { type AskRequest, createAskRequest } from "../../src/escalation/envelope.js";
import { type MockAskpass, mockAskpass } from "../../src/testing/mock-askpass.js";

const allocated: MockAskpass[] = [];

function track(m: MockAskpass): MockAskpass {
  allocated.push(m);
  return m;
}

afterEach(() => {
  for (const m of allocated.splice(0)) {
    m.cleanup();
  }
});

function makeRequest(): AskRequest {
  return createAskRequest({
    sessionId: "test-session",
    toolName: "Bash",
    toolInput: { command: "rm -rf /tmp/x" },
    reason: "test",
  });
}

describe("mockAskpass — script generation", () => {
  test("path points at an existing executable", () => {
    const m = track(mockAskpass({ decision: "allow" }));
    expect(existsSync(m.path)).toBe(true);
    expect(m.path).toMatch(/mock-askpass\.sh$/);
  });

  test("env carries HOOK_KIT_ASKPASS=<path>", () => {
    const m = track(mockAskpass({ decision: "deny" }));
    expect(m.env).toEqual({ HOOK_KIT_ASKPASS: m.path });
  });

  test("cleanup removes the script + workdir", () => {
    const m = mockAskpass({ decision: "allow" });
    expect(existsSync(m.path)).toBe(true);
    m.cleanup();
    expect(existsSync(m.path)).toBe(false);
  });

  test("cleanup is idempotent (force: true)", () => {
    const m = mockAskpass({ decision: "allow" });
    m.cleanup();
    expect(() => {
      m.cleanup();
    }).not.toThrow();
  });
});

describe("mockAskpass — integration via callAskpass", () => {
  test("decision: allow → response carries allow with matching id", async () => {
    const m = track(mockAskpass({ decision: "allow" }));
    const req = makeRequest();
    const res = await callAskpass({ request: req, askpassPath: m.path });
    expect(res.decision).toBe("allow");
    expect(res.id).toBe(req.id);
    expect(res.by).toBe("mockAskpass");
  });

  test("decision: deny → response carries deny + custom reason", async () => {
    const m = track(mockAskpass({ decision: "deny", reason: "policy violation" }));
    const req = makeRequest();
    const res = await callAskpass({ request: req, askpassPath: m.path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toBe("policy violation");
    expect(res.id).toBe(req.id);
  });

  test("decision: harness-ask → response carries harness-ask", async () => {
    const m = track(mockAskpass({ decision: "harness-ask" }));
    const req = makeRequest();
    const res = await callAskpass({ request: req, askpassPath: m.path });
    expect(res.decision).toBe("harness-ask");
  });

  test("custom by + decidedAt are echoed in the response", async () => {
    const m = track(
      mockAskpass({
        decision: "allow",
        by: "custom-bot",
        decidedAt: "2030-12-31T23:59:59Z",
      }),
    );
    const res = await callAskpass({ request: makeRequest(), askpassPath: m.path });
    expect(res.by).toBe("custom-bot");
    expect(res.decidedAt).toBe("2030-12-31T23:59:59Z");
  });

  test("each request gets a response with that request's id", async () => {
    const m = track(mockAskpass({ decision: "allow" }));
    const req1 = makeRequest();
    const req2 = makeRequest();
    expect(req1.id).not.toBe(req2.id); // sanity
    const res1 = await callAskpass({ request: req1, askpassPath: m.path });
    const res2 = await callAskpass({ request: req2, askpassPath: m.path });
    expect(res1.id).toBe(req1.id);
    expect(res2.id).toBe(req2.id);
  });
});
