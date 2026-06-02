// Resolution — the three-state vocabulary for the security uncertainty path
// (issue #14). Every value a matcher inspects (command name, flag value,
// redirect target, positional arg) is in one of three states; the matchers
// evaluate `resolved` normally and route `dynamic` / `unparsable` through
// `escalate` (see src/core/security.ts) instead of silently not-matching.

import { isResolved, type ResolvedArg } from "@questi0nm4rk/shell-ast";

/**
 * Classification of a single inspected value.
 *
 * - `resolved` — a concrete static string; evaluate the rule normally.
 * - `dynamic` — `$var` / `$(…)` / backticks / opaque shell-exec body; the
 *   parser cannot certify it. `sourceText` is the best human-readable hint
 *   (the shell-ast `<dynamic>` placeholder when classified from a bare
 *   `ResolvedArg`, which carries no source text).
 * - `unparsable` — shell-ast produced no AST. Constructed by callers that
 *   hold no AST, not by {@link resolutionOf}.
 *
 * @experimental @since 0.9.0
 */
export type Resolution =
  | { readonly state: "resolved"; readonly value: string }
  | { readonly state: "dynamic"; readonly sourceText: string }
  | { readonly state: "unparsable" };

/** Human-readable stand-in for a DYNAMIC value's source text. The `ResolvedArg`
 *  sentinel carries none; sites holding the originating `Word` can supply a
 *  precise `sourceText` without changing the `Resolution` shape. */
const DYNAMIC_PLACEHOLDER = "<dynamic>";

/**
 * Classify a shell-ast `ResolvedArg` (`string | DYNAMIC`) into a
 * {@link Resolution}. A resolved literal carries its value; the DYNAMIC
 * sentinel becomes `dynamic` with the placeholder source text.
 * @experimental @since 0.9.0
 */
export function resolutionOf(arg: ResolvedArg): Resolution {
  return isResolved(arg)
    ? { state: "resolved", value: arg }
    : { state: "dynamic", sourceText: DYNAMIC_PLACEHOLDER };
}
