// pipe() builder — detects `from | into` patterns via shell-AST BinaryCmd walks.
// Catches things `cmd()` cannot, e.g. `curl example.com | bash`.
// See docs/SPEC.md § Rule Builders for semantics.

import type { BinaryCmd, Stmt } from "@questi0nm4rk/shell-ast";
import { walk } from "@questi0nm4rk/shell-ast";
import {
  context as contextDecision,
  deny as denyDecision,
  escalate as escalateDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { resolveUnwrappedOrFallback } from "../engine/helpers.js";

export function pipe(from: readonly string[], into: readonly string[]): PipeRuleBuilder {
  return new PipeRuleBuilder(from, into);
}

class PipeRuleBuilder {
  constructor(
    private readonly from: readonly string[],
    private readonly into: readonly string[],
  ) {}

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
    const fromSet = new Set(this.from);
    const intoSet = new Set(this.into);
    return {
      kind: "pipe",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) return null;

        let match: NonNullable<Decision> | null = null;
        walk(ast, {
          BinaryCmd(node: BinaryCmd) {
            if (match !== null) return;
            if (node.op !== "|" && node.op !== "|&") return;
            const left = stmtToCmdName(node.x);
            const right = stmtToCmdName(node.y);
            if (left === null || right === null) return;
            if (fromSet.has(left) && intoSet.has(right)) {
              match = decision;
            }
          },
        });
        return match;
      },
    };
  }
}

function stmtToCmdName(stmt: Stmt): string | null {
  const cmd = stmt.cmd;
  if (cmd === null || cmd.type !== "CallExpr") return null;
  // shell-ast 0.2+ unwraps bash/sh/etc — for `curl … | bash -c '…'` the
  // right-side arrives as { wrapper: "bash", cmd: null }. Prefer cmd for
  // normal commands; fall back to wrapper for wrapper-only calls. The
  // resolveFlags fallback inside resolveUnwrappedOrFallback covers the
  // shell-ast#7 regression where unwrapCall returns null for bare wrappers.
  const u = resolveUnwrappedOrFallback(cmd);
  return u !== null ? (u.cmd ?? u.wrapper) : null;
}
