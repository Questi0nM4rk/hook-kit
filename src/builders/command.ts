// cmd() builder — shell-ast based command matching
// See docs/SPEC.md § Rule Builders for semantics

import type { CallExprNode, ResolvedArg } from "@questi0nm4rk/shell-ast";
import {
  findCalls,
  isDynamic,
  isResolved,
  tokensAfter,
  unwrapCall,
  wordToLit,
} from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { expandFlags, hasFlag, unwrappedName } from "../engine/helpers.js";

/** @stable @since 1.0.0 */
export function cmd(command: string, ...sub: string[]): CommandRuleBuilder {
  return new CommandRuleBuilder(command, sub);
}

/** Discriminated predicate over `tokensAfter(u, flag)`. `match` fires when at
 *  least one resolved value satisfies `test`; `dynamic` fires when at least
 *  one value is DYNAMIC. Multiple predicates compose with AND across the
 *  builder; ANY-match across each flag's values. */
type FlagPredicate =
  | { readonly kind: "match"; readonly flag: string; readonly test: (value: string) => boolean }
  | { readonly kind: "dynamic"; readonly flag: string };

class CommandRuleBuilder {
  private anyOfFlags: string[][] = [];
  private flagPredicates: FlagPredicate[] = [];

  constructor(
    private readonly command: string,
    private readonly sub: readonly string[],
    private flags: string[] = [],
    private noFlags: string[] = [],
    private argMatchPatterns: RegExp[] = [],
    private argIncludeValues: string[] = [],
    private requireDdash: boolean = false,
    // Auto-detect path-mode from the cmd-arg shape: a "/" anywhere flips to
    // exact match by default. Lets `cmd("/usr/bin/git")` fire on the exact
    // invocation without `.matchExact()` boilerplate. For bare names the
    // basename-match default still applies; `.matchExact()` is the bare-name
    // opt-in (vendored-binary pattern).
    private strictPathFlag: boolean = command.includes("/"),
  ) {}

  /**
   * Match the command exactly — no basename normalization. Two cases:
   *
   *   cmd("/usr/bin/git")                fires on `/usr/bin/git` only.
   *                                      Auto-applied because the cmd arg
   *                                      contains "/" — explicit `.matchExact()`
   *                                      is redundant but harmless.
   *
   *   cmd("git").matchExact()            fires on bare `git` only — NOT on
   *                                      `/usr/bin/git`. The vendored-binary
   *                                      pattern: "allow `/opt/git/bin/git`,
   *                                      deny default `git`".
   *
   * The 95% case (`cmd("git")` should fire on the system git) is handled by
   * the default — basename match via shell-ast's `resolvedCmd`. `.matchExact()`
   * is the explicit opt-out for that small set of cases that need it.
   */
  matchExact(): this {
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

  /**
   * Fire when `flag`'s value matches `pattern`. Inspects the value AFTER
   * the flag in the resolved arg list (both `-o /etc/passwd` space form
   * and `--output=/etc/passwd` = form work). Repeated flags use ANY-match
   * semantics — fires if at least one occurrence's value matches. Dynamic
   * values (`-o "$VAR"`, `-o $(cmd)`) are skipped silently; pair with
   * `.flagValueDynamic(flag)` for block-on-uncertainty.
   *
   * Backed by shell-ast 0.6's polymorphic `tokensAfter(u, flag)` —
   * dispatches to the INNER call for `wrapped` (sudo) variants, so
   * `cmd("gcc").flagValueMatches("-o", /.../)` fires on `sudo gcc -o ...`.
   *
   *   cmd("gcc").flagValueMatches("-o", /^\/(etc|sys|dev)/).deny("system path")
   *   cmd("curl").flagValueMatches("-o", /^\/(etc|root)/).deny("sensitive path")
   *   cmd("git", "commit").flagValueMatches("-F", /^\/tmp/).warning("tmpfs msg")
   */
  flagValueMatches(flag: string, pattern: RegExp): this {
    this.flagPredicates = [
      ...this.flagPredicates,
      { kind: "match", flag, test: (v) => pattern.test(v) },
    ];
    return this;
  }

  /**
   * Fire when `flag`'s value equals `value` exactly (string `===`).
   * Same dispatch and dynamic-skip semantics as `.flagValueMatches()`.
   *
   *   cmd("docker", "run").flagValueEquals("--user", "root").ask("root container")
   *   cmd("kubectl").flagValueEquals("--context", "prod").ask("prod context")
   */
  flagValueEquals(flag: string, value: string): this {
    this.flagPredicates = [
      ...this.flagPredicates,
      { kind: "match", flag, test: (v) => v === value },
    ];
    return this;
  }

  /**
   * Fire when at least one occurrence of `flag` has a DYNAMIC value the
   * resolver can't see statically (`-o "$VAR"`, `-o $(cmd)`, `-o ~/x`).
   *
   * Pairs with `.flagValueMatches` for defense-in-depth — the matcher catches
   * concrete-value violations, this catches "we can't tell, treat as
   * suspicious." Both rules can ship side-by-side:
   *
   *   cmd("gcc")
   *     .flagValueMatches("-o", /^\/(etc|sys|dev|usr|boot)/)
   *     .deny("gcc -o targets system path");
   *
   *   cmd("gcc")
   *     .flagValueDynamic("-o")
   *     .ask("gcc -o has dynamic target — verify before running");
   *
   * shell-ast surfaces DYNAMIC via its `flagValues` / `tokensAfter` (IDEOLOGY
   * §2 "honest about limitations" — never silently allow). hook-kit's policy:
   * matchers reject dynamics by default (they describe concrete patterns);
   * dynamics get their own explicit hook. Same polymorphic dispatch as
   * `.flagValueMatches`: works on bare, sudo-wrapped, and inline-shell
   * invocations.
   */
  flagValueDynamic(flag: string): this {
    this.flagPredicates = [...this.flagPredicates, { kind: "dynamic", flag }];
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
      flagPredicates: [...this.flagPredicates] as readonly FlagPredicate[],
    };
    return {
      kind: "command",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) return null;

        for (const call of findCalls(ast)) {
          const u = unwrapCall(call, ctx.shellAstOpts);
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

          // Flag-value predicates. Per-flag `tokensAfter` cache avoids
          // re-walking call.args when multiple predicates target the same
          // flag. Polymorphic dispatch: tokensAfter sees u.innerRaw for
          // wrapped variants, u.raw for plain — works regardless of
          // GLOBAL_VALUE_FLAGS registration.
          const tokensCache = new Map<string, readonly ResolvedArg[]>();
          const tokensFor = (flag: string): readonly ResolvedArg[] => {
            let cached = tokensCache.get(flag);
            if (cached === undefined) {
              cached = tokensAfter(u, flag);
              tokensCache.set(flag, cached);
            }
            return cached;
          };
          if (
            !cfg.flagPredicates.every((p) => {
              const tokens = tokensFor(p.flag);
              return p.kind === "match"
                ? tokens.some((v) => isResolved(v) && p.test(v))
                : tokens.some((v) => isDynamic(v));
            })
          ) {
            continue;
          }

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
