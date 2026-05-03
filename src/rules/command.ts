// cmd() builder — shell-ast based command matching
// See docs/SPEC.md § Rule Builders for semantics

import {
  context as contextDecision,
  deny as denyDecision,
  escalate as escalateDecision,
} from "../core/decision.js";
import type { Decision, HookEvent, Rule } from "../core/types.js";

export function cmd(_command: string, ..._sub: string[]): CommandRuleBuilder {
  return new CommandRuleBuilder(_command, _sub);
}

class CommandRuleBuilder {
  constructor(
    private readonly command: string,
    private readonly sub: string[],
    private flags: string[] = [],
    private noFlags: string[] = [],
    private argMatchPatterns: RegExp[] = [],
    private argIncludeValues: string[] = [],
  ) {}

  withFlag(...flags: string[]): this {
    this.flags = [...this.flags, ...flags];
    return this;
  }

  withoutFlag(...flags: string[]): this {
    this.noFlags = [...this.noFlags, ...flags];
    return this;
  }

  argMatches(...patterns: RegExp[]): this {
    this.argMatchPatterns = [...this.argMatchPatterns, ...patterns];
    return this;
  }

  argIncludes(...values: string[]): this {
    this.argIncludeValues = [...this.argIncludeValues, ...values];
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

  private buildRule(decision: NonNullable<Decision>): Rule {
    // TODO: implement shell-ast evaluation
    const _config = {
      command: this.command,
      sub: this.sub,
      flags: this.flags,
      noFlags: this.noFlags,
      argMatchPatterns: this.argMatchPatterns,
      argIncludeValues: this.argIncludeValues,
    };
    return {
      kind: "command",
      async evaluate(_event: HookEvent): Promise<Decision> {
        // Stub — returns null (silent) until engine is implemented
        void _config;
        void decision;
        return null;
      },
    };
  }
}
