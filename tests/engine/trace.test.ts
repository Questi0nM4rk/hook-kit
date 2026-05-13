// Regression for BUG-005: HOOK_KIT_VERBOSE used to produce no trace under
// the shell-wrapper path because trace logic lived inside run.ts only.
// trace.ts is now shared; both run() and runShell() delegate to emitVerbose,
// so testing the trace module covers both call sites.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Annotation, EvaluationOutcome, HookEvent, Terminal } from "../../src/core/types.js";
import { emitVerbose, isVerbose, traceLine } from "../../src/engine/trace.js";
import { bashEvent, captureStderr, withEnv } from "../_helpers.js";

function makeEvent(partial: Partial<HookEvent> = {}): HookEvent {
  return { ...bashEvent("rm foo"), ...partial };
}

function outcome(
  terminal: Terminal | null,
  annotations: readonly Annotation[] = [],
): EvaluationOutcome {
  return { terminal, annotations };
}

const SILENT: EvaluationOutcome = outcome(null);

describe("engine/trace — isVerbose()", () => {
  test("returns true for HOOK_KIT_VERBOSE=1", () => {
    withEnv("HOOK_KIT_VERBOSE", "1", () => expect(isVerbose()).toBe(true));
  });

  test("returns true for HOOK_KIT_VERBOSE=true", () => {
    withEnv("HOOK_KIT_VERBOSE", "true", () => expect(isVerbose()).toBe(true));
  });

  test("returns false when unset", () => {
    withEnv("HOOK_KIT_VERBOSE", undefined, () => expect(isVerbose()).toBe(false));
  });

  test("returns false for HOOK_KIT_VERBOSE=0", () => {
    withEnv("HOOK_KIT_VERBOSE", "0", () => expect(isVerbose()).toBe(false));
  });
});

describe("engine/trace — traceLine() formatting", () => {
  test("formats a silent outcome (no terminal, no annotations)", () => {
    const line = traceLine(makeEvent(), SILENT, 3, 17);
    expect(line).toBe(
      "[hook-kit] event=PreToolUse tool=Bash session=s1 modules=3 → null time=17ms\n",
    );
  });

  test("formats a deny outcome with label and reason", () => {
    const out = outcome({ kind: "deny", reason: "blocked", label: "[my-rule]" });
    const line = traceLine(makeEvent(), out, 2, 5);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=2 → deny label=[my-rule] reason="blocked" time=5ms\n',
    );
  });

  test("formats an escalate outcome without a label", () => {
    const out = outcome({ kind: "escalate", reason: "needs review" });
    const line = traceLine(makeEvent(), out, 1, 8);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=1 → escalate reason="needs review" time=8ms\n',
    );
  });

  test("formats an annotation-only outcome (no terminal)", () => {
    const out = outcome(null, [{ kind: "warning", message: "fyi" }]);
    const line = traceLine(makeEvent(), out, 1, 1);
    expect(line).toBe(
      "[hook-kit] event=PreToolUse tool=Bash session=s1 modules=1 → annotate annotations=1 time=1ms\n",
    );
  });

  test("annotations count is appended when present alongside a terminal", () => {
    const out = outcome({ kind: "escalate", reason: "ask" }, [
      { kind: "warning", message: "a" },
      { kind: "note", message: "b" },
    ]);
    const line = traceLine(makeEvent(), out, 1, 2);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=1 → escalate reason="ask" annotations=2 time=2ms\n',
    );
  });
});

describe("engine/trace — emitVerbose()", () => {
  let captured: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    captured = captureStderr();
  });
  afterEach(() => {
    captured.restore();
  });

  test("writes a trace line to stderr when HOOK_KIT_VERBOSE=1", () => {
    withEnv("HOOK_KIT_VERBOSE", "1", () => {
      emitVerbose(makeEvent(), SILENT, 1, 4);
    });
    expect(captured.output()).toContain("[hook-kit] event=PreToolUse");
    expect(captured.output()).toContain("→ null time=4ms");
  });

  test("is a no-op when HOOK_KIT_VERBOSE is unset", () => {
    withEnv("HOOK_KIT_VERBOSE", undefined, () => {
      emitVerbose(makeEvent(), outcome({ kind: "deny", reason: "x" }), 1, 1);
    });
    expect(captured.output()).toBe("");
  });
});
