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
import type {
  Decision,
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

function captureObserver(): { observer: DecisionObserver; records: DecisionEventRecord[] } {
  const records: DecisionEventRecord[] = [];
  return {
    observer: { onDecision: (r) => records.push(r) },
    records,
  };
}

function moduleWith(id: string, rules: Rule[]): HookModule {
  return { id, name: id, events: ["PreToolUse"], rules };
}

function rule(kind: string, value: Decision | (() => Decision | Promise<Decision>)): Rule {
  return {
    kind,
    evaluate: () => (typeof value === "function" ? value() : value),
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("observer — terminal decisions", () => {
  test("fires once per deny with full record shape", async () => {
    const { observer, records } = captureObserver();
    const mod = moduleWith("m1", [rule("dr", deny("blocked", "test-label"))]);
    await evaluate(event, [mod], { observers: [observer] });

    expect(records).toHaveLength(1);
    const r = records[0];
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
    const { observer, records } = captureObserver();
    const mod = moduleWith("m2", [rule("ar", ask("needs review"))]);
    await evaluate(event, [mod], { observers: [observer] });

    expect(records).toHaveLength(1);
    const r = records[0];
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
    const { observer, records } = captureObserver();
    const mod = moduleWith("m3", [
      rule("first", ask("first ask")),
      rule("second", ask("second ask")),
    ]);
    const outcome = await evaluate(event, [mod], { observers: [observer] });

    expect(outcome.terminal?.kind).toBe("ask");
    expect(outcome.terminal && "reason" in outcome.terminal ? outcome.terminal.reason : "").toBe(
      "first ask",
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.reason).toBe("first ask");
    expect(records[0]?.ruleId).toBe("m3:first:0");
    expect(records[1]?.reason).toBe("second ask");
    expect(records[1]?.ruleId).toBe("m3:second:1");
  });

  test("deny short-circuits — subsequent rules don't fire observers", async () => {
    let secondCalled = false;
    const { observer, records } = captureObserver();
    const mod = moduleWith("m4", [
      rule("blocker", deny("first")),
      rule("after", () => {
        secondCalled = true;
        return null;
      }),
    ]);
    await evaluate(event, [mod], { observers: [observer] });

    expect(secondCalled).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]?.decision).toBe("deny");
  });

  test("ruleId index reflects position in mod.rules array", async () => {
    const { observer, records } = captureObserver();
    const mod = moduleWith("m5", [
      rule("first", null),
      rule("second", null),
      rule("third", ask("third")),
    ]);
    await evaluate(event, [mod], { observers: [observer] });

    expect(records).toHaveLength(1);
    expect(records[0]?.ruleId).toBe("m5:third:2");
  });

  test("timingMs >= 8 for a rule that awaits a setTimeout(., 10)", async () => {
    const { observer, records } = captureObserver();
    const slowRule: Rule = {
      kind: "slow",
      evaluate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return deny("slow-deny");
      },
    };
    const mod = moduleWith("m6", [slowRule]);
    await evaluate(event, [mod], { observers: [observer] });

    expect(records).toHaveLength(1);
    // Allow 2ms slack for scheduler jitter; brief says >= 8.
    expect(records[0]?.timingMs).toBeGreaterThanOrEqual(8);
  });

  test("observers array fires in order", async () => {
    const calls: string[] = [];
    const o1: DecisionObserver = {
      onDecision: () => calls.push("o1"),
    };
    const o2: DecisionObserver = {
      onDecision: () => calls.push("o2"),
    };
    const o3: DecisionObserver = {
      onDecision: () => calls.push("o3"),
    };
    const mod = moduleWith("m7", [rule("dr", deny("blocked"))]);
    await evaluate(event, [mod], { observers: [o1, o2, o3] });

    expect(calls).toEqual(["o1", "o2", "o3"]);
  });

  test("no observers registered → no records (sanity)", async () => {
    const { observer, records } = captureObserver();
    const mod = moduleWith("m8", [rule("dr", deny("blocked"))]);
    // First run without observers
    await evaluate(event, [mod]);
    expect(records).toEqual([]);
    // Then with observers — confirms observers wiring exists
    await evaluate(event, [mod], { observers: [observer] });
    expect(records).toHaveLength(1);
  });
});
