// protectPath() builder — gates shell-side file access to protected paths
// (SA-06, #20). Two channels the shell wrapper otherwise can't cover: shell
// redirects (read/write ops) and a curated file-command table. `path()` only
// fires under the cc-tools adapter; this closes the Bash-side half.
// See docs/SPEC.md § Rule Builders.

import {
  findCalls,
  findRedirects,
  isDynamic,
  type ResolvedArg,
  resolvedCmd,
  type UnwrappedCall,
  unwrapCall,
  wordToLit,
} from "@questi0nm4rk/shell-ast";
import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import { escalate } from "../core/security.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";

/** Which file-access direction a `protectPath` rule guards. */
export type ProtectMode = "read" | "write" | "both";

type FileRole = "read" | "write";

/** How to pick file-path args out of a resolved call's `u.args` (flags are
 *  already separated). `positional` selects by index; `prefix` matches the
 *  `key=value` operand form (`dd of=…`). */
type FileArgSelector =
  | {
      readonly role: FileRole;
      readonly kind: "positional";
      readonly which: "all" | "last" | "allButLast";
    }
  | { readonly role: FileRole; readonly kind: "prefix"; readonly prefix: string };

/**
 * Curated file-touching commands (SA-06 clean core). Keyed by resolved
 * basename, so `/bin/cp` and `sudo cp` both match. Args are read off `u.args`.
 * The tail — any command NOT here — isn't covered by the table; compose an
 * explicit rule or rely on redirects. Deliberately small: resist growing this
 * toward "every CLI on earth". Commands needing flag-value consumption
 * (`truncate -s`, `sed -i`) are out of the clean core.
 */
const FILE_COMMANDS: Readonly<Record<string, readonly FileArgSelector[]>> = {
  cp: [
    { role: "read", kind: "positional", which: "allButLast" },
    { role: "write", kind: "positional", which: "last" },
  ],
  install: [
    { role: "read", kind: "positional", which: "allButLast" },
    { role: "write", kind: "positional", which: "last" },
  ],
  mv: [{ role: "write", kind: "positional", which: "last" }],
  ln: [{ role: "write", kind: "positional", which: "last" }],
  tee: [{ role: "write", kind: "positional", which: "all" }],
  rm: [{ role: "write", kind: "positional", which: "all" }],
  cat: [{ role: "read", kind: "positional", which: "all" }],
  dd: [
    { role: "read", kind: "prefix", prefix: "if=" },
    { role: "write", kind: "prefix", prefix: "of=" },
  ],
};

function modeIncludes(mode: ProtectMode, role: FileRole): boolean {
  return mode === "both" || mode === role;
}

function positionalArgs(
  args: readonly ResolvedArg[],
  which: "all" | "last" | "allButLast",
): readonly ResolvedArg[] {
  if (which === "all") {
    return args;
  }
  return which === "last" ? args.slice(-1) : args.slice(0, -1);
}

interface ScanResult {
  /** A concrete (resolved) path matched the pattern in a mode-relevant slot. */
  readonly match: boolean;
  /** A mode-relevant slot held a value the parser couldn't resolve. */
  readonly dynamic: boolean;
}

/** Scan shell redirects for read/write targets matching `pattern`. */
function scanRedirects(
  ast: NonNullable<Awaited<ReturnType<EvalContext["getBashAst"]>>>,
  mode: ProtectMode,
  pattern: RegExp,
): ScanResult {
  let dynamic = false;
  for (const role of ["read", "write"] as const) {
    if (!modeIncludes(mode, role)) {
      continue;
    }
    for (const redir of findRedirects(ast, { ops: role })) {
      const target = wordToLit(redir.word);
      if (target === null) {
        dynamic = true;
        continue;
      }
      if (pattern.test(target)) {
        return { match: true, dynamic };
      }
    }
  }
  return { match: false, dynamic };
}

/** Resolve a single selected arg to the path string it protects, or null when
 *  it isn't a `pattern` candidate (wrong prefix). Dynamic args are handled by
 *  the caller before this is reached. */
function selectorValue(arg: string, sel: FileArgSelector): string | null {
  if (sel.kind === "positional") {
    return arg;
  }
  return arg.startsWith(sel.prefix) ? arg.slice(sel.prefix.length) : null;
}

