// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import {
  findCalls,
  ParseSyntaxError,
  parse,
  type ResolveFlagsOptions,
  type ShellFile,
  unwrapDeepParsed,
} from "@questi0nm4rk/shell-ast";
import { ask as askDecision, errorAnnotation } from "../core/decision.js";
import {
  HookKitError,
  RuleEvaluationError,
  ShellAstParseError,
  StateStoreError,
} from "../core/errors.js";
import type {
  Annotation,
  Decision,
  EvalContext,
  EvaluationOutcome,
  HookEvent,
  HookModule,
  Rule,
  StateStore,
  Terminal,
} from "../core/types.js";

/** @stable @since 1.0.0 */
export interface EvaluateOptions {
  readonly state?: StateStore;
  /** Recurse into `bash -c "…"`, `eval "…"`, `exec "…"` so banned commands
   *  can't hide inside an inline shell. Default true. Disable for tests where
   *  recursion changes the asserted outcome. */
  readonly recurseInlineShells?: boolean;
  /**
   * shell-ast resolver options threaded through every `unwrapCall(call, opts)`
   * call inside the engine and builder primitives. Primary use: register
   * per-tool value-taking flags via `globalFlags` so commands like
   * `terraform -chdir=./infra apply` resolve `apply` as `args[0]` instead of
   * being shifted out by the un-consumed `-chdir=...`.
   *
   * Example:
   *
   *   evaluate(event, modules, {
   *     shellAstOpts: {
   *       globalFlags: {
   *         terraform: ["-chdir", "-state"],
   *         kustomize: ["--load-restrictor"],
   *       },
   *     },
   *   });
   *
   * Undefined → shell-ast's built-in GLOBAL_VALUE_FLAGS table only (git,
   * docker, kubectl, make, tar, xargs).
   */
  readonly shellAstOpts?: ResolveFlagsOptions;
}

/** Internal evaluator state — never reachable from the public `evaluate()`
 *  signature, so a consumer can't pre-set `_depth` to skip the depth-limit
 *  check. Recursive self-calls go through `evaluateInternal` with an explicit
 *  depth arg instead of threading it through options. */
interface InternalState {
  readonly depth: number;
}

let MAX_RECURSE_DEPTH = 5;

/** @internal Lower the recursion depth cap so tests can hit the limit
 *  without nesting 5 layers of shell quoting gymnastics. Restore with the
 *  default `5` after each affected test. */
export function __setMaxRecurseDepthForTests(d: number): void {
  MAX_RECURSE_DEPTH = d;
}

/**
 * Test helper: evaluate a single rule against an event without hand-building
 * an EvalContext or module. Wraps the rule in a synthetic single-rule module
 * and returns the engine's chosen terminal decision (or null if only
 * annotations / no rule fired). Annotations are dropped — tests that care
 * about annotations should use `evaluate()` or `runModule()` directly and
 * assert on `outcome.annotations`.
 * @stable @since 1.0.0
 */
export async function evaluateRule(
  event: HookEvent,
  rule: Rule,
  opts: EvaluateOptions = {},
): Promise<Terminal | null> {
  const mod: HookModule = {
    id: "__test-rule",
    name: "__test-rule",
    events: [event.eventName],
    rules: [rule],
    enabled: true,
  };
  const outcome = await evaluate(event, [mod], opts);
  return outcome.terminal;
}

/** @stable @since 1.0.0 */
export interface RunModuleOptions extends EvaluateOptions {
  /** Module(s) to evaluate. Pass a single HookModule for the common single-
   *  module test case; pass an array for multi-module integration tests. */
  readonly module: HookModule | readonly HookModule[];
  /** Shortcut: builds a synthetic PreToolUse Bash event from this command.
   *  Use `event` instead for non-Bash tools or non-PreToolUse events. If
   *  both are given, `event` wins. */
  readonly command?: string;
  /** Full event override — use for non-Bash testing or event-specific behavior. */
  readonly event?: HookEvent;
}

/**
 * Test harness: evaluate a module (or modules) against a synthetic event and
 * return the full EvaluationOutcome (terminal + annotations). The shortcut
 * for writing tests without hand-building bash matrices or `bashEvent()`
 * fixtures.
 *
 * Example:
 *   const outcome = await runModule({
 *     module: createModule({...}, [cmd("rm").withFlag("-rf").deny("blocked")]),
 *     command: "rm -rf /tmp/x",
 *   });
 *   expect(outcome.terminal?.kind).toBe("deny");
 *
 * Both `command` (shortcut) and `event` (full override) are optional — if
 * neither is given, the harness uses an empty Bash command event, which is
 * useful for testing event-name / matcher logic without a real command.
 * @stable @since 1.0.0
 */
