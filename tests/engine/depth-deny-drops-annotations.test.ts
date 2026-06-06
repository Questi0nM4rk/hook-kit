import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_DENY } from "../../src/core/security.js";
import { __setMaxRecurseDepthForTests, evaluate } from "../../src/engine/index.js";
import { bashEvent, moduleWith } from "../_helpers.js";

// BUG 12 (SA-04 merge-contract): when onDepthExceeded resolves to deny, the
// depth-exceeded branch returned RAW annotations, leaking warning/note past a
// deny. Every other deny exit uses keepOnlyErrors(). A command that accrues a
// warning then trips the depth cap under onDepthExceeded:"deny" must deny with
// only error annotations surviving (no warning/note).

const DEFAULT_MAX_DEPTH = 5;
const NESTED = "bash -c 'rm -rf /'";
// `cmd("bash")` fires on the OUTER `bash -c '…'` call, accruing a warning in
// the same frame BEFORE the depth-cap check runs.
const warnThenDepth = () => moduleWith([cmd("bash").warning("inline-shell warning")]);

describe("BUG 12 — depth-exceeded deny drops non-error annotations", () => {
  test("warning accrued then depth cap under onDepthExceeded:deny → deny with no warning/note", async () => {
    __setMaxRecurseDepthForTests(0);
    try {
      const out = await evaluate(bashEvent(NESTED), [warnThenDepth()], { security: STRICT_DENY });
      expect(out.terminal?.kind).toBe("deny");
      expect(out.annotations.filter((a) => a.kind === "warning")).toHaveLength(0);
      expect(out.annotations.filter((a) => a.kind === "note")).toHaveLength(0);
    } finally {
      __setMaxRecurseDepthForTests(DEFAULT_MAX_DEPTH);
    }
  });
});
