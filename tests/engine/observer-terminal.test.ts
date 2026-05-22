// biome-ignore-all lint/style/noMagicNumbers: tests use small literal counts and a 10ms setTimeout / 8ms timing-floor where extracting named constants obscures the test intent.
// DecisionObserver — terminal-decision firing semantics.
//
// Pins the contract per docs/SPEC.md § Observability:
//   - Observer fires once per terminal decision (deny / ask).
//   - Observer fires per RULE-PRODUCED terminal even when the merge policy
//     drops the terminal from the outcome (e.g., second ask after the first
//     ask was taken). Rationale: observability surfaces all rule decisions,
//     not just outcome-affecting ones. Merge policy is an OUTCOME concern;
//     observers are a DECISION concern.
//   - record.ruleId is "<module.id>:<rule.kind>:<rule-index-in-module>".
//   - record.event.toolInputHash is 64-char lowercase hex.
//   - record.timingMs reflects performance.now() bracketing of rule.evaluate().

import { describe, expect, test } from "bun:test";
import { ask, deny } from "../../src/core/decision.js";
import type { Decision, DecisionObserver, Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const event = bashEvent("echo hi");

function rule(kind: string, value: Decision | (() => Decision | Promise<Decision>)): Rule {
  return {
    kind,
    evaluate: () => (typeof value === "function" ? value() : value),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("observer — terminal decisions", () => {
  test("fires once per deny with full record shape", async () => {
    const obs = mockObserver();
    const mod = moduleWith([rule("dr", deny("blocked", "test-label"))], "m1");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("deny");
    expect(r.reason).toBe("blocked");
    expect(r.label).toBe("test-label");
    expect(r.ruleId).toBe("m1:dr:0");
    expect(r.ruleKind).toBe("dr");
    expect(r.event.eventName).toBe("PreToolUse");
    expect(r.event.toolName).toBe("Bash");
    expect(r.event.cwd).toBe("/tmp");
    expect(r.event.sessionId).toBe("s1");
    expect(r.event.toolInputHash).toMatch(HEX64);
    expect(r.timestamp).toBeGreaterThan(0);
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
  });

  test("fires once per ask with full record shape", async () => {
    const obs = mockObserver();
    const mod = moduleWith([rule("ar", ask("needs review"))], "m2");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("ask");
    expect(r.reason).toBe("needs review");
    expect(r.label).toBeUndefined();
    expect(r.ruleId).toBe("m2:ar:0");
  });

  test("fires per rule-produced terminal even when merge policy drops it", async () => {
    // First ask wins terminal; second ask is dropped from outcome.terminal.
    // Observer should still fire for both — observability is per-decision.
    const obs = mockObserver();
    const mod = moduleWith(
      [rule("first", ask("first ask")), rule("second", ask("second ask"))],
      "m3",
    );
    const outcome = await evaluate(event, [mod], { observers: [obs] });

    expect(outcome.terminal?.kind).toBe("ask");
    expect(outcome.terminal && "reason" in outcome.terminal ? outcome.terminal.reason : "").toBe(
      "first ask",
    );
    expect(obs.records).toHaveLength(2);
    expect(obs.records[0]?.reason).toBe("first ask");
    expect(obs.records[0]?.ruleId).toBe("m3:first:0");
    expect(obs.records[1]?.reason).toBe("second ask");
    expect(obs.records[1]?.ruleId).toBe("m3:second:1");
  });

  test("deny short-circuits — subsequent rules don't fire observers", async () => {
    let secondCalled = false;
    const obs = mockObserver();
    const mod = moduleWith(
      [
        rule("blocker", deny("first")),
        rule("after", () => {
          secondCalled = true;
          return null;
        }),
      ],
      "m4",
    );
    await evaluate(event, [mod], { observers: [obs] });

    expect(secondCalled).toBe(false);
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("deny");
  });

  test("ruleId index reflects position in mod.rules array", async () => {
    const obs = mockObserver();
    const mod = moduleWith(
      [rule("first", null), rule("second", null), rule("third", ask("third"))],
      "m5",
    );
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.ruleId).toBe("m5:third:2");
  });

  test("timingMs >= 8 for a rule that awaits a setTimeout(., 10)", async () => {
    const obs = mockObserver();
    const slowRule: Rule = {
      kind: "slow",
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return deny("slow-deny");
      },
    };
    const mod = moduleWith([slowRule], "m6");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    // Allow 2ms slack for scheduler jitter; brief says >= 8.
    expect(obs.records[0]?.timingMs).toBeGreaterThanOrEqual(8);
  });

  test("observers array fires in order", async () => {
    const calls: string[] = [];
    const o1: DecisionObserver = { onDecision: () => calls.push("o1") };
    const o2: DecisionObserver = { onDecision: () => calls.push("o2") };
    const o3: DecisionObserver = { onDecision: () => calls.push("o3") };
    const mod = moduleWith([rule("dr", deny("blocked"))], "m7");
    await evaluate(event, [mod], { observers: [o1, o2, o3] });

    expect(calls).toEqual(["o1", "o2", "o3"]);
  });

  test("no observers registered → no records (sanity)", async () => {
    const obs = mockObserver();
    const mod = moduleWith([rule("dr", deny("blocked"))], "m8");
    // First run without observers
    await evaluate(event, [mod]);
    expect(obs.records).toEqual([]);
    // Then with observers — confirms observers wiring exists
    await evaluate(event, [mod], { observers: [obs] });
    expect(obs.records).toHaveLength(1);
  });
});
