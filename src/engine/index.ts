// evaluate() — core evaluation loop
// See docs/SPEC.md § Engine for the full contract

import { findCalls, parse, type ShellFile } from "@questi0nm4rk/shell-ast";
import { unwrapCall } from "@questi0nm4rk/shell-ast/semantic";
import { escalate as escalateDecision } from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, HookModule, StateStore } from "../core/types.js";
import { extractInlineScript, INLINE_SHELL_CMDS } from "./helpers.js";

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
        const unwrapped = unwrapCall(call);
        if (unwrapped === null) continue;
        // shell-ast 0.2+ treats bash/sh/etc as WRAPPERS, so `bash -c '…'` arrives with
        // wrapper="bash" and cmd=null (the inner script is opaque). Prefer wrapper for
        // the inline-shell check; fall back to cmd for legacy/non-wrapped forms (eval, exec).
        const shellName = unwrapped.wrapper ?? unwrapped.cmd;
        if (shellName === null || !INLINE_SHELL_CMDS.has(shellName)) continue;
        const inline = extractInlineScript(unwrapped);
        if (inline === null) continue;
        const synthetic: HookEvent = {
          ...event,
          toolInput: { ...event.toolInput, command: inline },
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
      } catch {
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
