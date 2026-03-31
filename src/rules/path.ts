// path() builder — file path pattern matching
// See SPEC-001 § Rule Builder API

import type { Decision, HookEvent, Rule } from "../core/types.js";

export function path(_pattern: RegExp): PathRuleBuilder {
  return new PathRuleBuilder(_pattern);
}

class PathRuleBuilder {
  private eventType: "write" | "read" | "both" = "both";

  constructor(private readonly pattern: RegExp) {}

  onWrite(): this { this.eventType = "write"; return this; }
  onRead(): this { this.eventType = "read"; return this; }

  deny(reason: string, label?: string): Rule {
    return this.buildRule({ kind: "deny", reason, label });
  }

  context(message: string, label?: string): Rule {
    return this.buildRule({ kind: "context", message, label });
  }

  escalate(reason: string, label?: string): Rule {
    return this.buildRule({ kind: "escalate", reason, label });
  }

  private buildRule(_decision: NonNullable<Decision>): Rule {
    // TODO: implement in Phase 1
    return {
      kind: "path",
      evaluate(_event: HookEvent): Decision {
        return null;
      },
    };
  }
}
