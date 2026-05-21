// pipe() builder — detects `from | into` patterns via shell-AST BinaryCmd nodes.
// Catches things `cmd()` cannot, e.g. `curl example.com | bash`.
// See docs/SPEC.md § Rule Builders for semantics.

import type { Stmt } from "@questi0nm4rk/shell-ast";
import { effectOf, findAll, unwrapCall } from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { unwrappedName } from "../engine/helpers.js";

/** @stable @since 1.0.0 */
export function pipe(from: readonly string[], into: readonly string[]): PipeRuleBuilder {
  return new PipeRuleBuilder(from, into);
}

class PipeRuleBuilder {
  constructor(
    // biome-ignore lint/style/noParameterProperties: TS constructor parameter property for fluent-DSL builder state; explicit field+constructor would double boilerplate.
    private readonly from: readonly string[],
    // biome-ignore lint/style/noParameterProperties: TS constructor parameter property for fluent-DSL builder state; explicit field+constructor would double boilerplate.
    private readonly into: readonly string[],
  ) {}

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
    const fromSet = new Set(this.from);
    const intoSet = new Set(this.into);
    return {
      kind: "pipe",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) {
          return null;
        }

        for (const node of findAll(ast, "BinaryCmd")) {
          if (effectOf(node) !== "pipe") {
            continue;
          }
          const left = stmtToCmdName(node.x);
          const right = stmtToCmdName(node.y);
          if (left === null || right === null) {
            continue;
          }
          if (fromSet.has(left) && intoSet.has(right)) {
            return decision;
          }
        }
        return null;
      },
    };
  }
}

function stmtToCmdName(stmt: Stmt): string | null {
  const cmd = stmt.cmd;
  if (cmd === null || cmd.type !== "CallExpr") {
    return null;
  }
  const u = unwrapCall(cmd);
  if (u === null) {
    return null;
  }
  // Shares the policy in `unwrappedName` (engine/helpers.ts) — same dispatch
  // as command.ts so a sudo-wrapped pipe target matches on u.cmd ("bash" in
  // `curl | sudo bash`) and a wrapped-script target matches on u.wrapper
  // ("bash" in `curl | bash -c '…'`).
  return unwrappedName(u);
}
