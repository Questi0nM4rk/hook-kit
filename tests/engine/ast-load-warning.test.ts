// Tests for the non-mocked side of the AST-parse-error contract: real
// parse() at work, no module mocks. Mocked WasmLoadError path lives in
// `tests-isolated/engine/ast-wasm-load-failure.test.ts` — split because
// Bun's mock.module() is process-sticky and would pollute these assertions.
//
// Contract since 0.5 (0-silent-fails), refined by SA-03 (#17):
//   ParseSyntaxError       → NO error annotation (not infra), but escalate per
//                            SecurityOptions.onUnparsable (ask by default) —
//                            shell-ast may reject what bash would run.
//   WasmLoadError /        → ShellAstParseError annotation (per invocation) AND
//   WasmRuntimeError         fail per onEngineUnavailable (deny-all by default,
//                            fail-closed). See the isolated file.
//
// SA-03 refines Iron Law 4: a not-functioning parser (unparsable / engine
// unavailable) fails per the security policy — distinct from infra-I-control
// bugs (rule throw / state I/O) which still fail open.
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

describe("engine — ParseSyntaxError escalates per onUnparsable (SA-03)", () => {
  test("syntax errors emit no annotations but escalate to ask by default", async () => {
    // Real-world unparseable inputs — ParseSyntaxError is NOT an infra error,
    // so no `error` annotation fires (those are reserved for WASM load/runtime
    // failures; see the isolated file). But shell-ast may reject what bash
    // would still run, so it is a coverage gap: the default profile escalates
    // (onUnparsable: ask) rather than passing it through silently.
    for (const input of ["$(", "((((", "case x in"]) {
      const outcome = await evaluate(bashEvent(input), [denyRm]);
      expect(outcome.terminal?.kind).toBe("ask");
      expect(outcome.annotations).toEqual([]);
    }
  });

  test("valid input produces no error annotations", async () => {
    for (const input of ["echo hello", "git status"]) {
      const outcome = await evaluate(bashEvent(input), [denyRm]);
      expect(outcome.annotations.filter((a) => a.kind === "error")).toEqual([]);
    }
  });

  test("a single parse failure escalates to ask under the default profile", async () => {
    const outcome = await evaluate(bashEvent("$("), [denyRm]);
    expect(outcome.terminal?.kind).toBe("ask");
    expect(outcome.annotations).toEqual([]);
  });
});
