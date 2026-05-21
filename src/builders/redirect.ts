// redirect() builder — detects shell write-redirects to paths matching a regex.
// Catches `echo evil > /etc/passwd` patterns that bypass the path() builder
// (which only sees Edit/Write/NotebookEdit tool events, not Bash redirects).
// See docs/SPEC.md § Rule Builders.

import { findRedirects, wordToLit } from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";

/** Match write-redirects (cmd > path, cmd >> path, etc.) whose target matches
 *  `pathPattern`. Pass `undefined` to match any write-redirect target.
 *  @stable @since 1.0.0 */
export function redirect(pathPattern?: RegExp): RedirectRuleBuilder {
  return new RedirectRuleBuilder(pathPattern);
}

class RedirectRuleBuilder {
  // biome-ignore lint/style/noParameterProperties: TS constructor parameter property for fluent-DSL builder state; explicit field+constructor would double boilerplate.
  constructor(private readonly pathPattern: RegExp | undefined) {}

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  ask(reason: string, label?: string): Rule {
    return this.buildRule(askDecision(reason, label));
  }

  warning(message: string, label?: string): Rule {
    return this.buildRule(warningDecision(message, label));
  }

  note(message: string, label?: string): Rule {
    return this.buildRule(noteDecision(message, label));
  }

  private buildRule(decision: NonNullable<Decision>): Rule {
    const pattern = this.pathPattern;
    return {
      kind: "redirect",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) {
          return null;
        }

        for (const redir of findRedirects(ast, { ops: "write" })) {
          if (pattern === undefined) {
            return decision;
          }
          const target = wordToLit(redir.word);
          if (target !== null && pattern.test(target)) {
            return decision;
          }
        }
        return null;
      },
    };
  }
}
