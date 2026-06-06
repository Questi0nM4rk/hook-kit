// cmd() builder — shell-ast based command matching
// See docs/SPEC.md § Rule Builders for semantics
// biome-ignore-all lint/style/noParameterProperties: builder classes use TS constructor parameter properties for fluent-DSL state initialization; explicit field+constructor would double boilerplate per chainable.

import type { CallExprNode, ResolvedArg } from "@questi0nm4rk/shell-ast";
import {
  findCalls,
  isDynamic,
  isResolved,
  resolvedCmd,
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
import { escalateUncertain } from "../core/security.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { expandFlags, hasFlag, unwrappedName } from "../engine/helpers.js";

/** @stable @since 1.0.0 */
export function cmd(command: string, ...sub: string[]): CommandRuleBuilder {
  return new CommandRuleBuilder(command, sub);
}

/** Discriminated predicate over `tokensAfter(u, flag)`. `match` fires when at
 *  least one resolved value satisfies `test`; `dynamic` fires when at least
 *  one value is DYNAMIC. Multiple predicates compose with AND across the
 *  builder; ANY-match across each flag's values. A `match` predicate whose
 *  flag has a DYNAMIC value (and no resolved value matched) escalates per the
 *  security policy (SA-05) unless `onDynamic: "skip"` restores the legacy
 *  silent behavior. */
type FlagPredicate =
  | {
      readonly kind: "match";
      readonly flag: string;
      readonly test: (value: string) => boolean;
      readonly onDynamic?: "skip";
    }
  | { readonly kind: "dynamic"; readonly flag: string };

/** Outcome of a value matcher against one call: a concrete match, a definitive
 *  non-match, or "the value the matcher targets is dynamic — can't verify". */
type MatchState = "match" | "no-match" | "uncertain";

/** Three-state evaluation of argMatches patterns (AND). A pattern with no
 *  resolved match but a dynamic arg present is "uncertain" — it might match at
 *  runtime. Empty patterns are a vacuous "match" (no value targeted). */
function argMatchesState(args: readonly ResolvedArg[], patterns: readonly RegExp[]): MatchState {
  let uncertain = false;
  for (const pattern of patterns) {
    if (args.some((a) => isResolved(a) && pattern.test(a))) {
      continue;
    }
    if (args.some((a) => isDynamic(a))) {
      uncertain = true;
      continue;
    }
    return "no-match";
  }
  return uncertain ? "uncertain" : "match";
}

/** Three-state evaluation of one flag predicate against its flag's tokens. */
function flagValueState(predicate: FlagPredicate, tokens: readonly ResolvedArg[]): MatchState {
  if (predicate.kind === "dynamic") {
    return tokens.some((v) => isDynamic(v)) ? "match" : "no-match";
  }
  if (tokens.some((v) => isResolved(v) && predicate.test(v))) {
    return "match";
  }
  if (predicate.onDynamic === "skip") {
    return "no-match";
  }
  return tokens.some((v) => isDynamic(v)) ? "uncertain" : "no-match";
}

/** Combine every flag predicate (AND). Empty predicates are a vacuous match. */
function flagValuesState(
  predicates: readonly FlagPredicate[],
  tokensFor: (flag: string) => readonly ResolvedArg[],
): MatchState {
  let uncertain = false;
  for (const predicate of predicates) {
    const state = flagValueState(predicate, tokensFor(predicate.flag));
    if (state === "no-match") {
      return "no-match";
    }
    if (state === "uncertain") {
      uncertain = true;
    }
  }
  return uncertain ? "uncertain" : "match";
}

/** Combine arg-match and flag-value states (AND): no-match dominates, then
 *  uncertain, else match. */
function combineStates(a: MatchState, b: MatchState): MatchState {
  if (a === "no-match" || b === "no-match") {
    return "no-match";
  }
  if (a === "uncertain" || b === "uncertain") {
    return "uncertain";
  }
  return "match";
}

class CommandRuleBuilder {
  private anyOfFlags: string[][] = [];
  private flagPredicates: FlagPredicate[] = [];

  // biome-ignore lint/complexity/useMaxParams: builder constructor mirrors the cmd() chainable predicate surface (cmd/sub/flags/noFlags/argPatterns/argIncludes/ddash/strictPath); collapsing to an opts-object would force allocations on every cmd() call.
  constructor(
    private readonly command: string,
    private readonly sub: readonly string[],
    private flags: string[] = [],
    private noFlags: string[] = [],
    private argMatchPatterns: RegExp[] = [],
    private argIncludeValues: string[] = [],
    private requireDdash = false,
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
  flagValueMatches(flag: string, pattern: RegExp, opts?: { onDynamic?: "skip" }): this {
    this.flagPredicates = [
      ...this.flagPredicates,
      {
        kind: "match",
        flag,
        test: (v) => pattern.test(v),
        ...(opts?.onDynamic ? { onDynamic: opts.onDynamic } : {}),
      },
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
  flagValueEquals(flag: string, value: string, opts?: { onDynamic?: "skip" }): this {
    this.flagPredicates = [
      ...this.flagPredicates,
      {
        kind: "match",
        flag,
        test: (v) => v === value,
        ...(opts?.onDynamic ? { onDynamic: opts.onDynamic } : {}),
      },
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
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cmd() evaluator runs the full match-or-skip pipeline (AST walk → unwrap → strict/basename → sub → flags → noFlags → argMatch → argIncludes → flagValues → ddash) per call; ordering matters for short-circuit and decomposing reduces cohesion.
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) {
          return null;
        }

        let sawUncertain = false;
        for (const call of findCalls(ast)) {
          const u = unwrapCall(call, ctx.shellAstOpts);
          if (u === null) {
            // SA-01: unwrapCall returns null exactly when the command WORD is
            // dynamic ($CMD, ${CMD}, $(which rm)) — we cannot certify it is NOT
            // this rule's target. For terminal (deny/ask) security rules,
            // escalate per ctx.security.uncertaintyDecision instead of the
            // silent skip that would let any cmd() deny be bypassed with a
            // single token. escalateUncertain returns null for annotation
            // (warning/note) rules, so they stay silent — promoting an
            // informational annotation would invert severity.
            const esc = escalateUncertain(
              decision,
              ctx.security,
              `command word is dynamic — cannot verify the "${cfg.command}" rule`,
            );
            if (esc !== null) {
              return esc;
            }
            continue;
          }
          // See `unwrappedName` in engine/helpers.ts for the dispatch policy.
          // `resolved` is the basename-scoped name (resolvedCmd(u) ?? ""); in
          // the default non-strict path it IS unwrappedName, so reuse it for the
          // guard. In strict mode the guard needs the verbatim path, so recompute
          // via unwrappedName(u, true). Either way expandFlags below scopes its
          // aliases by `resolved` — alias groups are keyed by resolved basename.
          const resolved = resolvedCmd(u) ?? "";
          const name = cfg.strictPath ? unwrappedName(u, true) : resolved;
          if (name !== cfg.command) {
            continue;
          }

          // Match subcommands by position
          let subOk = true;
          for (let i = 0; i < cfg.sub.length; i++) {
            if (u.args[i] !== cfg.sub[i]) {
              subOk = false;
              break;
            }
          }
          if (!subOk) {
            continue;
          }

          // Flag predicates (alias-aware, scoped to the resolved command — SA-07)
          const expanded = expandFlags(u.flags, resolvedCmd(u) ?? "");
          if (!cfg.flags.every((f) => hasFlag(expanded, f))) {
            continue;
          }
          if (cfg.noFlags.some((f) => hasFlag(expanded, f))) {
            continue;
          }
          if (!cfg.anyOfFlags.every((group) => group.some((f) => hasFlag(expanded, f)))) {
            continue;
          }

          // Definitive arg gate: exact-membership includes.
          if (!cfg.argIncludeValues.every((v) => u.args.includes(v))) {
            continue;
          }
          // POSIX `--` end-of-options separator (e.g. git checkout -- file).
          if (cfg.requireDdash && !hasDdash(call)) {
            continue;
          }

          // Value matchers (argMatches + flag values) are three-state: a
          // resolved match fires; a definitive non-match skips this call; a
          // value the matcher TARGETS being dynamic is "uncertain" (SA-05/08).
          // The per-flag `tokensAfter` cache/closure is only consulted when
          // flagPredicates exist (flagValuesState never calls tokensFor for an
          // empty predicate list — vacuous match), so skip the Map+closure
          // allocation in the common empty-predicates case.
          let tokensFor = noTokens;
          if (cfg.flagPredicates.length > 0) {
            const tokensCache = new Map<string, readonly ResolvedArg[]>();
            tokensFor = (flag: string): readonly ResolvedArg[] => {
              let cached = tokensCache.get(flag);
              if (cached === undefined) {
                cached = tokensAfter(u, flag);
                tokensCache.set(flag, cached);
              }
              return cached;
            };
          }
          const valueState = combineStates(
            argMatchesState(u.args, cfg.argMatchPatterns),
            flagValuesState(cfg.flagPredicates, tokensFor),
          );
          if (valueState === "match") {
            return decision;
          }
          if (valueState === "uncertain") {
            sawUncertain = true;
          }
          // "no-match" / "uncertain" → try the next call.
        }
        // SA-05/08: a value matcher targeted a dynamic value but nothing
        // definitively matched — escalate for terminal rules (annotation rules
        // stay silent, no severity inversion).
        if (sawUncertain) {
          const esc = escalateUncertain(
            decision,
            ctx.security,
            `a value matched by the "${cfg.command}" rule is dynamic — cannot verify`,
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

/** True if the call's raw arg list contains the POSIX `--` separator. */
function hasDdash(call: CallExprNode): boolean {
  return call.args.some((w) => wordToLit(w) === "--");
}

/** No-flag-predicate sentinel for the evaluate() loop's `tokensFor`: when a rule
 *  has zero flag predicates, `flagValuesState` never invokes it, so the empty
 *  result is never observed — it just avoids the per-call Map+closure allocation.
 *  Takes (and ignores) the flag arg to share the cached closure's signature. */
function noTokens(_flag: string): readonly ResolvedArg[] {
  return [];
}
