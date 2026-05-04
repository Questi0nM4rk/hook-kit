// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import { parse, type ShellFile } from "@questi0nm4rk/shell-ast";
import type { Decision, EvalContext, HookEvent, HookModule, StateStore } from "../core/types.js";

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
  let terminalDecision: Decision = null;

  const state = opts.state ?? noopState;
  const ctx = buildEvalContext(event, state, modules);

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
        decision = await rule.evaluate(event, ctx);
      } catch {
        // Iron Law 3: fail open on infrastructure errors
        continue;
      }

      if (decision === null) continue;

      if (decision.kind === "deny" || decision.kind === "escalate") {
        if (shortCircuit) {
          await state.flush();
          return decision;
        }
        // shortCircuit=false: first terminal wins but evaluation continues so
        // later context messages still accumulate (useful for debugging /
        // observability). Later terminals are ignored.
        if (terminalDecision === null) terminalDecision = decision;
        continue;
      }

      if (decision.kind === "context") {
        contextMessages.push(decision.message);
      }
    }
  }

  await state.flush();

  if (terminalDecision !== null) return terminalDecision;

  if (contextMessages.length > 0) {
    return { kind: "context", message: contextMessages.join("\n\n") };
  }

  return null;
}

/**
 * Per-invocation context. The Bash AST is parsed lazily on first request and
 * cached for the lifetime of the context, so all `cmd()` rules within a single
 * `evaluate()` call share one parse.
 */
function buildEvalContext(
  event: HookEvent,
  state: StateStore,
  modules: readonly HookModule[],
): EvalContext {
  let cached: ShellFile | null | undefined;
  return {
    state,
    modules,
    async getBashAst(): Promise<ShellFile | null> {
      if (cached !== undefined) return cached;
      if (event.toolName !== "Bash") {
        cached = null;
        return cached;
      }
      const cmdInput = event.toolInput.command;
      const command = typeof cmdInput === "string" ? cmdInput : "";
      if (command === "") {
        cached = null;
        return cached;
      }
      try {
        cached = await parse(command);
      } catch {
        cached = null;
      }
      return cached;
    },
  };
}

const noopState: StateStore = {
  get: () => undefined,
  set: () => {},
  has: () => false,
  delete: () => {},
  flush: () => {},
};
