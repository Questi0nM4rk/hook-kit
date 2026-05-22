// biome-ignore-all lint/style/noMagicNumbers: tests use small literal counts for record/error-annotation lengths where extracting to constants obscures the test intent.
// DecisionObserver — throw-safety contract.
//
// Per docs/SPEC.md § Observability:
//   - Observer throws are CAUGHT at the engine boundary.
//   - The engine appends an `error` annotation to the outcome describing the
//     failed observer (ObserverError, includes observer index).
//   - The decision proceeds — terminal / annotation flow unaffected.
//   - Subsequent observers in the same array still fire.

import { describe, expect, test } from "bun:test";
import { ask, deny } from "../../src/core/decision.js";
import type { DecisionObserver, HookEvent, HookModule, Rule } from "../../src/core/types.js";
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

function ruleWith(kind: string, value: ReturnType<typeof deny> | ReturnType<typeof ask>): Rule {
  return { kind, evaluate: () => value };
}

function moduleWith(rules: Rule[]): HookModule {
  return { id: "m", name: "test", events: ["PreToolUse"], rules };
}

describe("observer — throw safety", () => {
  test("throw is caught, error annotation appended, terminal still emitted", async () => {
    const throwing: DecisionObserver = {
      onDecision: () => {
        throw new Error("observer-boom");
      },
    };
    const outcome = await evaluate(event, [moduleWith([ruleWith("dr", deny("blocked"))])], {
      observers: [throwing],
    });

    // Terminal preserved.
    expect(outcome.terminal?.kind).toBe("deny");
    expect(outcome.terminal && "reason" in outcome.terminal ? outcome.terminal.reason : "").toBe(
      "blocked",
    );

    // Error annotation describes the failed observer.
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (err?.kind !== "error") {
      throw new Error("expected error annotation");
    }
    expect(err.errorCode).toBe("ObserverError");
    expect(err.message).toContain("observer at index 0");
    expect(err.message).toContain("observer-boom");
  });

  test("subsequent observers in the same array still fire", async () => {
    let secondFired = false;
    let thirdFired = false;
    const throwing: DecisionObserver = {
      onDecision: () => {
        throw new Error("o1-boom");
      },
    };
    const second: DecisionObserver = {
      onDecision: () => {
        secondFired = true;
      },
    };
    const third: DecisionObserver = {
      onDecision: () => {
        thirdFired = true;
      },
    };
    await evaluate(event, [moduleWith([ruleWith("dr", deny("blocked"))])], {
      observers: [throwing, second, third],
    });

    expect(secondFired).toBe(true);
    expect(thirdFired).toBe(true);
  });

  test("multiple throws in same array → one error annotation per throwing observer", async () => {
    const throwAtIndex = (idx: string): DecisionObserver => ({
      onDecision: () => {
        throw new Error(`boom-${idx}`);
      },
    });

    const outcome = await evaluate(event, [moduleWith([ruleWith("dr", deny("blocked"))])], {
      observers: [throwAtIndex("0"), throwAtIndex("1"), throwAtIndex("2")],
    });

    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(3);
    expect(errors[0]?.kind === "error" && errors[0].message.includes("index 0")).toBe(true);
    expect(errors[1]?.kind === "error" && errors[1].message.includes("index 1")).toBe(true);
    expect(errors[2]?.kind === "error" && errors[2].message.includes("index 2")).toBe(true);
  });

  test("throwing observer doesn't affect ask terminal accumulation", async () => {
    const throwing: DecisionObserver = {
      onDecision: () => {
        throw new Error("boom");
      },
    };
    const outcome = await evaluate(
      event,
      [moduleWith([ruleWith("first", ask("first")), ruleWith("second", ask("second"))])],
      { observers: [throwing] },
    );

    // First ask wins, merge policy unaffected.
    expect(outcome.terminal?.kind).toBe("ask");
    expect(outcome.terminal && "reason" in outcome.terminal ? outcome.terminal.reason : "").toBe(
      "first",
    );
    // 2 error annotations (one per ask × one throwing observer).
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(2);
  });
});
