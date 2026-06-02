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
// biome-ignore lint/performance/noNamespaceImport: namespace import needed to spread the real module into mock.module()'s factory return.
import * as realShellAst from "@questi0nm4rk/shell-ast";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { STRICT_BUT_ASKS } from "../../src/core/security.js";
import { evaluate } from "../../src/engine/index.js";
import { bashEvent } from "../../tests/_helpers.js";

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun's mock.module returns `void | Promise<void>`; at module-load time we install the mock as a side-effect, no awaitable boundary exists here (top-level await would block the test runner's module graph).
mock.module("@questi0nm4rk/shell-ast", () => ({
  ...realShellAst,
  // eslint-disable-next-line @typescript-eslint/require-await -- mocked `parse` must keep the real shell-ast `parse(): Promise<Script>` signature; an async-throw rejects the Promise (which is what the engine's error path consumes), a sync throw would skip that path entirely and the test would assert against the wrong code path.
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
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- Extract<…, {kind:"error"}> narrows to the error variant of the annotation union; the `!` shortcut loses that kind discrimination and biome's noNonNullAssertion would then reject it anyway.
    const err = errors[0] as Extract<(typeof errors)[number], { kind: "error" }>;
    expect(err.errorCode).toBe("ShellAstParseError");
    expect(err.message).toContain("test injection: WASM unavailable");
  });

  test("annotation fires per-invocation (not once-per-process)", async () => {
    // Each evaluate() should produce its own annotation. The old design
    // dedup'd to once-per-process via a module-level latch; the 0.5 design
    // surfaces every failure so a long-running session doesn't go dark
    // after the first message.
    // biome-ignore lint/style/noMagicNumbers: 3 iterations to verify per-event error annotation (not once-per-process latch); count is the assertion shape.
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: each iteration verifies the error annotation surfaces per-event, not once-per-process; sequential await is the assertion shape.
      const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
      const errors = outcome.annotations.filter((a) => a.kind === "error");
      expect(errors).toHaveLength(1);
    }
  });

  test("engine-unavailable denies by default — onEngineUnavailable: deny-all (SA-03)", async () => {
    // SA-03 refines Iron Law 4: a NOT-FUNCTIONING shell-AST engine can inspect
    // nothing, so the default STRICT_BUT_ASKS profile fails CLOSED — every
    // command denies. (Distinct from rule-throw / state-IO bugs, which still
    // fail open.) The ShellAstParseError annotation rides along on the deny.
    const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
    expect(outcome.terminal?.kind).toBe("deny");
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(1);
  });

  test("onEngineUnavailable 'allow-all' preserves the legacy fail-open path", async () => {
    const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm], {
      security: { ...STRICT_BUT_ASKS, onEngineUnavailable: "allow-all" },
    });
    // No terminal — the AST-aware rule couldn't fire and the policy opts out of
    // fail-closed. The error annotation still surfaces the infra failure.
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(1);
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
