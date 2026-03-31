import type { Decision, HookEvent } from "../core/types.js";

export interface ProtocolAdapter {
  readInput(): Promise<HookEvent>;
  writeOutput(decision: Decision, event: HookEvent): never;
  handleError(error: unknown): never;
}
