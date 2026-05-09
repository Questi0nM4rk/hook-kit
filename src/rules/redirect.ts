// redirect() builder — detects shell write-redirects to paths matching a regex.
// Catches `echo evil > /etc/passwd` patterns that bypass the path() builder
// (which only sees Edit/Write/NotebookEdit tool events, not Bash redirects).
// See docs/SPEC.md § Rule Builders.

import type { Stmt } from "@questi0nm4rk/shell-ast";
import { walk, wordToLit } from "@questi0nm4rk/shell-ast";
import {
  context as contextDecision,
  deny as denyDecision,
  escalate as escalateDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";

const WRITE_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

/** Match write-redirects (cmd > path, cmd >> path, etc.) whose target matches
 *  `pathPattern`. Pass `undefined` to match any write-redirect target. */
export function redirect(pathPattern?: RegExp): RedirectRuleBuilder {
  return new RedirectRuleBuilder(pathPattern);
}

class RedirectRuleBuilder {
  constructor(private readonly pathPattern: RegExp | undefined) {}

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
    const pattern = this.pathPattern;
    return {
      kind: "redirect",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) return null;

        let match: NonNullable<Decision> | null = null;
        walk(ast, {
          Stmt(node: Stmt) {
            if (match !== null) return;
            for (const redir of node.redirs) {
              if (!WRITE_OPS.has(redir.op)) continue;
              if (pattern === undefined) {
                match = decision;
                return;
              }
              const target = wordToLit(redir.word);
              if (target !== null && pattern.test(target)) {
                match = decision;
                return;
              }
            }
          },
        });
        return match;
      },
    };
  }
}
