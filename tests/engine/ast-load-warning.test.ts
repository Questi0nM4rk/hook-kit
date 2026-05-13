// Tests for the non-mocked side of the warning contract: real parse() at
// work, no module mocks. Mocked WasmLoadError path lives in
// `ast-wasm-load-failure.test.ts` — split because Bun's mock.module() is
// process-sticky and would pollute these expectations.
//
// Contract since shell-ast 0.3 (BUG-001 in docs/BUGS.md):
//   ParseSyntaxError → silent (per-input user typo; doesn't disable rules)
//   Iron Law 4       → rules return null on any parse failure regardless
//
// See `ast-wasm-load-failure.test.ts` for the WasmLoadError-emits-warning
// half of the contract.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createModule } from "../../src/core/module.js";
import { __resetAstErrorLoggedForTests, evaluate } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";
import { bashEvent, captureStderr } from "../_helpers.js";

const denyRm = createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
  cmd("rm").deny("blocked"),
]);

describe("engine — silent path for syntax / valid input (BUG-001)", () => {
  let captured: { restore: () => void; output: () => string };

  beforeEach(() => {
    __resetAstErrorLoggedForTests();
    captured = captureStderr();
  });

  afterEach(() => {
    captured.restore();
  });

  test("syntax errors stay silent (per-input failure, not infra)", async () => {
    // Real-world unparseable inputs — old hook-kit warned on these, the
    // typed-error contract keeps them quiet so a single user typo doesn't
    // masquerade as infra failure.
    await evaluate(bashEvent("$("), [denyRm]);
    await evaluate(bashEvent("(((("), [denyRm]);
    await evaluate(bashEvent("case x in"), [denyRm]);

    expect(captured.output()).toBe("");
  });

  test("warning does not fire on valid input", async () => {
    await evaluate(bashEvent("echo hello"), [denyRm]);
    await evaluate(bashEvent("git status"), [denyRm]);

    expect(captured.output()).toBe("");
  });

  test("rules still return null on parse failure (Iron Law 4 preserved)", async () => {
    const outcome = await evaluate(bashEvent("$("), [denyRm]);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });
});
