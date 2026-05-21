// Tests for the non-mocked side of the AST-parse-error contract: real
// parse() at work, no module mocks. Mocked WasmLoadError path lives in
// `tests-isolated/engine/ast-wasm-load-failure.test.ts` — split because
// Bun's mock.module() is process-sticky and would pollute these assertions.
//
// Contract since 0.5 (0-silent-fails):
//   ParseSyntaxError       → silent (per-input user typo; bash will reject
//                            it too, no need to emit an error annotation).
//   WasmLoadError /        → ShellAstParseError annotation (per invocation,
//   WasmRuntimeError         not once-per-process). See the isolated file.
//
// Iron Law 4 (rules contribute null on parse failure) still holds for both
// classes — when AST is unavailable, AST-aware rules can't decide, but the
// hook never blocks the user's tool.
//
// What used to live here was a once-per-process stderr-warning latch
// (`__resetAstErrorLoggedForTests` / `warnAstUnavailable`). The 0.5 design
// surfaces every failure through the EvaluationOutcome.annotations channel
// instead, so the latch is gone and these tests assert on annotations.

// biome-ignore-all lint/performance/noAwaitInLoops: AST-load tests await per-iteration to verify the error annotation surfaces on every input, not just once-per-process.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { evaluate } from "../../src/engine/index.js";
import { bashEvent } from "../_helpers.js";

const denyRm = createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
  cmd("rm").deny("blocked"),
]);

describe("engine — ParseSyntaxError stays silent on real malformed input", () => {
  test("syntax errors emit no annotations (per-input failure, not infra)", async () => {
    // Real-world unparseable inputs — ParseSyntaxError is normal malformed
    // user input. Bash will reject it too; we don't want to emit an error
    // annotation for every typo. Only infrastructure-level failures (WASM
    // load / runtime) get an annotation. See the isolated file for that.
    for (const input of ["$(", "((((", "case x in"]) {
      const outcome = await evaluate(bashEvent(input), [denyRm]);
      expect(outcome.terminal).toBeNull();
      expect(outcome.annotations).toEqual([]);
    }
  });

  test("valid input produces no error annotations", async () => {
    for (const input of ["echo hello", "git status"]) {
      const outcome = await evaluate(bashEvent(input), [denyRm]);
      expect(outcome.annotations.filter((a) => a.kind === "error")).toEqual([]);
    }
  });

  test("rules contribute no terminal on parse failure (Iron Law 4 preserved)", async () => {
    const outcome = await evaluate(bashEvent("$("), [denyRm]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });
});
