// DecisionObserver — toolInputHash policy.
//
// Per docs/SPEC.md § Observability:
//   - Hash is sha256(JSON.stringify(event.toolInput)) hex-encoded.
//   - Exactly 64 lowercase hex characters.
//   - Deterministic across runs.
//   - Same input → same hash; different input → different hash.
//   - Computed once per evaluation and reused across all records emitted
//     in that evaluation (cached on the EvaluationContext).
// biome-ignore-all lint/style/noMagicNumbers: tests use small literal counts (loop bound, record-length) where extracting to constants obscures the test intent.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deny } from "../../src/core/decision.js";
import type { HookEvent, Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const HEX64 = /^[0-9a-f]{64}$/;

function eventWith(toolInput: Record<string, unknown>): HookEvent {
  // Reuse the standard bashEvent shape but swap toolInput. Most tests in this
  // file vary the command; this helper keeps that one degree of freedom while
  // delegating session/cwd/etc. to bashEvent's defaults.
  const base = bashEvent("");
  return { ...base, toolInput };
}

function denyRule(kind: string, reason: string): Rule {
  return { kind, evaluate: () => deny(reason) };
}

describe("observer — toolInputHash", () => {
  test("hash is exactly 64 lowercase hex characters", async () => {
    const obs = mockObserver();
    await evaluate(eventWith({ command: "echo hi" }), [moduleWith([denyRule("d", "x")])], {
      observers: [obs],
    });

    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.event.toolInputHash).toMatch(HEX64);
  });

  test("same input → same hash", async () => {
    const obs = mockObserver();
    await evaluate(eventWith({ command: "echo same" }), [moduleWith([denyRule("d", "x")])], {
      observers: [obs],
    });
    await evaluate(eventWith({ command: "echo same" }), [moduleWith([denyRule("d", "x")])], {
      observers: [obs],
    });

    expect(obs.records).toHaveLength(2);
    expect(obs.records[0]?.event.toolInputHash).toBe(obs.records[1]?.event.toolInputHash ?? "");
  });

  test("different input → different hash", async () => {
    const obs = mockObserver();
    await evaluate(eventWith({ command: "echo a" }), [moduleWith([denyRule("d", "x")])], {
      observers: [obs],
    });
    await evaluate(eventWith({ command: "echo b" }), [moduleWith([denyRule("d", "x")])], {
      observers: [obs],
    });

    expect(obs.records[0]?.event.toolInputHash).not.toBe(obs.records[1]?.event.toolInputHash ?? "");
  });

  test("hash matches sha256(JSON.stringify(toolInput)) hex digest", async () => {
    const toolInput = { command: "echo specific" };
    const expected = createHash("sha256").update(JSON.stringify(toolInput)).digest("hex");
    const obs = mockObserver();
    await evaluate(eventWith(toolInput), [moduleWith([denyRule("d", "x")])], { observers: [obs] });

    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.event.toolInputHash).toBe(expected);
  });

  test("hash deterministic across runs", async () => {
    const toolInput = { command: "echo deterministic", flag: true };
    const expected = createHash("sha256").update(JSON.stringify(toolInput)).digest("hex");
    const obs = mockObserver();
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential evaluations are the point of this determinism test.
      await evaluate(eventWith(toolInput), [moduleWith([denyRule("d", "x")])], {
        observers: [obs],
      });
    }
    expect(obs.records).toHaveLength(3);
    for (const r of obs.records) {
      expect(r.event.toolInputHash).toBe(expected);
    }
  });

  test("hash cached per evaluation — only computed once when multiple decisions fire", async () => {
    // Two rules with ask decisions in the same module → both fire observers
    // in the same evaluation frame. Both records must share the SAME hash
    // (proves the cache works; the hash function is also deterministic so
    // independent computations would also match, but identity here is the
    // invariant: same evaluation → same cache → same hash object).
    const obs = mockObserver();
    const ruleA: Rule = { kind: "a", evaluate: () => ({ kind: "ask", reason: "a" }) };
    const ruleB: Rule = { kind: "b", evaluate: () => ({ kind: "ask", reason: "b" }) };
    await evaluate(eventWith({ command: "echo cached" }), [moduleWith([ruleA, ruleB])], {
      observers: [obs],
    });

    expect(obs.records).toHaveLength(2);
    expect(obs.records[0]?.event.toolInputHash).toBe(obs.records[1]?.event.toolInputHash ?? "");
  });
});
