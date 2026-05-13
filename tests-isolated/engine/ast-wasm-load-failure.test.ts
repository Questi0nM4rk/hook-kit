// Isolated test for BUG-001: WasmLoadError must surface a loud one-shot
// warning so silently-disabled rules aren't invisible. Lives in
// `tests-isolated/` because Bun's `mock.module()` is process-sticky
// (oven-sh/bun#14516) — even with afterAll re-mock, sibling test files
// in the same `bun test` invocation see the throwing parse.
//
// Run via `bun test tests-isolated/` (separate invocation; the package's
// `test` script chains both directories sequentially).
//
// Contract since shell-ast 0.3:
//   WasmLoadError / WasmRuntimeError → loud one-shot stderr warning
//     (infra broken; every AST-aware rule is disabled across the process)
//   ParseSyntaxError                 → silent (per-input user typo)
//
// Covered here:
//   1. WasmLoadError throw → warning fires once with the expected wording
//   2. Latch holds across 3 evaluates (no warning duplication)
//   3. Iron Law 4 still holds: rules return null under infra failure

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realShellAst from "@questi0nm4rk/shell-ast";
import { createModule } from "../../src/core/module.js";
import { __resetAstErrorLoggedForTests, evaluate } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";
import { bashEvent, captureStderr } from "../../tests/_helpers.js";

mock.module("@questi0nm4rk/shell-ast", () => ({
  ...realShellAst,
  parse: async () => {
    throw new realShellAst.WasmLoadError("test injection: WASM unavailable");
  },
}));

const denyRm = createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
  cmd("rm").deny("blocked"),
]);

describe("engine — WasmLoadError emits loud one-shot warning (BUG-001)", () => {
  let captured: { restore: () => void; output: () => string };

  beforeEach(() => {
    __resetAstErrorLoggedForTests();
    captured = captureStderr();
  });

  test("first WASM-load failure emits a stderr warning with the expected wording", async () => {
    await evaluate(bashEvent("rm -rf /"), [denyRm]);
    captured.restore();

    const out = captured.output();
    expect(out).toContain("[hook-kit] shell-ast WASM unavailable");
    expect(out).toContain("[hook-kit] details:");
    expect(out).toContain("test injection: WASM unavailable");
  });

  test("warning fires once per process across multiple WASM failures", async () => {
    await evaluate(bashEvent("rm -rf /"), [denyRm]);
    await evaluate(bashEvent("echo hello"), [denyRm]);
    await evaluate(bashEvent("git status"), [denyRm]);
    captured.restore();

    const out = captured.output();
    const lineCount = out
      .split("\n")
      .filter((l) => l.includes("[hook-kit] shell-ast WASM unavailable")).length;
    expect(lineCount).toBe(1);
  });

  test("rules still return null under WasmLoadError (Iron Law 4 preserved)", async () => {
    const outcome = await evaluate(bashEvent("rm -rf /"), [denyRm]);
    captured.restore();
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });

  test("non-Bash events stay silent under WasmLoadError (no spurious warning)", async () => {
    // getBashAst only calls parse() for Bash events. Non-Bash events should
    // not exercise the WASM path at all, so the warning must not fire.
    await evaluate(
      { ...bashEvent("rm -rf /"), toolName: "Read", toolInput: { file_path: "/etc/passwd" } },
      [denyRm],
    );
    captured.restore();

    expect(captured.output()).toBe("");
  });
});
