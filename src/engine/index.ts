// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import { createHash } from "node:crypto";
import {
  findCalls,
  ParseSyntaxError,
  parse,
  type ResolveFlagsOptions,
  type ShellFile,
  unwrapDeepParsed,
  WasmLoadError,
  WasmRuntimeError,
} from "@questi0nm4rk/shell-ast";
import { deny as denyDecision, errorAnnotation } from "../core/decision.js";
import {
  HookKitError,
  ObserverError,
  RuleEvaluationError,
  ShellAstParseError,
  StateStoreError,
} from "../core/errors.js";
import { escalate, type SecurityOptions, STRICT_BUT_ASKS } from "../core/security.js";
import type {
  Annotation,
  Decision,
  DecisionEventRecord,
  DecisionObserver,
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
  /** Programmatic decision sinks. The engine fires `observer.onDecision(...)`
   *  per terminal decision AND per annotation, in array order. Observers
   *  are sync — for async sinks, enqueue and flush out-of-band. Throws are
   *  caught and surfaced as `error` annotations; the decision proceeds.
   *  Undefined / empty short-circuits all observer-construction work so the
   *  default path stays zero-overhead. See docs/SPEC.md § Observability. */
  readonly observers?: readonly DecisionObserver[];
  /** Security policy for the uncertainty path (issue #14): how to surface
   *  values the parser cannot statically certify (dynamic args, unparsable
   *  commands, recursion-depth exhaustion, engine unavailability). Default-
   *  filled to `STRICT_BUT_ASKS` at engine entry. Spread a profile to override
   *  a single knob: `{ ...STRICT_BUT_ASKS, onUnparsable: "deny" }`. */
  readonly security?: SecurityOptions;
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

/** Shell-interpreter wrappers whose `-c "<script>"` value (or, for `eval`,
 *  the concatenated positional args) is itself a shell script. Mirrors the
 *  script-wrapper rows of shell-ast's WRAPPERS registry. When such a wrapper
 *  has a DYNAMIC body (`bash -c "$X"`, `eval "$VAR"`), shell-ast yields a
 *  `wrapped-opaque` layer the recursion cannot re-parse — SA-02 escalates it.
 *  Non-shell wrappers (sudo, gosu, exec, env, xargs, timeout) are deliberately
 *  excluded: `sudo $X` is a dynamic command, not an inline-shell body.
 *  TODO(shell-ast): swap for an exported `isShellInterpreter`/WRAPPERS so this
 *  can't drift — tracked at Questi0nM4rk/shell-ast#12. */
const INLINE_SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "mksh",
  "dash",
  "ash",
  "eval",
  "su",
]);

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
    ...(opts.observers === undefined ? {} : { observers: opts.observers }),
    ...(opts.security === undefined ? {} : { security: opts.security }),
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

/** sha256-hex digest of `JSON.stringify(toolInput)`. 64 hex chars. Used to
 *  populate `DecisionEventRecord.event.toolInputHash`. Engine policy: the raw
 *  `toolInput` is NOT logged by default; observers correlate with the harness
 *  call via this hash + timestamp + sessionId. */
function hashToolInput(toolInput: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(toolInput)).digest("hex");
}

interface BuildRecordArgs {
  readonly event: HookEvent;
  readonly toolInputHash: string;
  readonly ruleId: string;
  readonly ruleKind: string;
  readonly decision: DecisionEventRecord["decision"];
  readonly reason: string;
  readonly label?: string;
  readonly timingMs: number;
}

/** Build a DecisionEventRecord for a decision the engine just emitted.
 *  `timingMs` is the per-rule bracket — `0` for engine-emitted errors with no
 *  associated rule timing (e.g., pre-loop validation, state-flush failures).
 *  `toolInputHash` is passed in pre-computed (cached per evaluation by the
 *  caller) so this helper stays O(1). */
