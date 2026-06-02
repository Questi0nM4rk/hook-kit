/**
 * Core types for hook-kit. Protocol-agnostic — no CC-specific concepts here.
 * See docs/SPEC.md § Core Types for the full contract.
 */

import type { ResolveFlagsOptions, ShellFile } from "@questi0nm4rk/shell-ast";
import type { HookKitErrorCode } from "./errors.js";
import type { SecurityOptions } from "./security.js";

// === Decisions ===
//
// A Rule.evaluate() returns at most ONE Decision: a terminal (deny|ask),
// an annotation (warning|note), or null (no opinion). The engine merges per-
// rule decisions into an EvaluationOutcome (terminal + annotations[]) which
// the wrapper/adapter then renders to the harness convention.
//
// `ask` is the rule-level verb for "this needs review before running". The
// routing mechanism is named "escalation" (see src/escalation/) because that's
// how an ask travels — up a session/spool tree to a subscriber. The DSL verb
// and the mechanism name are deliberately separate: rules say `.ask(...)`,
// infrastructure escalates.
//
// Merge policy (see SPEC.md § Engine):
//   - deny short-circuits: terminate immediately, warning/note annotations
//     DROPPED. `error` annotations (engine-emitted, never rule-emitted)
//     ALWAYS survive — they describe hook-infra failures, not rule output,
//     and must remain visible regardless of decision.
//   - ask keeps the run going so annotations accumulate; the FIRST ask wins
//     terminal, later asks are dropped.
//   - warning/note always stack; multiple annotations are emitted in order.
//
// `error` annotations are produced by the engine ONLY (never returned by a
// rule's evaluate()). They wrap a typed HookKitError caught at the engine
// boundary — see src/core/errors.ts. The wrapper renders them to stderr.

/** @stable @since 1.0.0 */
export type Annotation =
  | { readonly kind: "warning"; readonly message: string; readonly label?: string }
  | { readonly kind: "note"; readonly message: string; readonly label?: string }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly errorCode: HookKitErrorCode;
      readonly label?: string;
    };

/** @stable @since 1.0.0 */
export type Terminal =
  | { readonly kind: "deny"; readonly reason: string; readonly label?: string }
  | { readonly kind: "ask"; readonly reason: string; readonly label?: string };

/** What a single rule returns. `null` = no opinion (don't fire).
 *  @stable @since 1.0.0 */
export type Decision = Terminal | Annotation | null;

/** What the engine returns: a chosen terminal (or none) plus every annotation
 *  that fired across all rules.
 *  @stable @since 1.0.0 */
export interface EvaluationOutcome {
  readonly terminal: Terminal | null;
  readonly annotations: readonly Annotation[];
}

// === Events ===

/** @stable @since 1.0.0 */
export interface HookEvent {
  readonly eventName: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** @stable @since 1.0.0 */
export type ToolEvent =
  | { readonly type: "bash"; readonly command: string }
  | { readonly type: "write"; readonly path: string; readonly content?: string }
  | { readonly type: "read"; readonly path: string }
  | {
      readonly type: "edit";
      readonly path: string;
      readonly oldStr?: string;
      readonly newStr?: string;
    }
  | {
      readonly type: "other";
      readonly toolName: string;
      readonly toolInput: Readonly<Record<string, unknown>>;
    };

// === Rules ===

/** @stable @since 1.0.0 */
export interface Rule {
  readonly kind: string;
  evaluate(event: HookEvent, ctx: EvalContext): Decision | Promise<Decision>;
}

/** @stable @since 1.0.0 */
export interface EvalContext {
  readonly state: StateStore;
  readonly modules: readonly HookModule[];
  /**
   * Lazily parses the Bash command for the current event and caches it across
   * all rules within a single `evaluate()` invocation. Returns `null` for
   * non-Bash events, an empty/missing command, or an unparseable command
   * (Iron Law 4: fail open on infra errors).
   */
  getBashAst(): Promise<ShellFile | null>;
  /**
   * shell-ast resolver options threaded through every `unwrapCall(call, opts)`
   * site. Set via `EvaluateOptions.shellAstOpts` at engine entry. Lets consumers
   * register per-tool value-taking flags (`globalFlags`) so commands like
   * `terraform -chdir=./infra apply` resolve `apply` as `args[0]` instead of
   * being shifted by the un-consumed `-chdir=...`. Undefined → use shell-ast's
   * built-in `GLOBAL_VALUE_FLAGS` table only.
   */
  readonly shellAstOpts?: ResolveFlagsOptions;
  /**
   * Resolved security policy for the uncertainty path (issue #14). Always a
   * full {@link SecurityOptions} — the engine default-fills it to
   * `STRICT_BUT_ASKS` from `EvaluateOptions.security` at entry, so matchers
   * read concrete knobs without re-defaulting. Builders consult this to decide
   * how to surface dynamic / unparsable values via `escalate`.
   */
  readonly security: SecurityOptions;
}

// === Modules ===

/** @stable @since 1.0.0 */
export interface HookModule {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];
  readonly matchers?: readonly string[];
  readonly rules: readonly Rule[];
  readonly enabled?: boolean;
}

