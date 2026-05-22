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
import type { Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const event = bashEvent("echo hi");

function ruleWith(kind: string, value: ReturnType<typeof deny> | ReturnType<typeof ask>): Rule {
  return { kind, evaluate: () => value };
}

describe("observer — throw safety", () => {
  test("throw is caught, error annotation appended, terminal still emitted", async () => {
    // throwOn always-true → every record triggers the throw path.
    const throwing = mockObserver({ throwOn: () => true });
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
    expect(err.message).toContain("mock-observer: throwOn fired");

    // The throwing observer still captured the record (push happens before throw).
    expect(throwing.records).toHaveLength(1);
  });

  test("subsequent observers in the same array still fire", async () => {
    const throwing = mockObserver({ throwOn: () => true });
    const second = mockObserver();
    const third = mockObserver();
    await evaluate(event, [moduleWith([ruleWith("dr", deny("blocked"))])], {
      observers: [throwing, second, third],
    });

    expect(second.records).toHaveLength(1);
    expect(third.records).toHaveLength(1);
  });

  test("multiple throws in same array → one error annotation per throwing observer", async () => {
    const o0 = mockObserver({ throwOn: () => true });
    const o1 = mockObserver({ throwOn: () => true });
    const o2 = mockObserver({ throwOn: () => true });

    const outcome = await evaluate(event, [moduleWith([ruleWith("dr", deny("blocked"))])], {
      observers: [o0, o1, o2],
    });

    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(3);
    expect(errors[0]?.kind === "error" && errors[0].message.includes("index 0")).toBe(true);
    expect(errors[1]?.kind === "error" && errors[1].message.includes("index 1")).toBe(true);
    expect(errors[2]?.kind === "error" && errors[2].message.includes("index 2")).toBe(true);
  });

  test("throwing observer doesn't affect ask terminal accumulation", async () => {
    const throwing = mockObserver({ throwOn: () => true });
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
