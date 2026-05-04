import { describe, expect, test } from "bun:test";
import { context, deny } from "../../src/core/decision.js";
import type { HookEvent, HookModule, Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";

const event: HookEvent = {
  eventName: "PreToolUse",
  sessionId: "s1",
  cwd: "/tmp",
  transcriptPath: "/tmp/t.jsonl",
  toolName: "Bash",
  toolInput: {},
  raw: {},
};

function alwaysReturn(value: ReturnType<typeof deny> | ReturnType<typeof context> | null): Rule {
  return {
    kind: "spy",
    evaluate: () => value,
  };
}

function moduleWith(rules: Rule[]): HookModule {
  return { id: "m", name: "test", events: ["PreToolUse"], rules };
}

describe("evaluate() — shortCircuit semantics", () => {
  test("short-circuits on first deny by default", async () => {
    let secondCalled = false;
    const second: Rule = {
      kind: "spy2",
      evaluate: () => {
        secondCalled = true;
        return null;
      },
    };
    const d = await evaluate(event, [moduleWith([alwaysReturn(deny("first")), second])]);
    expect(d).toEqual({ kind: "deny", reason: "first" });
    expect(secondCalled).toBe(false);
  });

  test("short-circuits on first escalate by default", async () => {
    let secondCalled = false;
    const second: Rule = {
      kind: "spy2",
      evaluate: () => {
        secondCalled = true;
        return null;
      },
    };
    const d = await evaluate(event, [
      moduleWith([{ kind: "esc", evaluate: () => ({ kind: "escalate", reason: "ask" }) }, second]),
    ]);
    expect(d).toEqual({ kind: "escalate", reason: "ask" });
    expect(secondCalled).toBe(false);
  });

  test("with shortCircuit=false: continues evaluating after first deny", async () => {
    let secondCalled = false;
    const second: Rule = {
      kind: "spy2",
      evaluate: () => {
        secondCalled = true;
        return null;
      },
    };
    await evaluate(event, [moduleWith([alwaysReturn(deny("first")), second])], {
      shortCircuit: false,
    });
    expect(secondCalled).toBe(true);
  });

  test("with shortCircuit=false: first terminal still wins over later terminals", async () => {
    const d = await evaluate(
      event,
      [moduleWith([alwaysReturn(deny("first")), alwaysReturn(deny("second"))])],
      { shortCircuit: false },
    );
    expect(d).toEqual({ kind: "deny", reason: "first" });
  });

  test("with shortCircuit=false: terminal wins over later context", async () => {
    const d = await evaluate(
      event,
      [moduleWith([alwaysReturn(deny("first")), alwaysReturn(context("info"))])],
      { shortCircuit: false },
    );
    expect(d).toEqual({ kind: "deny", reason: "first" });
  });

  test("with shortCircuit=false: earlier context still accumulates if no terminal fires", async () => {
    const d = await evaluate(
      event,
      [moduleWith([alwaysReturn(context("a")), alwaysReturn(context("b"))])],
      { shortCircuit: false },
    );
    expect(d).toEqual({ kind: "context", message: "a\n\nb" });
  });

  test("with shortCircuit=false: continues across modules after a terminal", async () => {
    let secondModuleCalled = false;
    const probe: Rule = {
      kind: "probe",
      evaluate: () => {
        secondModuleCalled = true;
        return null;
      },
    };
    await evaluate(event, [moduleWith([alwaysReturn(deny("first"))]), moduleWith([probe])], {
      shortCircuit: false,
    });
    expect(secondModuleCalled).toBe(true);
  });
});