function buildRecord(args: BuildRecordArgs): DecisionEventRecord {
  const base: Omit<DecisionEventRecord, "label"> = {
    timestamp: Date.now(),
    ruleId: args.ruleId,
    ruleKind: args.ruleKind,
    decision: args.decision,
    reason: args.reason,
    event: {
      eventName: args.event.eventName,
      toolName: args.event.toolName,
      cwd: args.event.cwd,
      sessionId: args.event.sessionId,
      toolInputHash: args.toolInputHash,
    },
    timingMs: args.timingMs,
  };
  return args.label === undefined ? base : { ...base, label: args.label };
}

/** Closed set of synthetic `ruleId` prefixes for engine-emitted error
 *  annotations (no rule context). Documents the contract and prevents typos
 *  at the call sites. */
type EngineErrorSource = "state-flush" | "shell-ast";

/** Args for the per-evaluation `notifyFor` closure inside `evaluateInternal`.
 *  The four ambient fields (event, toolInputHash, annotations, observers) come
 *  from the closure scope; this shape carries only the per-decision varying
 *  fields. Options-object form keeps the call sites readable and satisfies
 *  biome's `useMaxParams` cap. */
interface NotifyForArgs {
  readonly ruleId: string;
  readonly ruleKind: string;
  readonly decision: DecisionEventRecord["decision"];
  readonly reason: string;
  readonly label?: string;
  readonly timingMs: number;
}

/** Fire every registered observer with the record, in array order. Observer
 *  throws are caught and surfaced as `error` annotations on the outcome —
 *  the calling site keeps running and subsequent observers in the same array
 *  still fire. Per-observer throws DO NOT short-circuit the loop: an observer
 *  that throws is logged, then iteration continues to the next observer. The
 *  decision itself is unaffected (fail-open at the observer boundary). */
