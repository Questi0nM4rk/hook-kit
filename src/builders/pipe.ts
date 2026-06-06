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
import { escalateUncertain } from "../core/security.js";
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

        let sawUncertain = false;
        for (const node of findAll(ast, "BinaryCmd")) {
          if (effectOf(node) !== "pipe") {
            continue;
          }
          const status = classifyPipeStage(node, fromSet, intoSet, ctx.shellAstOpts);
          if (status === "match") {
            return decision;
          }
          if (status === "uncertain") {
            sawUncertain = true;
          }
        }
        // SA (#14): a pipe stage's command word was dynamic in a position the
        // rule inspects, but nothing definitively matched — escalate.
        // escalateUncertain returns null for annotation rules (warning/note
        // stay silent; no severity inversion).
        if (sawUncertain) {
          return escalateUncertain(
            decision,
            ctx.security,
            "pipe stage command word is dynamic — cannot verify the pipe rule",
          );
        }
        return null;
      },
    };
  }
}

/** Sentinel distinguishing "this stage IS a command but its word is dynamic
 *  ($SHELL, $(which sh)) — unresolvable" from "this stage is not a plain
 *  command at all" (null). The pipe escalation path treats the two differently:
 *  a dynamic word can't be proven non-matching, a non-command can. */
const DYNAMIC_WORD = Symbol("dynamic-command-word");

function stmtToCmdName(
  stmt: Stmt,
  shellAstOpts: EvalContext["shellAstOpts"],
): string | typeof DYNAMIC_WORD | null {
  const cmd = stmt.cmd;
  if (cmd?.type !== "CallExpr") {
    return null;
  }
  // Thread the consumer's resolver options (globalFlags) — same as command.ts,
  // protect-path.ts, allow-only.ts. Dropping it here let a wrapped pipe stage
  // resolve differently than in every other builder.
  const u = unwrapCall(cmd, shellAstOpts);
  if (u === null) {
    // unwrapCall returns null when the command WORD is dynamic ($SHELL,
    // $(which sh)) — the same one-token signal command.ts (SA-01) escalates on.
    return DYNAMIC_WORD;
  }
  // Shares the policy in `unwrappedName` (engine/helpers.ts) — same dispatch
  // as command.ts so a sudo-wrapped pipe target matches on u.cmd ("bash" in
  // `curl | sudo bash`) and a wrapped-script target matches on u.wrapper
  // ("bash" in `curl | bash -c '…'`). A dynamic word that survived unwrapCall
  // (e.g. `sudo $X`) resolves to "" via resolvedCmd → treat as DYNAMIC_WORD.
  const name = unwrappedName(u);
  return name === "" ? DYNAMIC_WORD : name;
}

/** Classify one pipe stage (`x | y`) against the from/into sets:
 *  - `"match"`   — both sides resolve into their sets (definitive hit).
 *  - `"uncertain"` — each side either matches or is a dynamic word, AND at least
 *    one side is dynamic: the rule can't prove the stage does NOT match, so it
 *    escalates (a fully-resolved unrelated pipeline never reaches here).
 *  - `"none"`    — a resolved side rules the stage out. */
function classifyPipeStage(
  node: { readonly x: Stmt; readonly y: Stmt },
  fromSet: ReadonlySet<string>,
  intoSet: ReadonlySet<string>,
  shellAstOpts: EvalContext["shellAstOpts"],
): "match" | "uncertain" | "none" {
  const left = stmtToCmdName(node.x, shellAstOpts);
  const right = stmtToCmdName(node.y, shellAstOpts);
  const leftMatch = left !== null && left !== DYNAMIC_WORD && fromSet.has(left);
  const rightMatch = right !== null && right !== DYNAMIC_WORD && intoSet.has(right);
  if (leftMatch && rightMatch) {
    return "match";
  }
  const leftOk = leftMatch || left === DYNAMIC_WORD;
  const rightOk = rightMatch || right === DYNAMIC_WORD;
  const anyDynamic = left === DYNAMIC_WORD || right === DYNAMIC_WORD;
  return leftOk && rightOk && anyDynamic ? "uncertain" : "none";
}
