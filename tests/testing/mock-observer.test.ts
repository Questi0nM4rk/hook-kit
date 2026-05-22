// biome-ignore-all lint/style/noMagicNumbers: small literal counts in record-length expectations.
import { describe, expect, test } from "bun:test";
import { deny, warning } from "../../src/core/decision.js";
import type { DecisionEventRecord, Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const event = bashEvent("echo hi");

function denyRule(kind: string, reason: string): Rule {
  return { kind, evaluate: () => deny(reason) };
}

describe("mockObserver", () => {
  test("captures every record passed to onDecision", async () => {
    const obs = mockObserver();
    const mod = moduleWith(
      [
        { kind: "wr", evaluate: () => warning("first") },
        { kind: "wr2", evaluate: () => warning("second") },
        denyRule("dr", "blocked"),
      ],
      "m1",
    );
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(3);
    expect(obs.records.map((r) => r.decision)).toEqual(["warning", "warning", "deny"]);
  });

  test("records is empty when no decisions emitted", async () => {
    const obs = mockObserver();
    const mod = moduleWith([{ kind: "nullr", evaluate: () => null }], "m2");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toEqual([]);
  });

  test("throwOn predicate triggers throw inside onDecision", async () => {
    // throwOn fires on the second record only; first survives unimpacted,
    // second is caught by the engine and surfaces as an ObserverError.
    let seen = 0;
    const obs = mockObserver({
      throwOn: (r: DecisionEventRecord): boolean => {
        seen += 1;
        return r.decision === "deny";
      },
    });
    const mod = moduleWith(
      [{ kind: "wr", evaluate: () => warning("ok") }, denyRule("dr", "blocked")],
      "m3",
    );
    const outcome = await evaluate(event, [mod], { observers: [obs] });

    // Both records captured (push happens before the throw check).
    expect(obs.records).toHaveLength(2);
    expect(seen).toBe(2);
    // One ObserverError annotation on the outcome — from the deny record.
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind === "error" && errors[0].errorCode).toBe("ObserverError");
    // Terminal deny survives.
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("throwOn defaults to never-throw", async () => {
    const obs = mockObserver();
    const mod = moduleWith([denyRule("dr", "blocked")], "m4");
    const outcome = await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    expect(outcome.annotations).toHaveLength(0);
  });

  test("reset() clears records in place (preserves array identity)", async () => {
    const obs = mockObserver();
    const mod = moduleWith([denyRule("dr", "blocked")], "m5");
    await evaluate(event, [mod], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    const arrayRef = obs.records;
    obs.reset();
    expect(obs.records).toEqual([]);
    expect(obs.records).toBe(arrayRef); // identity preserved
  });

  test("fresh instance per call — no shared state", async () => {
    const o1 = mockObserver();
    const o2 = mockObserver();
    const mod = moduleWith([denyRule("dr", "blocked")], "m6");
    await evaluate(event, [mod], { observers: [o1] });

    expect(o1.records).toHaveLength(1);
    expect(o2.records).toEqual([]);
  });

  test("re-exported from @questi0nm4rk/hook-kit/testing barrel", async () => {
    // Import via the subpath exporter to confirm wiring.
    const { mockObserver: barrelMockObserver } = await import("../../src/testing/index.js");
    const obs = barrelMockObserver();
    const mod = moduleWith([denyRule("dr", "blocked")], "m7");
    await evaluate(event, [mod], { observers: [obs] });
    expect(obs.records).toHaveLength(1);
  });
});
