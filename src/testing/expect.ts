// biome-ignore-all lint/style/noParameterProperties: fluent-runner classes use TS constructor parameter properties to keep stage transitions readable; explicit field+constructor adds boilerplate per stage.

// expectModule / expectRule — fluent runner for asserting module behavior
// against synthesized events. Two-stage builder:
//
//   Stage 1 (ExpectationBuilder): chained setup — withState, withShellAstOpts,
//   noInlineShellRecursion. Returns `this` for chaining.
//   Stage 2 (AssertionRunner): event chosen via onCommand/onWrite/onEdit/
//   onRead/withEvent. Returns a runner that exposes assertions.
//   Stage 3 (assertions): toDeny / toAsk / toRun / toWarn / toNote — async,
//   throws AssertionError on mismatch, returns the full EvaluationOutcome
//   for chained inspection.

import type { SecurityOptions } from "../core/security.js";
import type {
  Annotation,
  EvaluationOutcome,
  HookEvent,
  HookModule,
  Rule,
  StateStore,
} from "../core/types.js";
import type { EvaluateOptions } from "../engine/index.js";
import { evaluate } from "../engine/index.js";
import { bashEvent, editEvent, readEvent, writeEvent } from "./events.js";

/** Pattern arg accepted by terminal-reason / annotation-message assertions.
 *  RegExp uses `.test()`; string uses `===` (NOT substring) — strict equality
 *  to match the same model as Jest's `.toBe()` / `.toEqual()`.
 *  @stable @since 1.0.0 */
export type StringMatcher = RegExp | string;

function matches(value: string, pattern: StringMatcher): boolean {
  return pattern instanceof RegExp ? pattern.test(value) : value === pattern;
}

function formatAnnotations(anns: readonly Annotation[]): string {
  if (anns.length === 0) {
    return "(none)";
  }
  return anns.map((a) => `${a.kind}: "${a.message}"`).join(" | ");
}

function describeTerminal(out: EvaluationOutcome): string {
  if (out.terminal === null) {
    return "no terminal (would run)";
  }
  return `${out.terminal.kind}: "${out.terminal.reason}"`;
}

function formatPattern(p: StringMatcher): string {
  return p instanceof RegExp ? p.toString() : `"${p}"`;
}

/** Synthetic-event factory shorthand for `expectRule(rule)` — the wrapping
 *  module needs to declare every event name a rule might fire on, since
 *  the engine filters by `mod.events.includes(event.eventName)`. */
const ALL_EVENTS: readonly string[] = Object.freeze([
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreCompact",
  "Notification",
]);

class ExpectationBuilder {
  private state?: StateStore;
  private shellAstOpts?: EvaluateOptions["shellAstOpts"];
  private recurseInlineShells?: boolean;
  private security?: SecurityOptions;

  constructor(private readonly modules: readonly HookModule[]) {}

  /** Bind a `StateStore` (typically from `mockState`) for the evaluation. */
  withState(state: StateStore): this {
    this.state = state;
    return this;
  }

  /** Bind shell-ast resolver options for the evaluation. Most useful for
   *  registering per-tool `globalFlags` so tests of `terraform`/`kustomize`/
   *  etc. rules see their value-flags resolved correctly. */
  withShellAstOpts(opts: EvaluateOptions["shellAstOpts"]): this {
    this.shellAstOpts = opts;
    return this;
  }

  /** Disable inline-shell recursion (`bash -c "..."` inner evaluation) for
   *  this test only. Use sparingly — recursion is on by default in production
   *  and tests that disable it can mask bypass classes. */
  noInlineShellRecursion(): this {
    this.recurseInlineShells = false;
    return this;
  }

  /** Bind the security profile for the uncertainty path (issue #14). Set this
   *  to the SAME profile the consumer deploys with (e.g.
   *  `runShell(modules, { security: STRICT_DENY })`) so escalation of an
   *  uncertifiable value — dynamic command word, unparsable command,
   *  recursion-depth exhaustion — resolves identically in tests and prod.
   *  Omit to keep the engine default (`STRICT_BUT_ASKS`). */
  withSecurity(security: SecurityOptions): this {
    this.security = security;
    return this;
  }

  /** Provide a fully-constructed `HookEvent` (e.g. one of the `bashEvent`/
   *  `writeEvent`/`editEvent`/`readEvent` factories, or a custom shape).
   *  Use when the convenience builders below don't cover the test. */
  withEvent(event: HookEvent): AssertionRunner {
    return new AssertionRunner(this.modules, this.buildOpts(), event);
  }

  /** Bash event with `command` as `toolInput.command`. */
  onCommand(command: string): AssertionRunner {
    return this.withEvent(bashEvent(command));
  }

  /** Write event for `filePath` with optional `content`. */
  onWrite(filePath: string, content?: string): AssertionRunner {
    return this.withEvent(writeEvent(filePath, content));
  }

  /** Edit event for `filePath` with optional `oldStr` / `newStr`. */
  onEdit(filePath: string, oldStr?: string, newStr?: string): AssertionRunner {
    return this.withEvent(editEvent(filePath, oldStr, newStr));
  }

  /** Read event for `filePath`. */
  onRead(filePath: string): AssertionRunner {
    return this.withEvent(readEvent(filePath));
  }

  private buildOpts(): EvaluateOptions {
    const opts: EvaluateOptions = {
      ...(this.state === undefined ? {} : { state: this.state }),
      ...(this.shellAstOpts === undefined ? {} : { shellAstOpts: this.shellAstOpts }),
      ...(this.recurseInlineShells === undefined
        ? {}
        : { recurseInlineShells: this.recurseInlineShells }),
      ...(this.security === undefined ? {} : { security: this.security }),
    };
    return opts;
  }
}