export async function runModule(opts: RunModuleOptions): Promise<EvaluationOutcome> {
  const modules = Array.isArray(opts.module)
    ? (opts.module as readonly HookModule[])
    : [opts.module as HookModule];
  const event = opts.event ?? defaultBashEvent(opts.command ?? "");
  const evalOpts: EvaluateOptions = {
    ...(opts.state === undefined ? {} : { state: opts.state }),
    ...(opts.recurseInlineShells === undefined
      ? {}
      : { recurseInlineShells: opts.recurseInlineShells }),
    ...(opts.shellAstOpts === undefined ? {} : { shellAstOpts: opts.shellAstOpts }),
  };
  return evaluate(event, modules, evalOpts);
}

/** Default synthetic event for the `command` shortcut — minimal PreToolUse
 *  Bash shape so the engine has somewhere to start. Mirrors `bashEvent()`
 *  in tests/_helpers.ts but lives in src/ so library consumers don't need
 *  to depend on the tests/ helper. */
function defaultBashEvent(command: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "test",
    cwd: "/tmp",
    transcriptPath: "",
    toolName: "Bash",
    toolInput: { command },
    raw: {},
  };
}

/**
 * Evaluate all matching modules/rules against a hook event.
 *
 * Returns an EvaluationOutcome bundling the chosen terminal (deny|ask,
 * or null) with every annotation (warning|note|error) that fired. Merge
 * policy:
 *
 * - `deny` short-circuits: terminate immediately. warning/note annotations
 *   are DROPPED (a deny means "the command must not run", and rule-emitted
 *   annotations are only useful when the command WILL run or the user is
 *   being asked). `error` annotations ALWAYS survive — they describe hook-
 *   infra failures, not rule output, and must remain visible.
 * - `ask` keeps evaluation going so annotations accumulate, but the
 *   FIRST ask wins terminal — later asks are dropped.
 * - `warning` / `note` always accumulate; multiple annotations are
 *   emitted in encounter order.
 * - `error` annotations are produced by the engine (never returned by a
 *   rule's evaluate()). Caught from: rule throws (HookKitError passed
 *   through; non-HookKit wrapped as RuleEvaluationError), shell-ast parse
 *   failures (ShellAstParseError, except ParseSyntaxError which is normal
 *   malformed user input), and state.flush failures (StateStoreError).
 *
 * See docs/SPEC.md § Engine for the full contract.
 * @stable @since 1.0.0
 */
export async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions = {},
): Promise<EvaluationOutcome> {
  return evaluateInternal(event, modules, opts, { depth: 0 });
}

/** Filter that keeps only `error` annotations — used when deny short-circuits. */
function keepOnlyErrors(anns: readonly Annotation[]): Annotation[] {
  return anns.filter((a) => a.kind === "error");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: engine evaluator — module/rule iteration + decision merging + annotation accumulation + recursion bookkeeping form one transactional pipeline; splitting loses ordering invariants.
async function evaluateInternal(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions,
  internal: InternalState,
): Promise<EvaluationOutcome> {
  const annotations: Annotation[] = [];
  let terminal: Terminal | null = null;

  const state = opts.state ?? noopState;
  const { ctx, drainErrors } = buildEvalContext(event, state, modules, opts.shellAstOpts);

  const flushState = async (): Promise<void> => {
    try {
      await state.flush();
    } catch (cause) {
      const err =
        cause instanceof HookKitError ? cause : new StateStoreError("flush", undefined, cause);
      annotations.push(errorAnnotation(err));
    }
  };

  /** Drain any errors captured by the EvalContext (currently: shell-ast parse
   *  failures from getBashAst). Called before every exit point so errors
   *  surface regardless of when the loop ends. */
  const drainContextErrors = (): void => {
    for (const err of drainErrors()) {
      annotations.push(errorAnnotation(err));
    }
  };

  for (const mod of modules) {
    if (mod.enabled === false) {
      continue;
    }
    if (!mod.events.includes(event.eventName)) {
      continue;
    }
    if (mod.matchers && mod.matchers.length > 0) {
      const matched = mod.matchers.some((m) =>
        m.split("|").some((part) => part === event.toolName),
      );
      if (!matched) {
        continue;
      }
    }

    for (const rule of mod.rules) {
      let decision: Decision;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: rules MUST execute sequentially — deny short-circuits, ask bundles, ordering is the merge-policy contract.
        decision = await rule.evaluate(event, ctx);
      } catch (cause) {
        // HookKitError thrown from a rule (e.g., FileReadError from content())
        // is surfaced as that specific class. Anything else means the rule
        // itself has a bug — wrap as RuleEvaluationError so the failure is
        // attributed to the rule, not silently swallowed (Iron Law 4 stays:
        // we don't block the user, but the error is visible).
        const err =
          cause instanceof HookKitError ? cause : new RuleEvaluationError(rule.kind, cause);
        annotations.push(errorAnnotation(err));
        continue;
      }
      if (decision === null) {
        continue;
      }

      if (decision.kind === "deny") {
        drainContextErrors();
        await flushState();
        return { terminal: decision, annotations: keepOnlyErrors(annotations) };
      }
      if (decision.kind === "ask") {
        terminal ??= decision;
        continue;
      }
      // warning / note / (rule-emitted error — type-allowed but engine never
      // produces this; if a rule somehow emits one, accumulate like any other)
      annotations.push(decision);
    }
  }

  // Inline-shell recursion: a banned command hidden inside `bash -c "rm -rf /"`
  // (or `sudo bash -c "rm -rf /"`) wouldn't trigger normal cmd() rules because
  // the outer AST sees `bash` / `sudo`, not `rm`. shell-ast 0.7's
  // `unwrapDeepParsed` walks the wrapper chain through inline-shell boundaries
  // and returns the layers outermost-first. We scan the chain for any
  // wrapped-script layer and feed its inner script back through evaluate() as
  // a synthetic event so the inner gets the full rule pass. Multi-level
  // chains are handled by the recursion's own unwrapDeepParsed walk; the
  // depth cap prevents runaway nesting.
  if ((opts.recurseInlineShells ?? true) && event.toolName === "Bash") {
    if (internal.depth >= MAX_RECURSE_DEPTH) {
      drainContextErrors();
      await flushState();
      return {
        terminal: askDecision("[hook-kit] inline-shell nesting exceeded inspection depth — review"),
        annotations,
      };
    }
    const ast = await ctx.getBashAst();
    if (ast !== null) {
      for (const call of findCalls(ast)) {
        // biome-ignore lint/performance/noAwaitInLoops: shell-ast deep-unwrap is sync-ish but typed async; chained-wrapper recursion needs per-call ordering for the depth cap.
        const chain = await unwrapDeepParsed(call, parse, ctx.shellAstOpts);
        const innerScript = chain.find((u) => u.kind === "wrapped-script");
        if (innerScript?.kind !== "wrapped-script") {
          continue;
        }
        const synthetic: HookEvent = {
          ...event,
          toolInput: { ...event.toolInput, command: innerScript.script },
        };
        const inner = await evaluateInternal(synthetic, modules, opts, {
          depth: internal.depth + 1,
        });
        if (inner.terminal?.kind === "deny") {
          drainContextErrors();
          await flushState();
          return {
            terminal: inner.terminal,
            annotations: keepOnlyErrors([...annotations, ...inner.annotations]),
          };
        }
        if (inner.terminal?.kind === "ask" && terminal === null) {
          terminal = inner.terminal;
        }
        annotations.push(...inner.annotations);
      }
    }
  }

  drainContextErrors();
  await flushState();
  return { terminal, annotations };
}

