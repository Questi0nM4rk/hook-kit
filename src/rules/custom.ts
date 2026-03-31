// custom() — escape hatch for arbitrary predicates
// See SPEC-001 § Rule Builder API

import type { Decision, HookEvent, Rule } from "../core/types.js";

export function custom(
  id: string,
  fn: (event: HookEvent) => Decision | Promise<Decision>,
): Rule {
  return {
    kind: `custom:${id}`,
    evaluate(event: HookEvent): Decision | Promise<Decision> {
      return fn(event);
    },
  };
}
