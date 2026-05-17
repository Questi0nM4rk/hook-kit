// cmd() builder — shell-ast based command matching
// See docs/SPEC.md § Rule Builders for semantics

import type { CallExprNode } from "@questi0nm4rk/shell-ast";
import { findCalls, isResolved, unwrapCall, wordToLit } from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { expandFlags, hasFlag, unwrappedName } from "../engine/helpers.js";

export function cmd(command: string, ...sub: string[]): CommandRuleBuilder {
  return new CommandRuleBuilder(command, sub);
}

class CommandRuleBuilder {
  private anyOfFlags: string[][] = [];

  constructor(
    private readonly command: string,
    private readonly sub: readonly string[],
    private flags: string[] = [],
    private noFlags: string[] = [],
    private argMatchPatterns: RegExp[] = [],
    private argIncludeValues: string[] = [],
    private requireDdash: boolean = false,
    private strictPathFlag: boolean = false,
  ) {}

  /**
   * Match the command against the verbatim path-as-typed instead of the
   * basename. Default behavior (since 0.6.0) is basename match — `cmd("git")`
   * fires on `/usr/bin/git`, `./bin/git`, etc. Use `.strictPath()` when you
   * want `cmd("/usr/bin/git")` to fire ONLY on that exact invocation:
   *
   *   cmd("/usr/bin/git").strictPath().deny("vendored git only")
   *
   * Rarely needed. Default basename match is what most consumers want.
   */
  strictPath(): this {
    this.strictPathFlag = true;
    return this;
  }

  withFlag(...flags: string[]): this {
    this.flags = [...this.flags, ...flags];
    return this;
  }

  withoutFlag(...flags: string[]): this {
    this.noFlags = [...this.noFlags, ...flags];
    return this;
  }

  /**
   * Sugar over `withFlag` — reads as a requirement. With `value`, matches
   * the parameterized form (`--method=GET` or `--method GET` once shell-ast
   * normalizes); without `value`, identical to `withFlag(name)`.
   *
   *   cmd("gh", "api").requireFlag("--method", "GET").deny("read-only review API")
   *   cmd("git").requireFlag("--no-edit").ask("...")
   *
   * Mental model: "the rule fires when this flag is present" (with optional
   * value match). Polarity-matched to `requireOneOf` / `withoutFlag`.
   */
  requireFlag(name: string, value?: string): this {
    const matcher = value === undefined ? name : `${name}=${value}`;
    this.flags = [...this.flags, matcher];
    return this;
  }

  /**
   * Fire when AT LEAST ONE of the named flags is present (OR semantics).
   * Complements `withFlag` (AND) and `withoutFlag` (NOT). Use when a single
   * rule covers a family of equivalent flags, e.g.:
   *
   *   cmd("gh").requireOneOf("--repo", "--owner").deny("scoped commands require explicit repo/owner")
   */
  requireOneOf(...names: string[]): this {
    this.anyOfFlags = [...this.anyOfFlags, names];
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

  /** Require the call to include the POSIX `--` end-of-options separator
   *  (e.g. `git checkout -- file` to discard, distinct from `git checkout file`). */
  withDdash(): this {
    this.requireDdash = true;
    return this;
  }

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  /** Terminal: surface matching calls for review before they run. Asks
   *  route through the escalation infrastructure (broker → spool tree →
   *  listener / askpass) — see src/escalation/ for the mechanism. The
   *  rule-level verb stays `.ask(...)`. */
  ask(reason: string, label?: string): Rule {
    return this.buildRule(askDecision(reason, label));
  }

  /** Annotate matching invocations with a `[label] warning: <message>` line.
   *  Non-blocking: the command still runs. Use for security-relevant context
   *  the AI should see above its tool output. */
  warning(message: string, label?: string): Rule {
    return this.buildRule(warningDecision(message, label));
  }

  /** Same mechanics as `.warning()` but rendered as `[label] note: <message>`.
   *  Use for informational context where "warning" would overstate severity. */
  note(message: string, label?: string): Rule {
    return this.buildRule(noteDecision(message, label));
  }

  private buildRule(decision: NonNullable<Decision>): Rule {
    const cfg = {
      command: this.command,
      sub: [...this.sub] as readonly string[],
      flags: [...this.flags] as readonly string[],
      noFlags: [...this.noFlags] as readonly string[],
      anyOfFlags: this.anyOfFlags.map((g) => [...g]) as readonly (readonly string[])[],
      argMatchPatterns: [...this.argMatchPatterns] as readonly RegExp[],
      argIncludeValues: [...this.argIncludeValues] as readonly string[],
      requireDdash: this.requireDdash,
      strictPath: this.strictPathFlag,
    };
    return {
      kind: "command",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) return null;

        for (const call of findCalls(ast)) {
          const u = unwrapCall(call);
          if (u === null) continue;
          // See `unwrappedName` in engine/helpers.ts for the dispatch policy.
          if (unwrappedName(u, cfg.strictPath) !== cfg.command) continue;

          // Match subcommands by position
          let subOk = true;
          for (let i = 0; i < cfg.sub.length; i++) {
            if (u.args[i] !== cfg.sub[i]) {
              subOk = false;
              break;
            }
          }
          if (!subOk) continue;

          // Flag predicates (alias-aware)
          const expanded = expandFlags(u.flags);
          if (!cfg.flags.every((f) => hasFlag(expanded, f))) continue;
          if (cfg.noFlags.some((f) => hasFlag(expanded, f))) continue;
          if (!cfg.anyOfFlags.every((group) => group.some((f) => hasFlag(expanded, f)))) continue;

          // Arg predicates
          if (!cfg.argIncludeValues.every((v) => u.args.includes(v))) continue;
          if (!cfg.argMatchPatterns.every((p) => u.args.some((a) => isResolved(a) && p.test(a)))) {
            continue;
          }

          // POSIX `--` end-of-options separator (e.g. git checkout -- file)
          if (cfg.requireDdash && !hasDdash(call)) continue;

          return decision;
        }
        return null;
      },
    };
  }
}

/** True if the call's raw arg list contains the POSIX `--` separator. */
function hasDdash(call: CallExprNode): boolean {
  return call.args.some((w) => wordToLit(w) === "--");
}
