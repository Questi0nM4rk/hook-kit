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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: namespace import needed to spread the real module into mock.module()'s factory return.
import * as realShellAst from "@questi0nm4rk/shell-ast";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { STRICT_BUT_ASKS } from "../../src/core/security.js";
import { evaluate } from "../../src/engine/index.js";
import { bashEvent } from "../../tests/_helpers.js";

// Single process-wide mock for `@questi0nm4rk/shell-ast` — `mock.module()` is
// process-sticky (oven-sh/bun#14516), so all WASM-failure scenarios in this
// process MUST share ONE registration. Two test files registering competing
// factories for the same specifier collide (whichever `parse` wins dominates
// the whole process). The two injection points (`parse` and `unwrapDeepParsed`)
// read from mutable refs each test configures, then afterEach restores the real
// implementations. This is why BUG 11 (deep-unwrap throw) lives HERE and not in
// a sibling file.
//
// CRITICAL: capture the real implementations into consts BEFORE mock.module
// rebinds the live namespace. After the mock registers, `realShellAst.parse`
// resolves to the WRAPPER below — defaulting the ref to it would make the
// wrapper call itself (infinite recursion → hang). The eager consts are the
// genuine implementations.
const REAL_PARSE = realShellAst.parse;
const REAL_UNWRAP_DEEP = realShellAst.unwrapDeepParsed;
let parseImpl: typeof REAL_PARSE = REAL_PARSE;
let unwrapDeepParsedImpl: typeof REAL_UNWRAP_DEEP = REAL_UNWRAP_DEEP;

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- bun's mock.module returns `void | Promise<void>`; at module-load time we install the mock as a side-effect, no awaitable boundary exists here (top-level await would block the test runner's module graph).
mock.module("@questi0nm4rk/shell-ast", () => ({
  ...realShellAst,
  parse: (...args: Parameters<typeof REAL_PARSE>) => parseImpl(...args),
  unwrapDeepParsed: (...args: Parameters<typeof REAL_UNWRAP_DEEP>) => unwrapDeepParsedImpl(...args),
}));

const PARSE_THROWS: typeof REAL_PARSE =
  // eslint-disable-next-line @typescript-eslint/require-await -- mocked `parse` must keep the real `parse(): Promise<Script>` signature; an async-throw rejects the Promise (what the engine's error path consumes); a sync throw would skip that path.
  async () => {
    throw new realShellAst.WasmLoadError("test injection: WASM unavailable");
  };

afterEach(() => {
  parseImpl = REAL_PARSE;
  unwrapDeepParsedImpl = REAL_UNWRAP_DEEP;
});

const denyRm = createModule({ id: "x", name: "test", events: ["PreToolUse"], matchers: ["Bash"] }, [
  cmd("rm").deny("blocked"),
]);

describe("engine — WasmLoadError surfaces as ShellAstParseError annotation", () => {
  beforeEach(() => {
    // These tests inject the failure at `parse()`.
    parseImpl = PARSE_THROWS;
  });

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

describe("BUG 11 — deep-unwrap throw routes to engine-unavailable fail-closed", () => {
  // Here `parse` SUCCEEDS (so the engine enters the inline-shell recursion) and
  // `unwrapDeepParsed` throws a WASM runtime fault MID-recursion — precisely the
  // boundary the top-level getBashAst try/catch did NOT cover. Before the fix,
  // the throw propagated uncaught out of evaluateInternal, bypassing the SA-03
  // fail-closed path. (Same-process mock; see the module-top comment for why
  // this lives alongside the parse-throw cases rather than a sibling file.)
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/require-await -- mocked deep-unwrap keeps the async signature the engine awaits; an async-throw rejects the awaited Promise (the path under test).
    unwrapDeepParsedImpl = async () => {
      throw new realShellAst.WasmRuntimeError("test injection: deep-unwrap WASM runtime fault");
    };
  });

  test("a WASM runtime throw during recursion denies (deny-all default) instead of crashing", async () => {
    const outcome = await evaluate(bashEvent("bash -c 'rm -rf /'"), [denyRm]);
    expect(outcome.terminal?.kind).toBe("deny");
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- Extract narrows to the error variant; `!` would lose kind discrimination.
    const err = errors[0] as Extract<(typeof errors)[number], { kind: "error" }>;
    expect(err.errorCode).toBe("ShellAstParseError");
    expect(err.message).toContain("test injection: deep-unwrap WASM runtime fault");
  });

  test("onEngineUnavailable 'allow-all' preserves the legacy fail-open path", async () => {
    const outcome = await evaluate(bashEvent("bash -c 'rm -rf /'"), [denyRm], {
      security: { ...STRICT_BUT_ASKS, onEngineUnavailable: "allow-all" },
    });
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(1);
  });
});
