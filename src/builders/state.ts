// stateful() — cross-invocation state wrapper
// See docs/SPEC.md § Rule Builders

import type { Decision, EvalContext, HookEvent, Rule, StateStore } from "../core/types.js";

export function stateful(
  id: string,
  fn: (event: HookEvent, state: StateStore) => Decision | Promise<Decision>,
): Rule {
  return {
    kind: `stateful:${id}`,
    evaluate(event: HookEvent, ctx: EvalContext): Decision | Promise<Decision> {
      return fn(event, ctx.state);
    },
  };
}
