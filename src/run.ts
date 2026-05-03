// run() — orchestrates read → evaluate → write through a ProtocolAdapter.
// See docs/SPEC.md § Protocol Adapters.

import type { ProtocolAdapter } from "./adapters/types.js";
import type { Decision, HookEvent, HookModule } from "./core/types.js";
import { type EvaluateOptions, evaluate } from "./engine/index.js";

export type RunOptions = EvaluateOptions;

/**
 * The compiled-binary entry point. Reads input via the adapter, runs the
 * engine against the supplied modules, and emits the decision through the
 * same adapter. Any error in either step routes to `adapter.handleError`
 * (Iron Law 3 fail-open).
 */
export async function run(
  modules: readonly HookModule[],
  adapter: ProtocolAdapter,
  opts: RunOptions = {},
): Promise<void> {
  let event: HookEvent;
  try {
    event = await adapter.readInput();
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  let decision: Decision;
  try {
    decision = await evaluate(event, modules, opts);
  } catch (error) {
    await adapter.handleError(error);
    return;
  }

  await adapter.writeOutput(decision, event);
}
