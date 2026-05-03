import type { Decision, HookEvent } from "../core/types.js";

/**
 * A ProtocolAdapter owns three responsibilities:
 *  - reading a HookEvent from whatever input channel the harness provides
 *  - serializing a Decision to whatever output channel the harness expects
 *  - handling top-level errors (Iron Law 3 fail-open: silent / exit 0)
 *
 * The CC adapter calls `process.exit` from `writeOutput` and `handleError`
 * (so they "never" return at runtime) — but the type permits void returns
 * so library/test adapters can collect the result in memory instead.
 */
export interface ProtocolAdapter {
  readInput(): Promise<HookEvent>;
  writeOutput(decision: Decision, event: HookEvent): Promise<void> | void;
  handleError(error: unknown): Promise<void> | void;
}
