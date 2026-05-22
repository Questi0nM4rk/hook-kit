// biome-ignore-all lint/style/noMagicNumbers: tests use small literal counts (record lengths, annotation indices) where extracting to constants obscures the test intent.
// DecisionObserver — annotation-decision firing semantics.
//
// Per docs/SPEC.md § Observability:
//   - Observer fires per warning annotation with decision="warning".
//   - Observer fires per note annotation with decision="note".
//   - Observer fires per error annotation (engine-produced from rule throw,
//     from state.flush failure, or from drainContextErrors) with
//     decision="error". For engine-emitted errors with no rule context,
//     ruleId uses the synthetic "<engine>:<source>" prefix and timingMs=0.
//
// The drainContextErrors / shell-ast parse-error path is not exercised here
// because forcing a ShellAstParseError requires mocking shell-ast's WASM
// parse (a `tests-isolated/` job — `mock.module` is process-sticky). The
// synthetic-ruleId contract (`<engine>:<source>` + timingMs=0) IS exercised
// via the state-flush path below; the drain path uses the same
// `notifyEngineError` helper with `source="shell-ast"`.

import { describe, expect, test } from "bun:test";
import { note, warning } from "../../src/core/decision.js";
import { FileReadError, StateStoreError } from "../../src/core/errors.js";
import type { Rule, StateStore } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const event = bashEvent("echo hi");

describe("observer — annotation decisions", () => {
  test("fires per warning annotation with decision='warning'", async () => {
    const obs = mockObserver();
    const mod = moduleWith([{ kind: "wr", evaluate: () => warning("be careful", "wlabel") }], "m1");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("warning");
    expect(r.reason).toBe("be careful");
    expect(r.label).toBe("wlabel");
    expect(r.ruleId).toBe("m1:wr:0");
    expect(r.ruleKind).toBe("wr");
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
  });

  test("fires per note annotation with decision='note'", async () => {
    const obs = mockObserver();
    const mod = moduleWith([{ kind: "nr", evaluate: () => note("heads up") }], "m2");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("note");
    expect(r.reason).toBe("heads up");
    expect(r.label).toBeUndefined();
  });

  test("multiple warnings + notes fire observer per annotation, in encounter order", async () => {
    const obs = mockObserver();
    const mod = moduleWith(
      [
        { kind: "w1", evaluate: () => warning("first") },
        { kind: "n1", evaluate: () => note("second") },
        { kind: "w2", evaluate: () => warning("third") },
      ],
      "m3",
    );
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(3);
    expect(obs.records.map((r) => r.decision)).toEqual(["warning", "note", "warning"]);
    expect(obs.records.map((r) => r.reason)).toEqual(["first", "second", "third"]);
    expect(obs.records.map((r) => r.ruleId)).toEqual(["m3:w1:0", "m3:n1:1", "m3:w2:2"]);
  });

  test("fires per error annotation produced from a rule throw", async () => {
    const obs = mockObserver();
    const throwingRule: Rule = {
      kind: "throw",
      evaluate: () => {
        throw new FileReadError("/tmp/missing", new Error("ENOENT"));
      },
    };
    const mod = moduleWith([throwingRule], "m4");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("error");
    expect(r.reason).toContain("/tmp/missing");
    // Rule-throw error records DO have rule context (came from rule.evaluate).
    expect(r.ruleId).toBe("m4:throw:0");
    expect(r.ruleKind).toBe("throw");
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
  });

  test("fires per error annotation produced from state.flush failure (synthetic ruleId)", async () => {
    const obs = mockObserver();
    // Throwing state store: flush throws, engine wraps to StateStoreError,
    // appends to annotations, AND fires an observer record.
    const throwingState: StateStore = {
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      flush: () => {
        throw new Error("disk full");
      },
    };
    const mod = moduleWith([], "m5");
    const outcome = await evaluate(event, [mod], { observers: [obs], state: throwingState });

    // One error annotation on the outcome.
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(1);
    // One observer record for the error annotation.
    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("error");
    expect(r.reason).toContain("flush");
    // Engine-emitted errors use synthetic ruleId/ruleKind and timingMs=0.
    expect(r.ruleId).toBe("<engine>:state-flush");
    expect(r.ruleKind).toBe("state-flush");
    expect(r.timingMs).toBe(0);
  });

  test("passthrough of pre-typed StateStoreError still fires observer", async () => {
    const obs = mockObserver();
    const throwingState: StateStore = {
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      flush: () => {
        // Already-typed HookKitError passes through unwrapped.
        throw new StateStoreError("flush", undefined, new Error("io-fail"));
      },
    };
    const mod = moduleWith([], "m6");
    await evaluate(event, [mod], { observers: [obs], state: throwingState });

    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("error");
    expect(obs.records[0]?.ruleId).toBe("<engine>:state-flush");
  });

  test("warning+ask order: ask terminal fires, then later warning also fires", async () => {
    // Mixed-decision module: ask wins terminal, subsequent warning still
    // fires the observer (annotations are accumulated post-ask, and
    // observers fire per decision regardless of merge outcome).
    const obs = mockObserver();
    const mod = moduleWith(
      [
        { kind: "ar", evaluate: () => ({ kind: "ask", reason: "review" }) },
        { kind: "wr", evaluate: () => warning("post-ask warning") },
      ],
      "m7",
    );
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(2);
    expect(obs.records[0]?.decision).toBe("ask");
    expect(obs.records[1]?.decision).toBe("warning");
  });

  test("deny short-circuit DROPS warnings from outcome but observer still saw them", async () => {
    // Warning fires first → observer sees it. Then deny fires → observer
    // sees the deny. Outcome.annotations is filtered to keep only error
    // annotations; the warning gets dropped from the outcome. Observer
    // received both records — that's the point of observability.
    const obs = mockObserver();
    const mod = moduleWith(
      [
        { kind: "wr", evaluate: () => warning("before deny") },
        { kind: "dr", evaluate: () => ({ kind: "deny", reason: "blocked" }) },
      ],
      "m8",
    );
    const outcome = await evaluate(event, [mod], { observers: [obs] });

    expect(outcome.annotations).toHaveLength(0);
    expect(obs.records).toHaveLength(2);
    expect(obs.records[0]?.decision).toBe("warning");
    expect(obs.records[1]?.decision).toBe("deny");
  });
});
