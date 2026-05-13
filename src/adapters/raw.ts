// Raw adapter — for library mode and tests
// See docs/SPEC.md § Protocol Adapters
//
// The raw adapter has no I/O. It accepts an event up front and captures
// whatever outcome (or error) the engine produces on a `RawAdapterState`
// object. Library consumers use this to drive `run()` with their own
// transport; tests use it to assert what the adapter would have emitted.

import type { EvaluationOutcome, HookEvent } from "../core/types.js";
import type { ProtocolAdapter } from "./types.js";

export interface RawAdapterState {
  readonly event: HookEvent;
  outcome: EvaluationOutcome;
  error: unknown;
  errored: boolean;
}

export interface RawAdapter {
  readonly adapter: ProtocolAdapter;
  readonly state: RawAdapterState;
}

export function rawAdapter(event: HookEvent): RawAdapter {
  const state: RawAdapterState = {
    event,
    outcome: { terminal: null, annotations: [] },
    error: null,
    errored: false,
  };
  const adapter: ProtocolAdapter = {
    async readInput(): Promise<HookEvent> {
      return event;
    },
    writeOutput(outcome: EvaluationOutcome): void {
      state.outcome = outcome;
    },
    handleError(error: unknown): void {
      state.error = error;
      state.errored = true;
    },
  };
  return { adapter, state };
}

export type { ProtocolAdapter } from "./types.js";
