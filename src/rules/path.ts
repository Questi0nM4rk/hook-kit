// path() builder — file path pattern matching
// See docs/SPEC.md § Rule Builders

import {
  context as contextDecision,
  deny as denyDecision,
  escalate as escalateDecision,
} from "../core/decision.js";
import type { Decision, HookEvent, Rule } from "../core/types.js";

export function path(pattern: RegExp): PathRuleBuilder {
  return new PathRuleBuilder(pattern);
}

class PathRuleBuilder {
  private eventType: "write" | "read" | "both" = "both";

  constructor(private readonly pattern: RegExp) {}

  onWrite(): this {
    this.eventType = "write";
    return this;
  }
  onRead(): this {
    this.eventType = "read";
    return this;
  }

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  context(message: string, label?: string): Rule {
    return this.buildRule(contextDecision(message, label));
  }

  escalate(reason: string, label?: string): Rule {
    return this.buildRule(escalateDecision(reason, label));
  }

  private buildRule(_decision: NonNullable<Decision>): Rule {
    // TODO: implement
    void this.pattern;
    void this.eventType;
    return {
      kind: "path",
      evaluate(_event: HookEvent): Decision {
        return null;
      },
    };
  }
}
