// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import {
  findCalls,
  ParseSyntaxError,
  parse,
  type ShellFile,
  unwrapCall,
  WasmLoadError,
  WasmRuntimeError,
} from "@questi0nm4rk/shell-ast";
import { escalate as escalateDecision } from "../core/decision.js";
import type {
  Decision,
  EvalContext,
  HookEvent,
  HookModule,
  Rule,
  StateStore,
} from "../core/types.js";

export interface EvaluateOptions {
  readonly state?: StateStore;
  readonly shortCircuit?: boolean;
  /** Recurse into `bash -c "…"`, `eval "…"`, `exec "…"` so banned commands
   *  can't hide inside an inline shell. Default true. Disable for tests where
   *  recursion changes the asserted outcome. */
  readonly recurseInlineShells?: boolean;
  /** @internal Recursion depth — set by evaluate() when it self-calls. */
  readonly _depth?: number;
}

const MAX_RECURSE_DEPTH = 5;

/**
 * Test helper: evaluate a single rule against an event without hand-building
 * an EvalContext. Wraps the rule in a synthetic single-rule module whose
 * `events` matches the event and whose `matchers` is empty (so the matcher
 * check is skipped — the rule's own logic decides whether to fire). Returns
 * the engine's decision, with full inline-shell-recursion / state semantics
 * intact.
 *
 * Use in unit tests so test authors don't have to call `evaluate(event,
 * [createModule(…, [rule])])` boilerplate for every rule assertion. For
 * production hook entrypoints, keep using `createModule` + `evaluate` /
 * `run` / `runShell` — those carry the real module config (events list,
 * matchers, id) that drives per-event filtering.
 */
export async function evaluateRule(
  event: HookEvent,
  rule: Rule,
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const mod: HookModule = {
    id: "__test-rule",
    name: "__test-rule",
    events: [event.eventName],
    rules: [rule],
    enabled: true,
  };
  return evaluate(event, [mod], opts);
}

// shell-ast WASM-load (or any parse) failures are caught by getBashAst()
// per Iron Law 4 ("fail open on infra errors"). That keeps a framework bug
// from blocking the user, but it also silently disables every shell-AST
// rule with no signal — invisible loss of coverage. Emit a one-shot stderr
// warning on the first failure so operators can investigate.
let astErrorLogged = false;

/** @internal Reset hook used by tests to verify the once-per-process warning. */
export function __resetAstErrorLoggedForTests(): void {
  astErrorLogged = false;
}

/**
 * Evaluate all matching modules/rules against a hook event.
 * Returns Decision (action) or null (silent pass-through).
 * See docs/SPEC.md § Engine for the full contract.
 */
export async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts: EvaluateOptions = {},
): Promise<Decision> {
  const shortCircuit = opts.shortCircuit ?? true;
  const contextMessages: string[] = [];
  let terminalDecision: Decision = null;

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

      if (decision.kind === "deny" || decision.kind === "escalate") {
        if (shortCircuit) {
          await state.flush();
          return decision;
        }
        // shortCircuit=false: first terminal wins but evaluation continues so
        // later context messages still accumulate (useful for debugging /
        // observability). Later terminals are ignored.
        if (terminalDecision === null) terminalDecision = decision;
        continue;
      }

      if (decision.kind === "context") {
        contextMessages.push(decision.message);
      }
    }
  }

  // Inline-shell recursion: a banned command hidden inside `bash -c "rm -rf /"`
  // wouldn't trigger normal cmd() rules because the AST sees `bash`, not `rm`.
  // Re-parse and re-evaluate the inner script as a synthetic Bash event.
  if (
    terminalDecision === null &&
    (opts.recurseInlineShells ?? true) &&
    event.toolName === "Bash"
  ) {
    const depth = opts._depth ?? 0;
    if (depth >= MAX_RECURSE_DEPTH) {
      await state.flush();
      // Conservative: refuse to silently allow content that exceeds inspection depth.
      return escalateDecision("[hook-kit] inline-shell nesting exceeded inspection depth — review");
    }
    const ast = await ctx.getBashAst();
    if (ast !== null) {
      for (const call of findCalls(ast)) {
        // shell-ast 0.3+ surfaces `bash -c "…"`, `eval "…"`, `ksh -c "…"`, etc.
        // as kind="wrapped-script" with the inner source already extracted as
        // `u.script`. Other kinds (plain, wrapped, wrapped-opaque) are handled
        // by the normal rule pass — no recursion needed.
        const u = unwrapCall(call);
        if (u?.kind !== "wrapped-script") continue;
        const synthetic: HookEvent = {
          ...event,
          toolInput: { ...event.toolInput, command: u.script },
        };
        const inner = await evaluate(synthetic, modules, { ...opts, _depth: depth + 1, state });
        if (inner !== null) {
          if (inner.kind === "deny" || inner.kind === "escalate") {
            await state.flush();
            return inner;
          }
          if (inner.kind === "context") contextMessages.push(inner.message);
        }
      }
    }
  }

  await state.flush();

  if (terminalDecision !== null) return terminalDecision;

  if (contextMessages.length > 0) {
    return { kind: "context", message: contextMessages.join("\n\n") };
  }

  return null;
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
        // Distinguish infra failure (WASM didn't load — every AST-aware rule
        // is now disabled across the process) from per-input parse failure
        // (this one user command was malformed — other commands still parse).
        // The former is a coverage-loss incident that warrants a loud one-shot
        // warning; the latter is normal and silent (Iron Law 4).
        if (!astErrorLogged && (err instanceof WasmLoadError || err instanceof WasmRuntimeError)) {
          astErrorLogged = true;
          process.stderr.write(
            `[hook-kit] shell-ast WASM unavailable — command/pipe/redirect rules disabled for this process\n[hook-kit] details: ${err.message}\n`,
          );
        } else if (!astErrorLogged && !(err instanceof ParseSyntaxError)) {
          astErrorLogged = true;
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[hook-kit] shell-ast parse failed — command/pipe/redirect rules disabled for failed inputs\n[hook-kit] details: ${msg}\n`,
          );
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
