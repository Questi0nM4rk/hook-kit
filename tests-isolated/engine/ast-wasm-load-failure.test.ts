// Isolated test for the WasmLoadError surfacing contract. Lives in
// `tests-isolated/` because Bun's `mock.module()` is process-sticky
// (oven-sh/bun#14516) — sibling test files in the same `bun test` invocation
// would see the throwing parse and break unrelated assertions.
//
// Run via `bun test tests-isolated/` (separate invocation; the package's
// `test` script chains both directories sequentially).
//
// Contract since 0.5 (0-silent-fails):
//   WasmLoadError /        → ShellAstParseError annotation in every
//   WasmRuntimeError         EvaluationOutcome where AST parsing is
//                            attempted. Per-invocation, not once-per-process.
//   ParseSyntaxError       → silent (per-input typo; user-meaningful only).
//
// Iron Law 4 still holds: rules contribute null when AST is unavailable.
// The annotation is the visibility channel; it never blocks the command.
//
// Covered here:
//   1. WasmLoadError throw → ShellAstParseError annotation fires each invocation
//   2. Non-Bash events skip parse entirely, no annotation produced
//   3. Iron Law 4: rules still contribute null (no terminal) under infra failure

import { describe, expect, mock, test } from "bun:test";
import * as realShellAst from "@questi0nm4rk/shell-ast";
import { createModule } from "../../src/core/module.js";
import { evaluate } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";
import { bashEvent } from "../../tests/_helpers.js";

mock.module("@questi0nm4rk/shell-ast", () => ({
  ...realShellAst,
  parse: async () => {
    throw new realShellAst.WasmLoadError("test injection: WASM unavailable");
  },
}));

const denyRm = createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
  cmd("rm").deny("blocked"),
]);

describe("engine — WasmLoadError surfaces as ShellAstParseError annotation", () => {
  test("first WASM failure emits a ShellAstParseError annotation with the cause message", async () => {
    const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0] as Extract<(typeof errors)[number], { kind: "error" }>;
    expect(err.errorCode).toBe("ShellAstParseError");
    expect(err.message).toContain("test injection: WASM unavailable");
  });

  test("annotation fires per-invocation (not once-per-process)", async () => {
    // Each evaluate() should produce its own annotation. The old design
    // dedup'd to once-per-process via a module-level latch; the 0.5 design
    // surfaces every failure so a long-running session doesn't go dark
    // after the first message.
    for (let i = 0; i < 3; i++) {
      const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
      const errors = outcome.annotations.filter((a) => a.kind === "error");
      expect(errors).toHaveLength(1);
    }
  });

  test("rules contribute null under WasmLoadError (Iron Law 4 preserved)", async () => {
    const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
    // Annotation present, but no terminal — the AST-aware rule couldn't fire
    // and there are no other rules to produce a decision.
    expect(outcome.terminal).toBeNull();
  });

  test("non-Bash events skip parse entirely, no error annotation produced", async () => {
    // getBashAst only calls parse() for Bash events. Non-Bash events never
    // exercise the WASM path, so no ShellAstParseError annotation should
    // appear.
    const outcome = await evaluate(
      { ...bashEvent("rm -rf /"), toolName: "Read", toolInput: { file_path: "/etc/passwd" } },
      [denyRm],
    );
    expect(outcome.annotations.filter((a) => a.kind === "error")).toEqual([]);
  });
});
