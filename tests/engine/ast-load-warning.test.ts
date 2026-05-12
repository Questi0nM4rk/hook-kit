// Regression: shell-ast parse failures used to be silent. BUG-001 in
// docs/BUGS.md. Iron Law 4 still applies (rules return null on failure),
// but a one-shot stderr warning surfaces the coverage gap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createModule } from "../../src/core/module.js";
import type { HookEvent } from "../../src/core/types.js";
import { __resetAstErrorLoggedForTests, evaluate } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";

function bashEvent(command: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
  };
}

function captureStderr(): { restore: () => void; output: () => string } {
  const buf: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  return { restore: () => (process.stderr.write = original), output: () => buf.join("") };
}

describe("engine — shell-ast parse failure warning (BUG-001)", () => {
  let captured: { restore: () => void; output: () => string };

  beforeEach(() => {
    __resetAstErrorLoggedForTests();
    captured = captureStderr();
  });

  afterEach(() => {
    captured.restore();
  });

  test("emits a stderr warning on first parse failure", async () => {
    // "$(" is a real-world unparseable input — reached EOF without matching ).
    const modules = [
      createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("rm").deny("blocked"),
      ]),
    ];
    await evaluate(bashEvent("$("), modules);

    const out = captured.output();
    expect(out).toContain("[hook-kit] shell-ast parse failed");
    expect(out).toContain("[hook-kit] details:");
  });

  test("warning fires once per process even across multiple failed evaluates", async () => {
    const modules = [
      createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("rm").deny("blocked"),
      ]),
    ];
    await evaluate(bashEvent("$("), modules);
    await evaluate(bashEvent("(((("), modules);
    await evaluate(bashEvent("case x in"), modules);

    const out = captured.output();
    const lineCount = out
      .split("\n")
      .filter((l) => l.includes("[hook-kit] shell-ast parse failed")).length;
    expect(lineCount).toBe(1);
  });

  test("warning does not fire on valid input", async () => {
    const modules = [
      createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("rm").deny("blocked"),
      ]),
    ];
    await evaluate(bashEvent("echo hello"), modules);
    await evaluate(bashEvent("git status"), modules);

    expect(captured.output()).toBe("");
  });

  test("rules still return null on parse failure (Iron Law 4 preserved)", async () => {
    const modules = [
      createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("rm").deny("blocked"),
      ]),
    ];
    const decision = await evaluate(bashEvent("$("), modules);
    expect(decision).toBeNull();
  });
});
