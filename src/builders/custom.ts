// custom() — escape hatch for arbitrary predicates
// See docs/SPEC.md § Rule Builders

import type { Decision, HookEvent, Rule } from "../core/types.js";

/** @stable @since 1.0.0 */
export function custom(id: string, fn: (event: HookEvent) => Decision | Promise<Decision>): Rule {
  return {
    kind: `custom:${id}`,
    evaluate(event: HookEvent): Decision | Promise<Decision> {
      return fn(event);
    },
  };
}
