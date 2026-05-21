// run() — orchestrates read → evaluate → write through a ProtocolAdapter.
// See docs/SPEC.md § Protocol Adapters.

import { preloadWasm, WasmLoadError, WasmRuntimeError } from "@questi0nm4rk/shell-ast";
import type { ProtocolAdapter } from "./adapters/types.js";
import { formatErrorLine, ShellAstParseError } from "./core/errors.js";
import type { EvaluationOutcome, HookEvent, HookModule } from "./core/types.js";
import { type EvaluateOptions, evaluate } from "./engine/index.js";
import { emitVerbose, isVerbose } from "./engine/trace.js";

/** @stable @since 1.0.0 */
export type RunOptions = EvaluateOptions;

/**
 * The compiled-binary entry point. Reads input via the adapter, runs the
 * engine against the supplied modules, and hands the EvaluationOutcome to
 * the adapter. Any error in either step routes to `adapter.handleError`
 * (Iron Law 4 fail-open).
 *
 * When `HOOK_KIT_VERBOSE=1` is set, a single trace line is emitted to stderr
 * after evaluation: event, tool, session, module count, final outcome, time.
 * @stable @since 1.0.0
 */
export async function run(
  modules: readonly HookModule[],
  adapter: ProtocolAdapter,
  opts: RunOptions = {},
): Promise<void> {
  // Warm shell-ast's WASM during startup so the first cmd/pipe/redirect rule
  // doesn't pay cold-init in its hot path. On infra failure, write a typed
  // error line directly to stderr — there's no EvaluationOutcome to attach
  // an annotation to yet, but the failure must remain visible.
  await preloadWasm().catch((err: unknown) => {
    if (err instanceof WasmLoadError || err instanceof WasmRuntimeError) {
      const wrapped = new ShellAstParseError("(preload)", err);
      process.stderr.write(formatErrorLine(wrapped));
    }
  });

  let event: HookEvent;
  try {
    event = await adapter.readInput();
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  const verbose = isVerbose();
  const startedAt = verbose ? performance.now() : 0;

  let outcome: EvaluationOutcome;
  try {
    outcome = await evaluate(event, modules, opts);
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  if (verbose) {
    const durationMs = Math.round(performance.now() - startedAt);
    emitVerbose(event, outcome, modules.length, durationMs);
  }

  await adapter.writeOutput(outcome, event);
}
