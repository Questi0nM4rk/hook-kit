// DecisionObserver — short-circuit when no observers are registered.
//
// Per docs/SPEC.md § Observability:
//   - When `opts.observers === undefined`, engine skips all observer-
//     construction work (no record built, no performance.now() bracketing,
//     no sha256 hash computed).
//   - When `opts.observers === []` (empty array), same.
//   - When `opts.observers === [obs]`, observer fires.
//
// Behavioral observation: the outcome MUST be byte-identical regardless of
// whether observers are registered. Any divergence indicates the observer
// machinery accidentally affected the evaluation.

import { describe, expect, test } from "bun:test";
import { type ask, deny, note, warning } from "../../src/core/decision.js";
import type { Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const event = bashEvent("echo hi");

function ruleOf(kind: string, decision: ReturnType<typeof deny | typeof ask>): Rule {
  return { kind, evaluate: () => decision };
}

describe("observer — short-circuit when no observers registered", () => {
  test("outcome is identical with observers: undefined vs observers: [obs]", async () => {
    const mod = moduleWith([ruleOf("dr", deny("blocked", "lbl"))]);

    const baseline = await evaluate(event, [mod]);
    const withEmpty = await evaluate(event, [mod], { observers: [] });
    const obs = mockObserver();
    const withObs = await evaluate(event, [mod], { observers: [obs] });

    // Byte-identical outcome regardless of observer state.
    expect(baseline).toEqual(withEmpty);
    expect(baseline).toEqual(withObs);

    // Observer fired only in the last call.
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("deny");
  });

  test("observers: undefined → no records (observer never called)", async () => {
    const obs = mockObserver();
    const mod = moduleWith([ruleOf("dr", deny("blocked"))]);

    // Call without observers — observer defined but not passed in.
    await evaluate(event, [mod]);
    expect(obs.records).toEqual([]);

    // Sanity: same observer fires when passed.
    await evaluate(event, [mod], { observers: [obs] });
    expect(obs.records).toHaveLength(1);
  });

  test("observers: [] (empty array) → no observer can fire", async () => {
    // Empty observers array can't fire anything; outcome must remain unaffected.
    const mod = moduleWith([ruleOf("dr", deny("blocked"))]);
    const baseline = await evaluate(event, [mod]);
    const withEmpty = await evaluate(event, [mod], { observers: [] });
    expect(baseline).toEqual(withEmpty);
  });

  test("annotation-only outcome preserved under both observer states", async () => {
    // Observer records are delivered via callback, not on the outcome —
    // so the outcome shape must be byte-identical regardless of observer
    // presence. (A noop observer never mutates outcome.annotations beyond
    // appending error annotations for observer throws.)
    const mod = moduleWith([
      { kind: "w", evaluate: () => warning("be careful") },
      { kind: "n", evaluate: () => note("heads up") },
    ]);

    const baseline = await evaluate(event, [mod]);
    const withObs = await evaluate(event, [mod], { observers: [mockObserver()] });
    expect(baseline).toEqual(withObs);
    expect(baseline.annotations).toHaveLength(2);
  });
});
