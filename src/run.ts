// run() — orchestrates read → evaluate → write through a ProtocolAdapter.
// See docs/SPEC.md § Protocol Adapters.

import type { ProtocolAdapter } from "./adapters/types.js";
import type { Decision, HookEvent, HookModule } from "./core/types.js";
import { type EvaluateOptions, evaluate } from "./engine/index.js";

export type RunOptions = EvaluateOptions;

function isVerbose(): boolean {
  const v = process.env.HOOK_KIT_VERBOSE;
  return v === "1" || v === "true";
}

function traceLine(
  event: HookEvent,
  decision: Decision,
  modulesConsidered: number,
  durationMs: number,
): string {
  const head = `[hook-kit] event=${event.eventName} tool=${event.toolName} session=${event.sessionId} modules=${modulesConsidered}`;
  if (decision === null) return `${head} → null time=${durationMs}ms\n`;
  const label = decision.label !== undefined ? ` label=${decision.label}` : "";
  const reasonText = decision.kind === "context" ? decision.message : decision.reason;
  const reason = reasonText !== "" ? ` reason=${JSON.stringify(reasonText)}` : "";
  return `${head} → ${decision.kind}${label}${reason} time=${durationMs}ms\n`;
}

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
    process.stderr.write(traceLine(event, decision, modules.length, durationMs));
  }

  await adapter.writeOutput(decision, event);
}