class AssertionRunner {
  constructor(
    private readonly modules: readonly HookModule[],
    private readonly opts: EvaluateOptions,
    private readonly event: HookEvent,
  ) {}

  /** Run the evaluation and return the raw EvaluationOutcome. Use this when
   *  the assertion helpers below don't express the check you need (e.g.
   *  asserting on multiple annotations or on annotation order). */
  async outcome(): Promise<EvaluationOutcome> {
    return evaluate(this.event, this.modules, this.opts);
  }

  /** Assert the terminal is `deny`. If `reasonPattern` is given, the deny
   *  reason must match (RegExp.test or string ===). Throws AssertionError
   *  on mismatch; returns the outcome on success for chained inspection. */
  async toDeny(reasonPattern?: StringMatcher): Promise<EvaluationOutcome> {
    return this.assertTerminal("deny", reasonPattern);
  }

  /** Assert the terminal is `ask`. Same matching semantics as `toDeny`. */
  async toAsk(reasonPattern?: StringMatcher): Promise<EvaluationOutcome> {
    return this.assertTerminal("ask", reasonPattern);
  }

  /** Assert there is no terminal (the command would proceed to exec). Useful
   *  for negative cases — verifying a rule does NOT fire on a given input. */
  async toRun(): Promise<EvaluationOutcome> {
    const out = await this.outcome();
    if (out.terminal !== null) {
      throw new Error(`expected no terminal (would run), got ${describeTerminal(out)}`);
    }
    return out;
  }

  /** Assert at least one `warning` annotation fired. If `messagePattern` is
   *  given, at least one warning's message must match. */
  async toWarn(messagePattern?: StringMatcher): Promise<EvaluationOutcome> {
    return this.assertAnnotation("warning", messagePattern);
  }

  /** Assert at least one `note` annotation fired. Same matching semantics
   *  as `toWarn`. */
  async toNote(messagePattern?: StringMatcher): Promise<EvaluationOutcome> {
    return this.assertAnnotation("note", messagePattern);
  }

  /** Shared body for `toDeny` / `toAsk`. Checks `out.terminal.kind` matches
   *  and (if pattern given) reason satisfies the matcher. */
  private async assertTerminal(
    kind: "deny" | "ask",
    reasonPattern: StringMatcher | undefined,
  ): Promise<EvaluationOutcome> {
    const out = await this.outcome();
    if (out.terminal?.kind !== kind) {
      throw new Error(
        `expected ${kind} terminal, got ${describeTerminal(out)} (annotations: ${formatAnnotations(out.annotations)})`,
      );
    }
    if (reasonPattern !== undefined && !matches(out.terminal.reason, reasonPattern)) {
      throw new Error(
        `expected ${kind} reason matching ${formatPattern(reasonPattern)}, got "${out.terminal.reason}"`,
      );
    }
    return out;
  }

  /** Shared body for `toWarn` / `toNote`. Filters annotations by kind, asserts
   *  at least one and (if pattern given) at least one's message matches. */
  private async assertAnnotation(
    kind: "warning" | "note",
    messagePattern: StringMatcher | undefined,
  ): Promise<EvaluationOutcome> {
    const out = await this.outcome();
    const matchingKind = out.annotations.filter((a) => a.kind === kind);
    if (matchingKind.length === 0) {
      throw new Error(
        `expected at least one ${kind} annotation, got: ${formatAnnotations(out.annotations)}`,
      );
    }
    if (
      messagePattern !== undefined &&
      !matchingKind.some((a) => matches(a.message, messagePattern))
    ) {
      throw new Error(
        `expected ${kind} matching ${formatPattern(messagePattern)}, got ${kind}s: ${matchingKind
          .map((a) => `"${a.message}"`)
          .join(", ")}`,
      );
    }
    return out;
  }
}

/**
 * Fluent assertion runner over a `HookModule` (or array of modules). Use to
 * test rule firings against synthesized events without hand-building event
 * shapes / state stores / askpass scripts.
 *
 *   await expectModule(mod).onCommand("rm -rf /").toDeny(/blocked/);
 *
 *   await expectModule(mod)
 *     .withState(mockState({ "deletions:count": 5 }))
 *     .onCommand("rm /tmp/x")
 *     .toWarn(/quota/);
 *
 *   const out = await expectModule([modA, modB]).onCommand("git push").outcome();
 *   expect(out.annotations).toHaveLength(2);
 *
 *   // Reproduce the deploy-time security profile so uncertainty escalations
 *   // resolve the same in tests as in prod (issue #14):
 *   await expectModule(mod).withSecurity(STRICT_DENY).onCommand("$CMD -rf /").toDeny();
 * @stable @since 1.0.0
 */
export function expectModule(module: HookModule | readonly HookModule[]): ExpectationBuilder {
  const mods = Array.isArray(module) ? (module as readonly HookModule[]) : [module as HookModule];
  return new ExpectationBuilder(mods);
}

/**
 * Same as `expectModule`, but wraps a single rule in a synthetic module that
 * accepts every event name. Use to test a rule in isolation without building
 * a module by hand.
 *
 *   await expectRule(cmd("rm").deny("blocked"))
 *     .onCommand("rm -rf /")
 *     .toDeny();
 * @stable @since 1.0.0
 */
export function expectRule(rule: Rule): ExpectationBuilder {
  const mod: HookModule = {
    id: "__expect-rule",
    name: "__expect-rule",
    events: ALL_EVENTS,
    rules: [rule],
    enabled: true,
  };
  return expectModule(mod);
}
