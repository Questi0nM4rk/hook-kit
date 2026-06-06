import { describe, expect, test } from "bun:test";
import type { SecurityOptions } from "../../src/core/security.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";
import type { EvalContext, HookEvent, Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// The matchers read security policy off EvalContext, so the engine must
// default-fill it (to STRICT_BUT_ASKS) and let callers override it. A capture
// rule records what the context carried during evaluation.
function captureSecurity(): {
  rule: Rule;
  seen: () => SecurityOptions | undefined;
} {
  let captured: SecurityOptions | undefined;
  const rule: Rule = {
    kind: "capture-security",
    evaluate(_event: HookEvent, ctx: EvalContext): null {
      captured = ctx.security;
      return null;
    },
  };
  return { rule, seen: () => captured };
}

describe("security threading into EvalContext", () => {
  test("defaults to STRICT_BUT_ASKS when no security option is passed", async () => {
    const cap = captureSecurity();
    await runModule({ module: moduleWith([cap.rule]), command: "ls" });
    expect(cap.seen()).toEqual(STRICT_BUT_ASKS);
  });

  test("passes a provided security profile through to the context", async () => {
    const cap = captureSecurity();
    await runModule({
      module: moduleWith([cap.rule]),
      command: "ls",
      security: STRICT_DENY,
    });
    expect(cap.seen()).toEqual(STRICT_DENY);
  });
});
