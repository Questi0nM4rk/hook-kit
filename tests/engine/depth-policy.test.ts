import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";
import { __setMaxRecurseDepthForTests, evaluate } from "../../src/engine/index.js";
import { bashEvent, moduleWith } from "../_helpers.js";

// SA-04 (#18): inline-shell nesting beyond MAX_RECURSE_DEPTH already escalated
// to ask; this wires it through SecurityOptions.onDepthExceeded. The cap is
// dropped to 0 so the first recursion attempt trips the limit in isolation.
const DEFAULT_MAX_DEPTH = 5;
const NESTED = "bash -c 'rm -rf /'";
const denyRm = () => moduleWith([cmd("rm").deny("x")]);

describe("SA-04 depth-exceeded honors onDepthExceeded", () => {
  test("denies under STRICT_DENY (onDepthExceeded: deny)", async () => {
    __setMaxRecurseDepthForTests(0);
    try {
      const out = await evaluate(bashEvent(NESTED), [denyRm()], { security: STRICT_DENY });
      expect(out.terminal?.kind).toBe("deny");
    } finally {
      __setMaxRecurseDepthForTests(DEFAULT_MAX_DEPTH);
    }
  });

  test("stays silent under onDepthExceeded: allow", async () => {
    __setMaxRecurseDepthForTests(0);
    try {
      const out = await evaluate(bashEvent(NESTED), [denyRm()], {
        security: { ...STRICT_BUT_ASKS, onDepthExceeded: "allow" },
      });
      expect(out.terminal).toBeNull();
    } finally {
      __setMaxRecurseDepthForTests(DEFAULT_MAX_DEPTH);
    }
  });

  test("asks under the default profile (regression)", async () => {
    __setMaxRecurseDepthForTests(0);
    try {
      const out = await evaluate(bashEvent(NESTED), [denyRm()]);
      expect(out.terminal?.kind).toBe("ask");
    } finally {
      __setMaxRecurseDepthForTests(DEFAULT_MAX_DEPTH);
    }
  });
});
