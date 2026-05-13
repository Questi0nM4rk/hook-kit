// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import {
  findCalls,
  ParseSyntaxError,
  parse,
  type ShellFile,
  unwrapCall,
} from "@questi0nm4rk/shell-ast";
import { escalate as escalateDecision } from "../core/decision.js";
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

export interface EvaluateOptions {
  readonly state?: StateStore;
  /** Recurse into `bash -c "…"`, `eval "…"`, `exec "…"` so banned commands
   *  can't hide inside an inline shell. Default true. Disable for tests where
   *  recursion changes the asserted outcome. */
  readonly recurseInlineShells?: boolean;
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
 * about annotations should use `evaluate()` directly and assert on
 * `outcome.annotations`.
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

// shell-ast WASM-load failures are caught by getBashAst() per Iron Law 4
// ("fail open on infra errors"). That keeps a framework bug from blocking the
// user, but it also silently disables every shell-AST rule with no signal —
// invisible loss of coverage. Emit a one-shot stderr warning on the first
// failure so operators can investigate.
let astErrorLogged = false;

/** @internal Reset hook used by tests to verify the once-per-process warning. */
export function __resetAstErrorLoggedForTests(): void {
  astErrorLogged = false;
}

/** @internal Shared one-shot WASM-unavailable warning. Same latch used by the
 *  engine's parse() catch site and by the entrypoint preloadWasm() catch
 *  handlers so non-Bash sessions still get a signal when WASM is broken. */
export function warnAstUnavailable(err: unknown): void {
  if (astErrorLogged) return;
  astErrorLogged = true;
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[hook-kit] shell-ast WASM unavailable — command/pipe/redirect rules disabled for this process\n[hook-kit] details: ${msg}\n`,
  );
}

/**
 * Evaluate all matching modules/rules against a hook event.
 *
 * Returns an EvaluationOutcome bundling the chosen terminal (deny|escalate,
 * or null) with every annotation (warning|note) that fired. Merge policy:
 *
 * - `deny` short-circuits: terminate immediately, annotations DROPPED
 *   (a deny means "the command must not run", and annotations are only
 *   useful when the command WILL run or the user is being asked).
 * - `escalate` keeps evaluation going so annotations accumulate, but the
 *   FIRST escalate wins terminal — later escalates are dropped.
 * - `warning` / `note` always accumulate; multiple annotations are
 *   emitted in encounter order.
 *
 * See docs/SPEC.md § Engine for the full contract.
 */
export async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions = {},
): Promise<EvaluationOutcome> {
  return evaluateInternal(event, modules, opts, { depth: 0 });
}

async function evaluateInternal(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions,
  internal: InternalState,
): Promise<EvaluationOutcome> {
  const annotations: Annotation[] = [];
  let terminal: Terminal | null = null;

  const state = opts.state ?? noopState;
  const ctx = buildEvalContext(event, state, modules);

  for (const mod of modules) {
    if (mod.enabled === false) continue;
    if (!mod.events.includes(event.eventName)) continue;
    if (mod.matchers && mod.matchers.length > 0) {
      const matched = mod.matchers.some((m) =>
        m.split("|").some((part) => part === event.toolName),
      );
      if (!matched) continue;
    }

    for (const rule of mod.rules) {
      let decision: Decision;
      try {
        decision = await rule.evaluate(event, ctx);
      } catch {
        // Iron Law 3: fail open on infrastructure errors
        continue;
      }
      if (decision === null) continue;

      if (decision.kind === "deny") {
        await state.flush();
        return { terminal: decision, annotations: [] };
      }
      if (decision.kind === "escalate") {
        if (terminal === null) terminal = decision;
        continue;
      }
      // warning / note
      annotations.push(decision);
    }
  }

  // Inline-shell recursion: a banned command hidden inside `bash -c "rm -rf /"`
  // wouldn't trigger normal cmd() rules because the outer AST sees `bash`,
  // not `rm`. shell-ast 0.3 surfaces these as kind="wrapped-script" with the
  // inner source as u.script; we feed that back through evaluate() as a
  // synthetic event so the inner script gets the full rule pass.
  if ((opts.recurseInlineShells ?? true) && event.toolName === "Bash") {
    if (internal.depth >= MAX_RECURSE_DEPTH) {
      await state.flush();
      // Conservative: refuse to silently allow content exceeding inspection depth.
      return {
        terminal: escalateDecision(
          "[hook-kit] inline-shell nesting exceeded inspection depth — review",
        ),
        annotations,
      };
    }
    const ast = await ctx.getBashAst();
    if (ast !== null) {
      for (const call of findCalls(ast)) {
        // shell-ast 0.3+ surfaces `bash -c "…"`, `eval "…"`, `ksh -c "…"`,
        // etc. as kind="wrapped-script" with the inner source as u.script.
        // We feed that back through evaluate() as a synthetic event so the
        // inner script gets the full rule pass — the recursive getBashAst
        // does the inner parse() exactly once, same as if a user had typed
        // the inner command directly. (Considered threading innerAst from
        // `unwrapCallParsed` to skip the recursive parse, but the parse
        // count is identical either way: shell-ast still parses the inner
        // string once. The simpler form wins on KISS grounds.)
        const u = unwrapCall(call);
        if (u?.kind !== "wrapped-script") continue;
        const synthetic: HookEvent = {
          ...event,
          toolInput: { ...event.toolInput, command: u.script },
        };
        const inner = await evaluateInternal(synthetic, modules, opts, {
          depth: internal.depth + 1,
        });
        if (inner.terminal?.kind === "deny") {
          await state.flush();
          return { terminal: inner.terminal, annotations: [] };
        }
        if (inner.terminal?.kind === "escalate" && terminal === null) {
          terminal = inner.terminal;
        }
        annotations.push(...inner.annotations);
      }
    }
  }

  await state.flush();
  return { terminal, annotations };
}

/**
 * Per-invocation context. The Bash AST is parsed lazily on first request and
 * cached for the lifetime of the context, so all `cmd()` rules within a single
 * `evaluate()` call share one parse.
 */
function buildEvalContext(
  event: HookEvent,
  state: StateStore,
  modules: readonly HookModule[],
): EvalContext {
  let cached: ShellFile | null | undefined;
  return {
    state,
    modules,
    async getBashAst(): Promise<ShellFile | null> {
      if (cached !== undefined) return cached;
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
      } catch (err) {
        // Per-input ParseSyntaxError is a normal malformed command — stay
        // silent (Iron Law 4). Everything else (WasmLoadError, WasmRuntimeError,
        // or an unknown class) means every AST-aware rule is disabled for at
        // least this input and likely the whole process — emit the one-shot
        // coverage-loss warning so operators can see it.
        if (!(err instanceof ParseSyntaxError)) {
          warnAstUnavailable(err);
        }
        cached = null;
      }
      return cached;
    },
  };
}

const noopState: StateStore = {
  get: () => undefined,
  set: () => {},
  has: () => false,
  delete: () => {},
  flush: () => {},
};