// === State ===

/** Persistence interface for stateful rules. 4-guarantee contract:
 *
 *  1. **Atomicity** — `set` / `delete` are atomic w.r.t. concurrent readers.
 *  2. **Flush durability** — after `flush()` resolves, writes are visible to
 *     fresh stores and survive process restart.
 *  3. **Concurrent stores** — multiple instances on the same backing storage
 *     interleave safely with last-write-wins per key.
 *  4. **No multi-key transactions** — consumer composes via retry-on-conflict.
 *
 *  Per-store conformance varies — see `docs/STATE.md` § Per-store guarantees.
 *  @stable @since 1.0.0 */
export interface StateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  flush(): void | Promise<void>;
}

// === Observability ===
//
// DecisionObserver gives consumers a programmatic hook on every decision the
// engine produces (terminal + annotation) so they can sink to syslog / OTLP /
// HEC / file / custom transport without parsing wrapper stdout. The contract
// is documented at length in docs/SPEC.md § Observability.

/** A single decision the engine emitted, surfaced to every registered
 *  DecisionObserver. `toolInput` itself is NOT logged — only its sha256 hash —
 *  so observers don't leak secrets to log infrastructure by default.
 *  @stable @since 1.0.0 */
export interface DecisionEventRecord {
  /** `Date.now()` at emission time. */
  readonly timestamp: number;
  /** Stable id: `<module.id>:<rule.kind>:<rule-index-in-module>`. */
  readonly ruleId: string;
  /** Mirror of `rule.kind` for log routing without parsing `ruleId`. */
  readonly ruleKind: string;
  /** The decision verb. `error` is engine-produced (rule throw / observer
   *  throw / shell-ast / state); `warning` / `note` are rule-emitted
   *  annotations; `deny` / `ask` are rule-emitted terminals. */
  readonly decision: "deny" | "ask" | "warning" | "note" | "error";
  /** `decision.reason` for terminals; `annotation.message` for annotations. */
  readonly reason: string;
  /** `decision.label` or `annotation.label` if the rule set one. */
  readonly label?: string;
  /** Event metadata: enough to correlate the decision with the harness call,
   *  without including the raw `toolInput` (hashed instead). */
  readonly event: {
    readonly eventName: string;
    readonly toolName: string;
    readonly cwd: string;
    readonly sessionId: string;
    /** sha256 hex of `JSON.stringify(event.toolInput)`. 64 chars. Consumers
     *  needing the raw input must capture it via their own pre-evaluate path. */
    readonly toolInputHash: string;
  };
  /** Wall-clock ms spent in the rule's `evaluate()` call that produced this
   *  decision. `0` for engine-emitted `error` annotations from pre-loop
   *  validation (no rule ran). */
  readonly timingMs: number;
}

/** Programmatic hook invoked per terminal decision and per annotation. Sync;
 *  throws are caught and surfaced as `error` annotations. See docs/SPEC.md
 *  § Observability for the full contract.
 *  @stable @since 1.0.0 */
export interface DecisionObserver {
  onDecision(record: DecisionEventRecord): void;
}
