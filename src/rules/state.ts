// stateful() — cross-invocation state wrapper
// See SPEC-001 § Rule Builder API

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
