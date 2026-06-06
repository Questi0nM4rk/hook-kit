// Shared test helpers — kept under tests/ with a leading underscore so bun's
// test discovery (which only picks up `*.test.ts` / `*_test.ts`) skips it.
// Replaces three identical copies that were drifting across test files.

// biome-ignore-all lint/suspicious/noConsole: silenceConsoleWarn + captureConsoleWarn intentionally rebind console.warn so tests can suppress or assert the M1.5 same-path warning emitted by TmpdirStore; this is the test-side dual of the production-side console.warn in src/state/tmpdir-store.ts.

import { createModule } from "../src/core/module.js";
import type { HookEvent, HookModule, Rule } from "../src/core/types.js";
import { bashEvent as sdkBashEvent } from "../src/testing/events.js";

// Event factories: re-export the public testing-SDK builders so test authors
// import them from one place. `_helpers.bashEvent` wraps the SDK factory with
// this suite's historical defaults (`sessionId: "s1"`, a non-empty
// transcriptPath) — `observer-terminal.test.ts` pins `r.event.sessionId === "s1"`,
// so the wrapper preserves that shape while still de-duplicating onto the SDK.
// biome-ignore lint/performance/noBarrelFile: `_helpers.ts` is the test-suite's shared helper hub (captureStderr, withEnv, moduleWith, modOf, parseCcStdout); re-exporting the SDK event factories here keeps one import site for migrated tests. It is never bundled into the shipped package, so the module-graph cost the rule guards against does not apply.
export { editEvent, readEvent, writeEvent } from "../src/testing/events.js";

/** Build a synthetic PreToolUse Bash event for engine/rule tests. Thin wrapper
 *  over the testing-SDK `bashEvent` that keeps this suite's `sessionId: "s1"` /
 *  `transcriptPath` defaults (pinned by `observer-terminal.test.ts`). */
export function bashEvent(command: string): HookEvent {
  return sdkBashEvent(command, { sessionId: "s1", transcriptPath: "/tmp/t.jsonl" });
}

/** Build a minimal HookModule for engine tests. Defaults: PreToolUse only,
 *  no matchers, enabled. Override `id` to disambiguate ruleId assertions
 *  (`<id>:<rule.kind>:<index>` is the observer's ruleId format). */
export function moduleWith(rules: Rule[], id = "m"): HookModule {
  return { id, name: id, events: ["PreToolUse"], rules };
}

/** Wrap a single rule in a `createModule`-built module with `Bash`-default
 *  matchers — the shared form of the `modOf` factory copied across the builder
 *  and engine suites. Pass `matchers` to widen coverage (e.g. the testing-SDK
 *  expect suite needs `["Bash", "Edit", "Write", "Read"]`). */
export function modOf(
  rule: Parameters<typeof createModule>[1][number],
  matchers: readonly string[] = ["Bash"],
): HookModule {
  return createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers }, [rule]);
}

/** Capture writes to process.stderr until `restore()` is called. */
export function captureStderr(): { restore: () => void; output: () => string } {
  const buf: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return { restore: () => (process.stderr.write = original), output: () => buf.join("") };
}

/**
 * Shape of the CC adapter's stdout JSON, exactly matching the keys produced
 * by `src/adapters/claude-code.ts` (`hookSpecificOutput` envelope). The shape
 * is conservative — every field optional — so this can stand in for both
 * deny/ask paths (with permissionDecision / permissionDecisionReason) and the
 * annotation-only path (additionalContext).
 */
export interface CcStdoutJson {
  readonly hookSpecificOutput: {
    readonly hookEventName?: string;
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

/**
 * Type-narrow JSON.parse for CC adapter output. JSON.parse is `any` by design
 * (its return type cannot be derived from the input string); we cast at the
 * test boundary to the well-known CC schema produced by claude-code.ts so
 * test bodies stay type-safe under ESLint's no-unsafe-* rules.
 */
export function parseCcStdout(stdout: string): CcStdoutJson {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse return type is any by design; narrowed to CcStdoutJson at this test-boundary based on the well-known CC adapter output schema.
  const parsed: CcStdoutJson = JSON.parse(stdout);
  return parsed;
}

/** Silence console.warn for the duration of a test block. Returns a
 *  restore function that re-installs the prior `console.warn`. Pair via
 *  beforeEach/afterEach: `let restore; beforeEach(() => restore = silenceConsoleWarn()); afterEach(() => restore());`.
 *  Used by tests that exercise TmpdirStore round-trip / sequential flows
 *  which legitimately open multiple instances on the same path (NOT
 *  concurrent-stores violation) — the M1.5 same-path warning fires
 *  correctly but is noise in those test patterns. */
export function silenceConsoleWarn(): () => void {
  const original = console.warn;
  console.warn = (): void => {
    /* silenced — restore via the returned function */
  };
  return (): void => {
    console.warn = original;
  };
}

/** Capture console.warn calls for assertion. Returns `{ restore, warnings }`
 *  where `warnings` is an array filled as calls arrive (each entry is the
 *  joined string form of all arguments). Counterpart to `silenceConsoleWarn`
 *  for tests that assert ON the warning content rather than silence it. */
export function captureConsoleWarn(): { restore: () => void; warnings: string[] } {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return {
    restore: (): void => {
      console.warn = original;
    },
    warnings,
  };
}

/** Run `fn` with the env var set to `value` (or unset when `value` is undefined). */
export function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env IS the dynamic-key API; `delete process.env[k]` is the canonical unset and Reflect.deleteProperty wouldn't trigger Node's getenv() invalidation either.
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env IS the dynamic-key API; restoring "unset" requires delete.
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
