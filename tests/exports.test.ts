import { describe, expect, test } from "bun:test";
import { allowOnly } from "../src/builders/allow-only.js";
import { protectPath } from "../src/builders/protect-path.js";
import {
  escalate,
  isUncertaintyDecision,
  STRICT_BUT_ASKS,
  STRICT_DENY,
} from "../src/core/security.js";
import {
  allowOnly as barrelAllowOnly,
  escalate as barrelEscalate,
  isUncertaintyDecision as barrelIsUncertaintyDecision,
  protectPath as barrelProtectPath,
  STRICT_BUT_ASKS as barrelStrictButAsks,
  STRICT_DENY as barrelStrictDeny,
} from "../src/index.js";

// The security uncertainty surface (issue #14) must be reachable from the
// public barrel, not only its source modules — downstream consumers import
// from `@questi0nm4rk/hook-kit`. Type-only exports (SecurityOptions, ...) are
// verified by `tsc --noEmit`; this asserts the runtime value exports.
describe("security surface re-exported from the barrel", () => {
  test("exposes the two profiles", () => {
    expect(barrelStrictButAsks).toBe(STRICT_BUT_ASKS);
    expect(barrelStrictDeny).toBe(STRICT_DENY);
  });

  test("exposes the escalate emit helper", () => {
    expect(barrelEscalate).toBe(escalate);
  });

  test("exposes the isUncertaintyDecision predicate", () => {
    expect(barrelIsUncertaintyDecision).toBe(isUncertaintyDecision);
  });
});

// The builders added alongside the security surface must also be barrel-
// reachable, not only importable from their source modules.
describe("builders re-exported from the barrel", () => {
  test("exposes allowOnly", () => {
    expect(barrelAllowOnly).toBe(allowOnly);
  });

  test("exposes protectPath", () => {
    expect(barrelProtectPath).toBe(protectPath);
  });
});
