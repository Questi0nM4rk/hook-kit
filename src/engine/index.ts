// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import type { Decision, HookEvent, HookModule, StateStore } from "../core/types.js";

export interface EvaluateOptions {
  readonly state?: StateStore;
  readonly shortCircuit?: boolean;
}

/**
 * Evaluate all matching modules/rules against a hook event.
 * Returns Decision (action) or null (silent pass-through).
 * See docs/SPEC.md § Engine for the full contract.
 */
export async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const shortCircuit = opts.shortCircuit ?? true;
  const contextMessages: string[] = [];

  const state = opts.state ?? noopState;

  for (const mod of modules) {
    if (mod.enabled === false) continue;
    if (!mod.events.includes(event.eventName)) continue;
    if (mod.matchers && mod.matchers.length > 0) {
      const matched = mod.matchers.some((m) =>
        m.split("|").some((part) => part === event.toolName),
      );
      if (!matched) continue;
    }

    for (const rule of mod.rules) {
      let decision: Decision;
      try {
        decision = await rule.evaluate(event, { state, modules });
      } catch {
        // Iron Law 3: fail open on infrastructure errors
        continue;
      }

      if (decision === null) continue;

      if (decision.kind === "deny" || decision.kind === "escalate") {
        await state.flush();
        return shortCircuit ? decision : decision;
      }

      if (decision.kind === "context") {
        contextMessages.push(decision.message);
      }
    }
  }

  await state.flush();

  if (contextMessages.length > 0) {
    return { kind: "context", message: contextMessages.join("\n\n") };
  }

  return null;
}

const noopState: StateStore = {
  get: () => undefined,
  set: () => {},
  has: () => false,
  delete: () => {},
  flush: () => {},
};
