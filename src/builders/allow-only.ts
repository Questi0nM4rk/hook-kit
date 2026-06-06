// allowOnly() builder — whitelist inverter (SA-09, #23). Fires its decision on
// any command NOT in the allowlist. This INVERTS hook-kit's blacklist default
// (Iron Law 5) and is strictly opt-in, for high-risk contexts (CI runners,
// locked-down agents). A dynamic command word can't be checked against the
// allowlist, so it escalates per the security policy. See docs/SPEC.md.

import { findCalls, resolvedCmd, unwrapCall } from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import { escalateUncertain } from "../core/security.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";

/** Scan every call against the allowlist. `disallowed` = a concrete command
 *  not in the set; `dynamic` = a command word we can't resolve to check. */
function scanAllowlist(
  ast: NonNullable<Awaited<ReturnType<EvalContext["getBashAst"]>>>,
  shellAstOpts: EvalContext["shellAstOpts"],
  allowed: ReadonlySet<string>,
): { readonly disallowed: boolean; readonly dynamic: boolean } {
  let dynamic = false;
  for (const call of findCalls(ast)) {
    const u = unwrapCall(call, shellAstOpts);
    // `wrapped-opaque` = a privilege/exec wrapper (sudo/doas/pkexec/run0/…)
    // whose INNER command word is dynamic, so shell-ast can't resolve it.
    // `resolvedCmd` falls back to the WRAPPER name here, which would let an
    // allowlisted wrapper certify an unverifiable inner — a fail-open. Treat
    // it as dynamic (like a bare dynamic word): the allowlist can't prove the
    // inner command is allowed. Mirrors the bare-`$cmd` path below.
    if (u !== null && u.kind === "wrapped-opaque") {
      dynamic = true;
      continue;
    }
    const name = u === null ? undefined : resolvedCmd(u);
    if (name === undefined) {
      dynamic = true; // dynamic command word — unverifiable
      continue;
    }
    if (!allowed.has(name)) {
      return { disallowed: true, dynamic };
    }
  }
  return { disallowed: false, dynamic };
}

/**
 * Build a whitelist rule: its decision fires on any command whose resolved
 * basename is NOT in `allowed`. Opt-in inversion of blacklist semantics.
 *
 *   allowOnly("git", "ls", "cat").deny("only git/ls/cat are permitted here")
 *
 * Basename-matched (so `/usr/bin/git` and `sudo git` count as `git`). A dynamic
 * command word ($CMD) escalates per `uncertaintyDecision` for terminal rules.
 * @experimental @since 0.9.0
 */
export function allowOnly(...allowed: string[]): AllowOnlyRuleBuilder {
  return new AllowOnlyRuleBuilder(allowed);
}

class AllowOnlyRuleBuilder {
  // biome-ignore lint/style/noParameterProperties: fluent-DSL builder state; explicit field+constructor doubles boilerplate per chainable.
  constructor(private readonly allowed: readonly string[]) {}

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
    const allowedSet = new Set(this.allowed);
    return {
      kind: "allow-only",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) {
          return null;
        }
        const { disallowed, dynamic } = scanAllowlist(ast, ctx.shellAstOpts, allowedSet);
        if (disallowed) {
          return decision;
        }
        if (dynamic) {
          const esc = escalateUncertain(
            decision,
            ctx.security,
            "command word is dynamic — cannot verify it is in the allowlist",
          );
          if (esc !== null) {
            return esc;
          }
        }
        return null;
      },
    };
  }
}
