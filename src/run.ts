// run() — orchestrates read → evaluate → write through a ProtocolAdapter.
// See docs/SPEC.md § Protocol Adapters.

import { preloadWasm, WasmLoadError, WasmRuntimeError } from "@questi0nm4rk/shell-ast";
import type { ProtocolAdapter } from "./adapters/types.js";
import type { EvaluationOutcome, HookEvent, HookModule } from "./core/types.js";
import { type EvaluateOptions, evaluate, warnAstUnavailable } from "./engine/index.js";
import { emitVerbose, isVerbose } from "./engine/trace.js";

export type RunOptions = EvaluateOptions;

/**
 * The compiled-binary entry point. Reads input via the adapter, runs the
 * engine against the supplied modules, and hands the EvaluationOutcome to
 * the adapter. Any error in either step routes to `adapter.handleError`
 * (Iron Law 3 fail-open).
 *
 * When `HOOK_KIT_VERBOSE=1` is set, a single trace line is emitted to stderr
 * after evaluation: event, tool, session, module count, final outcome, time.
 */
export async function run(
  modules: readonly HookModule[],
  adapter: ProtocolAdapter,
  opts: RunOptions = {},
): Promise<void> {
  // Warm shell-ast's WASM during startup so the first cmd/pipe/redirect rule
  // doesn't pay cold-init in its hot path. On infra failure, route through
  // the engine's one-shot WASM-unavailable warning so adapter sessions that
  // never touch a Bash event (and thus never call parse()) still see signal.
  await preloadWasm().catch((err: unknown) => {
    if (err instanceof WasmLoadError || err instanceof WasmRuntimeError) {
      warnAstUnavailable(err);
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
