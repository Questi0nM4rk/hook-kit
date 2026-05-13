// Regression for BUG-005: HOOK_KIT_VERBOSE used to produce no trace under
// the shell-wrapper path because trace logic lived inside run.ts only.
// trace.ts is now shared; both run() and runShell() delegate to emitVerbose,
// so testing the trace module covers both call sites.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Decision, HookEvent } from "../../src/core/types.js";
import { emitVerbose, isVerbose, traceLine } from "../../src/engine/trace.js";
import { bashEvent, captureStderr, withEnv } from "../_helpers.js";

function makeEvent(partial: Partial<HookEvent> = {}): HookEvent {
  return { ...bashEvent("rm foo"), ...partial };
}

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
  test("formats a null decision", () => {
    const line = traceLine(makeEvent(), null, 3, 17);
    expect(line).toBe(
      "[hook-kit] event=PreToolUse tool=Bash session=s1 modules=3 → null time=17ms\n",
    );
  });

  test("formats a deny decision with label and reason", () => {
    const decision: Decision = { kind: "deny", reason: "blocked", label: "[my-rule]" };
    const line = traceLine(makeEvent(), decision, 2, 5);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=2 → deny label=[my-rule] reason="blocked" time=5ms\n',
    );
  });

  test("formats an escalate decision without a label", () => {
    const decision: Decision = { kind: "escalate", reason: "needs review" };
    const line = traceLine(makeEvent(), decision, 1, 8);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=1 → escalate reason="needs review" time=8ms\n',
    );
  });

  test("formats a context decision (uses message, not reason)", () => {
    const decision: Decision = { kind: "context", message: "fyi" };
    const line = traceLine(makeEvent(), decision, 1, 1);
    expect(line).toBe(
      '[hook-kit] event=PreToolUse tool=Bash session=s1 modules=1 → context reason="fyi" time=1ms\n',
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
      emitVerbose(makeEvent(), null, 1, 4);
    });
    expect(captured.output()).toContain("[hook-kit] event=PreToolUse");
    expect(captured.output()).toContain("→ null time=4ms");
  });

  test("is a no-op when HOOK_KIT_VERBOSE is unset", () => {
    withEnv("HOOK_KIT_VERBOSE", undefined, () => {
      emitVerbose(makeEvent(), { kind: "deny", reason: "x" }, 1, 1);
    });
    expect(captured.output()).toBe("");
  });
});
