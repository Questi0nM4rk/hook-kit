// run() — orchestrates read → evaluate → write through a ProtocolAdapter.
// See docs/SPEC.md § Protocol Adapters.

import { preloadWasm } from "@questi0nm4rk/shell-ast";
import type { ProtocolAdapter } from "./adapters/types.js";
import type { Decision, HookEvent, HookModule } from "./core/types.js";
import { type EvaluateOptions, evaluate } from "./engine/index.js";
import { emitVerbose, isVerbose } from "./engine/trace.js";

export type RunOptions = EvaluateOptions;

/**
 * The compiled-binary entry point. Reads input via the adapter, runs the
 * engine against the supplied modules, and emits the decision through the
 * same adapter. Any error in either step routes to `adapter.handleError`
 * (Iron Law 3 fail-open).
 *
 * When `HOOK_KIT_VERBOSE=1` is set, a single trace line is emitted to stderr
 * after evaluation: event, tool, session, module count, final decision, time.
 */
export async function run(
  modules: readonly HookModule[],
  adapter: ProtocolAdapter,
  opts: RunOptions = {},
): Promise<void> {
  // Warm shell-ast's WASM during startup so the first cmd/pipe/redirect rule
  // doesn't pay cold-init in its hot path. Iron Law 4: a failure here is
  // surfaced as a loud one-shot warning when the engine's first parse()
  // catches it — don't gate startup on infra errors.
  await preloadWasm().catch(() => {});

  let event: HookEvent;
  try {
    event = await adapter.readInput();
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  const verbose = isVerbose();
  const startedAt = verbose ? performance.now() : 0;

  let decision: Decision;
  try {
    decision = await evaluate(event, modules, opts);
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  if (verbose) {
    const durationMs = Math.round(performance.now() - startedAt);
    emitVerbose(event, decision, modules.length, durationMs);
  }

  await adapter.writeOutput(decision, event);
}
