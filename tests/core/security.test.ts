import { describe, expect, test } from "bun:test";
import { escalate, STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";

// SecurityOptions is the config object the uncertainty path (issue #14) routes
// every unresolved value through. Two shipped profiles pin the recommended
// defaults; consumers spread one to override a single knob.

describe("security profiles", () => {
  test("STRICT_BUT_ASKS escalates uncertainty/unparsable/depth to ask, denies when the engine is unavailable", () => {
    expect(STRICT_BUT_ASKS).toEqual({
      uncertaintyDecision: "ask",
      onUnparsable: "ask",
      onDepthExceeded: "ask",
      onEngineUnavailable: "deny-all",
    });
  });

  test("STRICT_DENY turns every escalation into a deny", () => {
    expect(STRICT_DENY).toEqual({
      uncertaintyDecision: "deny",
      onUnparsable: "deny",
      onDepthExceeded: "deny",
      onEngineUnavailable: "deny-all",
    });
  });
});

// `escalate` is the single emit point every finding (SA-01/02/05/08...) calls
// with its own resolved knob value, so the ask/deny/allow mapping lives in one
// place rather than being re-derived per matcher.
describe("escalate", () => {
  test("'ask' yields an ask terminal carrying the reason", () => {
    expect(escalate("ask", "dynamic command word")).toEqual({
      kind: "ask",
      reason: "dynamic command word",
    });
  });

  test("'deny' yields a deny terminal carrying the reason", () => {
    expect(escalate("deny", "dynamic command word")).toEqual({
      kind: "deny",
      reason: "dynamic command word",
    });
  });

  test("'allow' yields null — the legacy fail-open silent path", () => {
    expect(escalate("allow", "dynamic command word")).toBeNull();
  });

  test("passes an optional label through to the decision", () => {
    expect(escalate("ask", "needs review", "[plugin]")).toEqual({
      kind: "ask",
      reason: "needs review",
      label: "[plugin]",
    });
  });
});
