import { describe, expect, test } from "bun:test";
import { custom } from "../../src/builders/custom.js";
import { ask, warning } from "../../src/core/decision.js";
import { STRICT_BUT_ASKS } from "../../src/core/security.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// BUG 10 (SA-03 config downgrade): the unparsable escalation was gated on
// `terminal === null`, so if a prior (non-AST) rule produced an `ask`, a
// configured `onUnparsable: "deny"` was silently downgraded to that stray ask.
// A configured deny must win — deny short-circuits the merge regardless of any
// non-deny terminal already accumulated (mirrors the engine-unavailable path).

const UNPARSABLE = 'echo "unterminated';

describe("BUG 10 — unparsable deny wins over a prior ask", () => {
  test("custom ask + unparsable command under onUnparsable:deny → deny", async () => {
    const mod = moduleWith([custom("always-ask", () => ask("review please"))]);
    const out = await runModule({
      module: mod,
      command: UNPARSABLE,
      security: { ...STRICT_BUT_ASKS, onUnparsable: "deny" },
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("deny drops non-error annotations (warning emitted before the deny)", async () => {
    const mod = moduleWith([
      custom("warn-then-ask", () => warning("heads up")),
      custom("always-ask", () => ask("review please")),
    ]);
    const out = await runModule({
      module: mod,
      command: UNPARSABLE,
      security: { ...STRICT_BUT_ASKS, onUnparsable: "deny" },
    });
    expect(out.terminal?.kind).toBe("deny");
    expect(out.annotations.filter((a) => a.kind === "warning")).toHaveLength(0);
    expect(out.annotations.filter((a) => a.kind === "note")).toHaveLength(0);
  });

  test("first-ask-wins still holds under onUnparsable:ask (no prior ask clobbered)", async () => {
    const mod = moduleWith([custom("always-ask", () => ask("rule ask wins"))]);
    const out = await runModule({
      module: mod,
      command: UNPARSABLE,
      security: { ...STRICT_BUT_ASKS, onUnparsable: "ask" },
    });
    expect(out.terminal?.kind).toBe("ask");
    expect(out.terminal?.reason).toBe("rule ask wins");
  });
});