function notifyObservers(
  observers: readonly DecisionObserver[],
  record: DecisionEventRecord,
  annotations: Annotation[],
): void {
  for (let i = 0; i < observers.length; i++) {
    const observer = observers[i];
    if (observer === undefined) {
      continue; // dense array under noUncheckedIndexedAccess
    }
    try {
      observer.onDecision(record);
    } catch (cause) {
      annotations.push(errorAnnotation(new ObserverError(i, cause)));
    }
  }
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
  const { ctx, drainErrors, getParseFailure } = buildEvalContext(event, state, modules, {
    shellAstOpts: opts.shellAstOpts,
    security: opts.security ?? STRICT_BUT_ASKS,
  });

  // Observer machinery — short-circuit when nobody's listening so the default
  // path stays zero-overhead (no hash, no Date.now, no performance.now, no
  // per-rule timing bracket, no ruleId string allocation per rule).
  const obs = opts.observers ?? [];
  const observersActive = obs.length > 0;

  // Hash cache + per-decision notify closures are only allocated when
  // observers are active — when nobody's listening, none of this exists.
  let notifyFor: (args: NotifyForArgs) => void = () => {
    /* noop when observersActive=false; closure replaced below */
  };
  let notifyEngineError: (source: EngineErrorSource, err: HookKitError) => void = () => {
    /* noop when observersActive=false; closure replaced below */
  };
  if (observersActive) {
    // Cache the toolInputHash per evaluation: multiple decisions in this
    // frame share the same input → compute once, reuse for every record.
    // Recursive frames have their own synthetic event and compute their own.
    let toolInputHashCache: string | undefined;
    const getToolInputHash = (): string => {
      toolInputHashCache ??= hashToolInput(event.toolInput);
      return toolInputHashCache;
    };
    notifyFor = (args): void => {
      notifyObservers(
        obs,
        buildRecord({
          event,
          toolInputHash: getToolInputHash(),
          ruleId: args.ruleId,
          ruleKind: args.ruleKind,
          decision: args.decision,
          reason: args.reason,
          ...(args.label === undefined ? {} : { label: args.label }),
          timingMs: args.timingMs,
        }),
        annotations,
      );
    };
    // Engine-emitted errors have no rule context; use the synthetic
    // `<engine>:<source>` ruleId + timingMs=0 convention.
    notifyEngineError = (source, err): void => {
      notifyFor({
        ruleId: `<engine>:${source}`,
        ruleKind: source,
        decision: "error",
        reason: err.message,
        timingMs: 0,
      });
    };
  }

  const flushState = async (): Promise<void> => {
    try {
      await state.flush();
    } catch (cause) {
      const err =
        cause instanceof HookKitError ? cause : new StateStoreError("flush", undefined, cause);
      annotations.push(errorAnnotation(err));
      notifyEngineError("state-flush", err);
    }
  };

  /** Drain any errors captured by the EvalContext (currently: shell-ast parse
   *  failures from getBashAst). Called before every exit point so errors
   *  surface regardless of when the loop ends. */
  const drainContextErrors = (): void => {
    for (const err of drainErrors()) {
      annotations.push(errorAnnotation(err));
      notifyEngineError("shell-ast", err);
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

    for (let ruleIndex = 0; ruleIndex < mod.rules.length; ruleIndex++) {
      const rule = mod.rules[ruleIndex];
      if (rule === undefined) {
        continue; // dense array under noUncheckedIndexedAccess
      }
      // Skip ruleId string allocation when no observers are registered —
      // the empty string is never read in that path.
      const ruleId = observersActive ? `${mod.id}:${rule.kind}:${String(ruleIndex)}` : "";
      let decision: Decision;
      // Per-rule timing bracket; skipped when no observers are registered
      // to keep the default path zero-overhead.
      const ruleStart = observersActive ? performance.now() : 0;
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
        const errTimingMs = observersActive ? performance.now() - ruleStart : 0;
        notifyFor({
          ruleId,
          ruleKind: rule.kind,
          decision: "error",
          reason: err.message,
          timingMs: errTimingMs,
        });
        continue;
      }
      const timingMs = observersActive ? performance.now() - ruleStart : 0;
      if (decision === null) {
        continue;
      }

      if (decision.kind === "deny") {
        notifyFor({
          ruleId,
          ruleKind: rule.kind,
          decision: "deny",
          reason: decision.reason,
          ...(decision.label === undefined ? {} : { label: decision.label }),
          timingMs,
        });
        drainContextErrors();
        await flushState();
        return { terminal: decision, annotations: keepOnlyErrors(annotations) };
      }
      if (decision.kind === "ask") {
        notifyFor({
          ruleId,
          ruleKind: rule.kind,
          decision: "ask",
          reason: decision.reason,
          ...(decision.label === undefined ? {} : { label: decision.label }),
          timingMs,
        });
        terminal ??= decision;
        continue;
      }
      // warning / note / (rule-emitted error — type-allowed but engine never
      // produces this; if a rule somehow emits one, accumulate like any other)
      annotations.push(decision);
      notifyFor({
        ruleId,
        ruleKind: rule.kind,
        decision: decision.kind,
        reason: decision.message,
        ...(decision.label === undefined ? {} : { label: decision.label }),
        timingMs,
      });
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
      // SA-04: depth exhaustion escalates per onDepthExceeded (default ask).
      // `allow` falls back to whatever this frame already accumulated.
      const esc = escalate(
        ctx.security.onDepthExceeded,
        "[hook-kit] inline-shell nesting exceeded inspection depth — review",
      );
      return { terminal: esc ?? terminal, annotations };
    }
    const ast = await ctx.getBashAst();
    if (ast !== null) {
      for (const call of findCalls(ast)) {
        // biome-ignore lint/performance/noAwaitInLoops: shell-ast deep-unwrap is sync-ish but typed async; chained-wrapper recursion needs per-call ordering for the depth cap.
        const chain = await unwrapDeepParsed(call, parse, ctx.shellAstOpts);
        // SA-02: a shell-interpreter layer with a DYNAMIC body (eval "$X",
        // sh -c "$DYN", bash -c "$VAR"; including chained `sudo bash -c "$X"`)
        // surfaces as `wrapped-opaque` — there is no static script to re-parse,
        // so the wrapped-script path below would silently skip it. Escalate per
        // the security policy instead. Non-shell opaque wrappers (sudo $X) are
        // a dynamic command, not an inline-shell body — left out of scope.
        const opaqueShell = chain.find(
          (u) => u.kind === "wrapped-opaque" && INLINE_SHELL_WRAPPERS.has(u.wrapper),
        );
        if (opaqueShell?.kind === "wrapped-opaque") {
          const esc = escalate(
            ctx.security.uncertaintyDecision,
            `opaque inline-shell body (${opaqueShell.wrapper} with a dynamic script) — cannot inspect`,
          );
          if (esc?.kind === "deny") {
            drainContextErrors();
            await flushState();
            return { terminal: esc, annotations: keepOnlyErrors(annotations) };
          }
          if (esc?.kind === "ask") {
            terminal ??= esc;
          }
          continue;
        }
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

  // SA-03: apply the security policy for a parse failure discovered while
  // evaluating. engine-unavailable fails CLOSED (deny-all) by default — a dead
  // shell-AST engine can inspect nothing; unparsable escalates per onUnparsable
  // (ask by default). Both are distinct from a genuine deny a rule already
  // produced (handled above) and from infra fail-open (rule throw / state I/O).
  const parseFailure = getParseFailure();
  // A dead engine fails closed regardless of any non-deny terminal a custom
  // (non-AST) rule may have produced — deny-all overrides ask. (No deny can
  // reach here; every rule-produced deny short-circuits above.)
  if (parseFailure === "engine-unavailable" && ctx.security.onEngineUnavailable === "deny-all") {
    await flushState();
    return {
      terminal: denyDecision("[hook-kit] shell-AST engine unavailable — denying (fail-closed)"),
      annotations: keepOnlyErrors(annotations),
    };
  }
  if (parseFailure === "unparsable" && terminal === null) {
    const esc = escalate(
      ctx.security.onUnparsable,
      "[hook-kit] command could not be parsed — cannot verify",
    );
    if (esc?.kind === "deny") {
      await flushState();
      return { terminal: esc, annotations: keepOnlyErrors(annotations) };
    }
    if (esc?.kind === "ask") {
      terminal = esc;
    }
  }

  await flushState();
  return { terminal, annotations };
}

/** Route a thrown `parse()` error into the SA-03 buckets (kept out of
 *  `getBashAst` to hold its complexity under the cap):
 *  - WASM load/runtime failure → `engine-unavailable` (loud annotation +
 *    fail-per-onEngineUnavailable).
 *  - `ParseSyntaxError` → `unparsable` (no annotation — not infra — but
 *    escalate per onUnparsable; shell-ast may reject what bash would run).
 *  - anything else → unexpected; surface an annotation, no policy mark
 *    (legacy fail-open). */
function classifyParseError(cause: unknown): {
  failure: "unparsable" | "engine-unavailable" | null;
  annotate: boolean;
} {
  if (cause instanceof WasmLoadError || cause instanceof WasmRuntimeError) {
    return { failure: "engine-unavailable", annotate: true };
  }
  if (cause instanceof ParseSyntaxError) {
    return { failure: "unparsable", annotate: false };
  }
  return { failure: null, annotate: true };
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
  cfg: {
    readonly shellAstOpts: ResolveFlagsOptions | undefined;
    readonly security: SecurityOptions;
  },
): {
  ctx: EvalContext;
  drainErrors: () => HookKitError[];
  getParseFailure: () => "unparsable" | "engine-unavailable" | null;
} {
  let cached: ShellFile | null | undefined;
  const errors: HookKitError[] = [];
  // SA-03: distinguish "command can't be parsed" (ParseSyntaxError → escalate
  // per onUnparsable) from "the shell-AST engine itself is unavailable" (WASM
  // load/runtime failure → fail per onEngineUnavailable) from a genuine
  // unexpected infra error (legacy fail-open). Set only when parse() is
  // actually attempted, so an evaluation that never needs the AST is unaffected.
  let parseFailure: "unparsable" | "engine-unavailable" | null = null;
  return {
    ctx: {
      state,
      modules,
      security: cfg.security,
      ...(cfg.shellAstOpts === undefined ? {} : { shellAstOpts: cfg.shellAstOpts }),
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
          const { failure, annotate } = classifyParseError(cause);
          parseFailure = failure;
          if (annotate) {
            errors.push(new ShellAstParseError(command, cause));
          }
          cached = null;
        }
        return cached;
      },
    },
    drainErrors: () => errors.splice(0, errors.length),
    getParseFailure: () => parseFailure,
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
