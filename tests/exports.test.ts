import { describe, expect, test } from "bun:test";
import { escalate, STRICT_BUT_ASKS, STRICT_DENY } from "../src/core/security.js";
import { resolutionOf } from "../src/engine/resolution.js";
import {
  escalate as barrelEscalate,
  resolutionOf as barrelResolutionOf,
  STRICT_BUT_ASKS as barrelStrictButAsks,
  STRICT_DENY as barrelStrictDeny,
} from "../src/index.js";

// The security uncertainty surface (issue #14) must be reachable from the
// public barrel, not only its source modules — downstream consumers import
// from `@questi0nm4rk/hook-kit`. Type-only exports (SecurityOptions,
// Resolution, ...) are verified by `tsc --noEmit`; this asserts the runtime
// value exports.
describe("security surface re-exported from the barrel", () => {
  test("exposes the two profiles", () => {
    expect(barrelStrictButAsks).toBe(STRICT_BUT_ASKS);
    expect(barrelStrictDeny).toBe(STRICT_DENY);
  });

  test("exposes the escalate emit helper", () => {
    expect(barrelEscalate).toBe(escalate);
  });

  test("exposes the resolutionOf classifier", () => {
    expect(barrelResolutionOf).toBe(resolutionOf);
  });
});
