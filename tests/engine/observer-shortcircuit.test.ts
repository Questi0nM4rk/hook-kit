// DecisionObserver — short-circuit when no observers are registered.
//
// Per TASK-020 and docs/SPEC.md § Observability:
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
import type {
  DecisionEventRecord,
  DecisionObserver,
  HookEvent,
  HookModule,
  Rule,
} from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";

const event: HookEvent = {
  eventName: "PreToolUse",
  sessionId: "s1",
  cwd: "/tmp",
  transcriptPath: "/tmp/t.jsonl",
  toolName: "Bash",
  toolInput: { command: "echo hi" },
  raw: {},
};

function moduleWith(rules: Rule[]): HookModule {
  return { id: "m", name: "test", events: ["PreToolUse"], rules };
}

function ruleOf(kind: string, decision: ReturnType<typeof deny | typeof ask>): Rule {
  return { kind, evaluate: () => decision };
}

describe("observer — short-circuit when no observers registered", () => {
  test("outcome is identical with observers: undefined vs observers: [obs]", async () => {
    const mod = moduleWith([ruleOf("dr", deny("blocked", "lbl"))]);

    const baseline = await evaluate(event, [mod]);
    const withEmpty = await evaluate(event, [mod], { observers: [] });
    const records: DecisionEventRecord[] = [];
    const observer: DecisionObserver = { onDecision: (r) => records.push(r) };
    const withObs = await evaluate(event, [mod], { observers: [observer] });

    // Byte-identical outcome regardless of observer state.
    expect(baseline).toEqual(withEmpty);
    expect(baseline).toEqual(withObs);

    // Observer fired only in the last call.
    expect(records).toHaveLength(1);
    expect(records[0]?.decision).toBe("deny");
  });

  test("observers: undefined → no records (observer never called)", async () => {
    const records: DecisionEventRecord[] = [];
    const observer: DecisionObserver = { onDecision: (r) => records.push(r) };
    const mod = moduleWith([ruleOf("dr", deny("blocked"))]);

    // Call without observers — must NOT trigger the observer that's defined
    // in the closure but not passed in.
    await evaluate(event, [mod]);
    expect(records).toEqual([]);

    // Sanity: same observer fires when passed.
    await evaluate(event, [mod], { observers: [observer] });
    expect(records).toHaveLength(1);
  });

  test("observers: [] (empty array) → no observer can fire", async () => {
    // Empty observers array can't fire anything; outcome must remain unaffected.
    const mod = moduleWith([ruleOf("dr", deny("blocked"))]);
    const baseline = await evaluate(event, [mod]);
    const withEmpty = await evaluate(event, [mod], { observers: [] });
    expect(baseline).toEqual(withEmpty);
  });

  test("annotation-only outcome preserved under both observer states", async () => {
    // Pre-TASK-016: annotation observer firing isn't wired yet, so the
    // observers array sees no records for warning/note decisions. The
    // OUTCOME shape must still be identical.
    const mod = moduleWith([
      { kind: "w", evaluate: () => warning("be careful") },
      { kind: "n", evaluate: () => note("heads up") },
    ]);

    const baseline = await evaluate(event, [mod]);
    const withObs = await evaluate(event, [mod], {
      observers: [{ onDecision: () => undefined }],
    });
    expect(baseline).toEqual(withObs);
    expect(baseline.annotations).toHaveLength(2);
  });
});
