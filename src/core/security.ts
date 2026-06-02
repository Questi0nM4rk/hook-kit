/**
 * Security uncertainty path — config surface (issue #14).
 *
 * hook-kit's default posture is fail-open blacklist semantics (Iron Law 4):
 * a value the parser cannot statically resolve simply doesn't match, so the
 * command runs. `SecurityOptions` turns the *uncertain* cases — dynamic
 * values, unparsable commands, recursion-depth exhaustion, engine
 * unavailability — into an explicit, configurable escalation instead of a
 * silent allow. It does NOT change the fail-open stance for hook-INFRA bugs
 * (rule throws, state I/O); see docs/SPEC.md § Iron Laws for that split.
 *
 * This file is the config object + the two shipped profiles. The matchers
 * (cmd / redirect / flagValue* / argMatches) consume it via `EvalContext`;
 * each finding (SA-01..SA-10) routes its unresolved case through `escalate`.
 */

import { ask, deny } from "./decision.js";
import type { Decision } from "./types.js";

/** What to emit when a value can't be statically certified. `allow` keeps the
 *  legacy fail-open behavior (silent, command runs). */
export type EscalationDecision = "ask" | "deny" | "allow";

/** Behavior when the shell-AST engine itself is unavailable (WASM load /
 *  runtime failure) — a coverage-loss signal, not a single unresolved value.
 *  `deny-all` fails closed; `allow-all` preserves the pre-0.9 silent path. */
export type EngineUnavailablePolicy = "deny-all" | "allow-all";

/**
 * Per-evaluation security policy. Slots into `EvaluateOptions.security` and is
 * default-filled to {@link STRICT_BUT_ASKS} at engine entry, so matchers always
 * read a fully-resolved object off `EvalContext`.
 *
 * @experimental @since 0.9.0
 */
export interface SecurityOptions {
  /** A value a rule targets is DYNAMIC (`$var`, `$(…)`, backticks). Default `ask`. */
  readonly uncertaintyDecision: EscalationDecision;
  /** shell-ast produced no AST for the command. Default `ask`. */
  readonly onUnparsable: EscalationDecision;
  /** Inline-shell recursion hit `MAX_RECURSE_DEPTH`. Default `ask`. */
  readonly onDepthExceeded: EscalationDecision;
  /** The shell-AST engine could not load/run at all. Default `deny-all`. */
  readonly onEngineUnavailable: EngineUnavailablePolicy;
}

/**
 * Recommended default. Everything the parser cannot certify escalates to
 * `ask`; a dead engine fails closed. Interactive use where a human (or an
 * askpass listener) can answer the ask.
 * @experimental @since 0.9.0
 */
export const STRICT_BUT_ASKS: SecurityOptions = {
  uncertaintyDecision: "ask",
  onUnparsable: "ask",
  onDepthExceeded: "ask",
  onEngineUnavailable: "deny-all",
};

/**
 * Unattended-fleet profile: every escalation hard-denies (no listener to
 * answer an ask, so an unanswerable ask would just hang on the hook timeout).
 * @experimental @since 0.9.0
 */
export const STRICT_DENY: SecurityOptions = {
  uncertaintyDecision: "deny",
  onUnparsable: "deny",
  onDepthExceeded: "deny",
  onEngineUnavailable: "deny-all",
};

/**
 * Map a resolved {@link EscalationDecision} knob value to the decision the
 * engine should emit. The single emit point for the uncertainty path: each
 * finding reads its own knob and calls this, so the ask/deny/allow mapping
 * isn't re-derived per matcher.
 *
 *   escalate(ctx.security.uncertaintyDecision, "dynamic command word")  // SA-01
 *   escalate(ctx.security.onUnparsable, "command did not parse")        // SA-03
 *
 * `allow` returns `null` — the legacy fail-open silent path, where the command
 * runs and nothing is surfaced.
 * @experimental @since 0.9.0
 */
export function escalate(kind: EscalationDecision, reason: string, label?: string): Decision {
  if (kind === "allow") {
    return null;
  }
  return kind === "deny" ? deny(reason, label) : ask(reason, label);
}