/**
 * Per-invocation context. The Bash AST is parsed lazily on first request and
 * cached for the lifetime of the context, so all `cmd()` rules within a single
 * `evaluate()` call share one parse.
 *
 * Errors that occur during AST parsing are captured into a closure list and
 * drained by the engine into the EvaluationOutcome.annotations as `error`
 * annotations — never silently swallowed. The exception is `ParseSyntaxError`,
 * which is normal malformed user input (the user typed garbage; bash will
 * reject it). WASM-load / WASM-runtime failures are coverage-loss signals
 * worth surfacing and are wrapped as `ShellAstParseError`.
 */
function buildEvalContext(
  event: HookEvent,
  state: StateStore,
  modules: readonly HookModule[],
  shellAstOpts: ResolveFlagsOptions | undefined,
): { ctx: EvalContext; drainErrors: () => HookKitError[] } {
  let cached: ShellFile | null | undefined;
  const errors: HookKitError[] = [];
  return {
    ctx: {
      state,
      modules,
      ...(shellAstOpts === undefined ? {} : { shellAstOpts }),
      async getBashAst(): Promise<ShellFile | null> {
        if (cached !== undefined) {
          return cached;
        }
        if (event.toolName !== "Bash") {
          cached = null;
          return cached;
        }
        const cmdInput = event.toolInput.command;
        const command = typeof cmdInput === "string" ? cmdInput : "";
        if (command === "") {
          cached = null;
          return cached;
        }
        try {
          cached = await parse(command);
        } catch (cause) {
          // ParseSyntaxError on user input is normal — bash will reject it
          // too, and we don't want to spam an error annotation on every
          // malformed line. WASM-load / WASM-runtime failures are coverage-
          // loss signals we want surfaced.
          if (!(cause instanceof ParseSyntaxError)) {
            errors.push(new ShellAstParseError(command, cause));
          }
          cached = null;
        }
        return cached;
      },
    },
    drainErrors: () => errors.splice(0, errors.length),
  };
}

// Noop StateStore stub: every method is intentionally empty — writes drop,
// delete is a no-op, flush has nothing to persist. The empty body IS the
// contract for the "no state configured" engine path. Inline comments
// satisfy both biome's noEmptyBlockStatements and eslint's no-empty-function.
const noopState: StateStore = {
  get: () => undefined,
  set: () => {
    /* noop — see noopState header comment */
  },
  has: () => false,
  delete: () => {
    /* noop — see noopState header comment */
  },
  flush: () => {
    /* noop — see noopState header comment */
  },
};