/** Scan the candidate args for one selector against `pattern`. */
function scanArgs(
  candidates: readonly ResolvedArg[],
  sel: FileArgSelector,
  pattern: RegExp,
): ScanResult {
  let dynamic = false;
  for (const arg of candidates) {
    if (isDynamic(arg)) {
      dynamic = true;
      continue;
    }
    const value = selectorValue(arg, sel);
    if (value !== null && pattern.test(value)) {
      return { match: true, dynamic };
    }
  }
  return { match: false, dynamic };
}

/** Scan ONE resolved call against the curated file-command table. */
function scanCall(u: UnwrappedCall, mode: ProtectMode, pattern: RegExp): ScanResult {
  const spec = FILE_COMMANDS[resolvedCmd(u) ?? ""];
  if (spec === undefined) {
    return { match: false, dynamic: false };
  }
  let dynamic = false;
  for (const sel of spec) {
    if (!modeIncludes(mode, sel.role)) {
      continue;
    }
    const candidates = sel.kind === "positional" ? positionalArgs(u.args, sel.which) : u.args;
    const result = scanArgs(candidates, sel, pattern);
    if (result.match) {
      return { match: true, dynamic };
    }
    if (result.dynamic) {
      dynamic = true;
    }
  }
  return { match: false, dynamic };
}

/** Scan every call in the AST for file-command access matching `pattern`. */
function scanCommands(
  ast: NonNullable<Awaited<ReturnType<EvalContext["getBashAst"]>>>,
  shellAstOpts: EvalContext["shellAstOpts"],
  mode: ProtectMode,
  pattern: RegExp,
): ScanResult {
  let dynamic = false;
  for (const call of findCalls(ast)) {
    const u = unwrapCall(call, shellAstOpts);
    if (u === null) {
      continue; // dynamic command word — cmd() rules own that case (SA-01)
    }
    const result = scanCall(u, mode, pattern);
    if (result.match) {
      return { match: true, dynamic };
    }
    if (result.dynamic) {
      dynamic = true;
    }
  }
  return { match: false, dynamic };
}

/**
 * Guard file access to paths matching `pattern` on the Bash side. Catches
 * shell redirects and a curated set of file commands (`cp`/`mv`/`install`/`ln`
 * last-arg writes, `tee`/`rm` all-arg writes, `cat` reads, `dd if=`/`of=`).
 * A dynamic target (`> $OUT`, `cp x $DST`) escalates per
 * `SecurityOptions.uncertaintyDecision` for terminal (deny/ask) rules;
 * annotation rules stay silent on dynamics.
 *
 *   protectPath(/^\/etc\//, { mode: "write" }).deny("no writes to /etc")
 *   protectPath(/\.env(\.|$)/, { mode: "both" }).ask("touches an env file")
 *
 * @experimental @since 0.9.0
 */
export function protectPath(
  pattern: RegExp,
  opts?: { mode?: ProtectMode },
): ProtectPathRuleBuilder {
  return new ProtectPathRuleBuilder(pattern, opts?.mode ?? "write");
}

class ProtectPathRuleBuilder {
  constructor(
    // biome-ignore lint/style/noParameterProperties: fluent-DSL builder state; explicit field+constructor doubles boilerplate per chainable.
    private readonly pattern: RegExp,
    // biome-ignore lint/style/noParameterProperties: fluent-DSL builder state, same as pattern above.
    private readonly mode: ProtectMode,
  ) {}

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  ask(reason: string, label?: string): Rule {
    return this.buildRule(askDecision(reason, label));
  }

  warning(message: string, label?: string): Rule {
    return this.buildRule(warningDecision(message, label));
  }

  note(message: string, label?: string): Rule {
    return this.buildRule(noteDecision(message, label));
  }

  private buildRule(decision: NonNullable<Decision>): Rule {
    const pattern = this.pattern;
    const mode = this.mode;
    const isTerminalRule = decision.kind === "deny" || decision.kind === "ask";
    return {
      kind: "protect-path",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) {
          return null;
        }
        const red = scanRedirects(ast, mode, pattern);
        if (red.match) {
          return decision;
        }
        const cmd = scanCommands(ast, ctx.shellAstOpts, mode, pattern);
        if (cmd.match) {
          return decision;
        }
        // A protected slot held an unresolvable target — for terminal rules,
        // escalate rather than silently allow (annotation rules stay silent).
        if ((red.dynamic || cmd.dynamic) && isTerminalRule) {
          const esc = escalate(
            ctx.security.uncertaintyDecision,
            `protected ${mode} path has a dynamic target — cannot verify`,
            decision.label,
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
