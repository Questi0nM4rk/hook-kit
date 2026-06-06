// Engine merge-policy tests.
//
// The engine no longer has a `shortCircuit` knob — merge behavior is
// deterministic and documented in src/engine/index.ts `evaluate()`:
//
//   - deny      → short-circuit, annotations DROPPED, terminal=deny
//   - escalate  → keep evaluating to collect annotations; FIRST escalate
//                 wins terminal, later escalates dropped
//   - warning   → always accumulate
//   - note      → always accumulate
//
// These tests pin the policy so a future refactor can't silently shift it.

import { describe, expect, test } from "bun:test";
import { ask, deny, note, warning } from "../../src/core/decision.js";
import type { Decision, HookEvent, Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// Bespoke command-less Bash event (`toolInput: {}`): these merge-policy tests
// use spy rules that never read the command, and the testing-SDK `bashEvent`
// always populates `{ command }`, so the empty-input shape stays hand-rolled.
const event: HookEvent = {
  eventName: "PreToolUse",
  sessionId: "s1",
  cwd: "/tmp",
  transcriptPath: "/tmp/t.jsonl",
  toolName: "Bash",
  toolInput: {},
  raw: {},
};

function alwaysReturn(value: Decision): Rule {
  return { kind: "spy", evaluate: () => value };
}

describe("evaluate() — deny merge policy", () => {
  test("deny short-circuits immediately", async () => {
    let secondCalled = false;
    const second: Rule = {
      kind: "spy2",
      evaluate: () => {
        secondCalled = true;
        return null;
      },
    };
    const outcome = await evaluate(event, [moduleWith([alwaysReturn(deny("first")), second])]);
    expect(outcome.terminal).toEqual({ kind: "deny", reason: "first" });
    expect(outcome.annotations).toEqual([]);
    expect(secondCalled).toBe(false);
  });

  test("deny DROPS annotations that fired before it", async () => {
    // warning fires first, then deny — outcome must show deny only.
    // (warnings about a command that won't run = noise.)
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(warning("dropped")), alwaysReturn(deny("blocked"))]),
    ]);
    expect(outcome.terminal).toEqual({ kind: "deny", reason: "blocked" });
    expect(outcome.annotations).toEqual([]);
  });

  test("deny short-circuits across modules too", async () => {
    let secondModuleCalled = false;
    const probe: Rule = {
      kind: "probe",
      evaluate: () => {
        secondModuleCalled = true;
        return null;
      },
    };
    await evaluate(event, [moduleWith([alwaysReturn(deny("blocked"))]), moduleWith([probe])]);
    expect(secondModuleCalled).toBe(false);
  });
});

describe("evaluate() — escalate merge policy", () => {
  test("escalate does NOT short-circuit — annotations continue accumulating", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(ask("ask")), alwaysReturn(warning("after-escalate"))]),
    ]);
    expect(outcome.terminal).toEqual({ kind: "ask", reason: "ask" });
    expect(outcome.annotations).toEqual([{ kind: "warning", message: "after-escalate" }]);
  });

  test("FIRST escalate wins terminal; later escalates dropped", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(ask("first")), alwaysReturn(ask("second"))]),
    ]);
    expect(outcome.terminal).toEqual({ kind: "ask", reason: "first" });
  });

  test("escalate then deny → deny still wins (deny is highest)", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(ask("ask")), alwaysReturn(deny("blocked"))]),
    ]);
    expect(outcome.terminal).toEqual({ kind: "deny", reason: "blocked" });
    expect(outcome.annotations).toEqual([]);
  });

  test("annotations fired before escalate are bundled with it", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(warning("before")), alwaysReturn(ask("ask"))]),
    ]);
    expect(outcome.terminal).toEqual({ kind: "ask", reason: "ask" });
    expect(outcome.annotations).toEqual([{ kind: "warning", message: "before" }]);
  });
});

describe("evaluate() — annotation-only merge policy", () => {
  test("multiple warnings accumulate in encounter order", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(warning("a")), alwaysReturn(warning("b"))]),
    ]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([
      { kind: "warning", message: "a" },
      { kind: "warning", message: "b" },
    ]);
  });

  test("mixed warnings + notes accumulate in order, kinds preserved", async () => {
    const outcome = await evaluate(event, [
      moduleWith([
        alwaysReturn(warning("danger", "[w]")),
        alwaysReturn(note("fyi", "[n]")),
        alwaysReturn(warning("more", "[w2]")),
      ]),
    ]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([
      { kind: "warning", message: "danger", label: "[w]" },
      { kind: "note", message: "fyi", label: "[n]" },
      { kind: "warning", message: "more", label: "[w2]" },
    ]);
  });

  test("annotations accumulate across modules", async () => {
    const outcome = await evaluate(event, [
      moduleWith([alwaysReturn(warning("from m1"))]),
      moduleWith([alwaysReturn(note("from m2"))]),
    ]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([
      { kind: "warning", message: "from m1" },
      { kind: "note", message: "from m2" },
    ]);
  });

  test("no rules fire → silent outcome", async () => {
    const outcome = await evaluate(event, [moduleWith([alwaysReturn(null)])]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });
});
