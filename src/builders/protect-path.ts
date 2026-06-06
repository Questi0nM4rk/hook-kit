// protectPath() builder — gates shell-side file access to protected paths
// (SA-06, #20). Two channels the shell wrapper otherwise can't cover: shell
// redirects (read/write ops) and a curated file-command table. `path()` only
// fires under the cc-tools adapter; this closes the Bash-side half.
// See docs/SPEC.md § Rule Builders.

import {
  DYNAMIC,
  findCalls,
  findRedirects,
  isDynamic,
  type ResolvedArg,
  resolvedCmd,
  tokensAfter,
  type UnwrappedCall,
  unwrapCall,
  type Word,
  wordToLit,
  wordToParts,
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
 *  `key=value` operand form (`dd of=…`); `targetDir` reads the value of a
 *  `-t`/`--target-directory` flag (cp/mv/install), which is NOT a positional. */
type FileArgSelector =
  | {
      readonly role: FileRole;
      readonly kind: "positional";
      readonly which: "all" | "last" | "allButLast";
    }
  | { readonly role: FileRole; readonly kind: "prefix"; readonly prefix: string }
  | { readonly role: FileRole; readonly kind: "targetDir" };

/** The flag whose VALUE is the write destination for cp/mv/install, given in
 *  space form (`-t DIR`). The next token is the value — read via the polymorphic
 *  `tokensAfter`, which surfaces a dynamic value (`-t $DST`) as DYNAMIC. */
const TARGET_DIR_SPACE_FLAG = "-t";
/** The `=`-attached long form (`--target-directory=DIR`). Read off the operand's
 *  literal prefix so the dynamic-value form (`--target-directory=$DST`, which
 *  shell-ast can't recognize as a flag) still escalates instead of falling
 *  through to the default last-positional write target. */
const TARGET_DIR_EQ_PREFIX = "--target-directory=";

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
  // The non-last positionals are SOURCES — a protected file moved/linked OUT is
  // a read of that path (caught under mode:"read"/"both"). See BUG 5.
  mv: [
    { role: "read", kind: "positional", which: "allButLast" },
    { role: "write", kind: "positional", which: "last" },
  ],
  ln: [
    { role: "read", kind: "positional", which: "allButLast" },
    { role: "write", kind: "positional", which: "last" },
  ],
  tee: [{ role: "write", kind: "positional", which: "all" }],
  rm: [{ role: "write", kind: "positional", which: "all" }],
  cat: [{ role: "read", kind: "positional", which: "all" }],
  dd: [
    { role: "read", kind: "prefix", prefix: "if=" },
    { role: "write", kind: "prefix", prefix: "of=" },
  ],
};

/** When a cp/mv/install call carries `-t DIR`/`--target-directory=DIR`, the
 *  write target is that flag value and EVERY positional is a source — replacing
 *  the default `which:last` write / `which:allButLast` read shape. */
const TARGET_DIR_SELECTORS: readonly FileArgSelector[] = [
  { role: "write", kind: "targetDir" },
  { role: "read", kind: "positional", which: "all" },
];

/** Commands whose `-t`/`--target-directory` flag redirects the write target. */
const TARGET_DIR_COMMANDS = new Set(["cp", "mv", "install"]);

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

/** The inner command's argument words (post-command-word, post-wrapper) — the
 *  raw `Word`s aligned with the operands shell-ast resolved into `u.args`. Used
 *  to recover the literal prefix of an operand whose VALUE is dynamic, which
 *  `u.args` collapses to a bare DYNAMIC (`of=$X` and `bs=$X` are both DYNAMIC).
 *  `plain` → `raw.args.slice(1)`; `wrapped` → `innerRaw.args.slice(1)`; the
 *  script/opaque variants have no resolvable inner operands. */
function innerArgWords(u: UnwrappedCall): readonly Word[] {
  if (u.kind === "plain") {
    return u.raw.args.slice(1);
  }
  if (u.kind === "wrapped") {
    return u.innerRaw.args.slice(1);
  }
  return [];
}

/** Candidate path values for a `prefix` selector (`dd of=`/`if=`), recovering
 *  the prefix even on dynamic-VALUE operands so an UNRELATED dynamic operand
 *  (`bs=$SIZE`) is dropped instead of poisoning the dynamic flag (BUG 8).
 *  Each prefix-matching operand contributes its resolved value, or DYNAMIC when
 *  only its value (not its prefix) is dynamic. */
function prefixCandidates(u: UnwrappedCall, prefix: string): ResolvedArg[] {
  const out: ResolvedArg[] = [];
  for (const word of innerArgWords(u)) {
    const parts = wordToParts(word);
    const head = parts[0];
    if (head?.kind !== "literal") {
      continue; // leading fragment isn't a literal — can't be a `prefix` operand
    }
    if (head.value === prefix && parts.length > 1) {
      // `prefix` followed by a dynamic value (`of=$OUT`) — selector-relevant.
      out.push(DYNAMIC);
      continue;
    }
    if (head.value.startsWith(prefix) && parts.length === 1) {
      out.push(head.value.slice(prefix.length)); // fully-literal `of=/etc/x`
    }
  }
  return out;
}

/** Concrete candidate path strings/DYNAMIC for one selector against a call. */
function selectorCandidates(u: UnwrappedCall, sel: FileArgSelector): readonly ResolvedArg[] {
  if (sel.kind === "positional") {
    return positionalArgs(u.args, sel.which);
  }
  if (sel.kind === "prefix") {
    return prefixCandidates(u, sel.prefix);
  }
  return targetDirValues(u);
}

/** Scan the candidate args for one selector against `pattern`. Every entry is
 *  already selector-relevant, so a DYNAMIC entry IS an uncertain protected slot. */
function scanArgs(candidates: readonly ResolvedArg[], pattern: RegExp): ScanResult {
  let dynamic = false;
  for (const arg of candidates) {
    if (isDynamic(arg)) {
      dynamic = true;
      continue;
    }
    if (pattern.test(arg)) {
      return { match: true, dynamic };
    }
  }
  return { match: false, dynamic };
}

/** Values of the target-directory flag (cp/mv/install): the `-t DIR` space form
 *  (via `tokensAfter`) plus the `--target-directory=DIR` operand form (via the
 *  prefix scan, so the dynamic-value `=$DST` form is caught too). */
function targetDirValues(u: UnwrappedCall): readonly ResolvedArg[] {
  return [...tokensAfter(u, TARGET_DIR_SPACE_FLAG), ...prefixCandidates(u, TARGET_DIR_EQ_PREFIX)];
}

/** True when a cp/mv/install call carries a target-directory flag — flips the
 *  selector set so the flag value is the write target and ALL positionals are
 *  sources (BUG 4). */
function hasTargetDir(u: UnwrappedCall): boolean {
  return targetDirValues(u).length > 0;
}

/** Selectors for one command, applying the `-t` target-directory override. */
function selectorsFor(
  u: UnwrappedCall,
  base: readonly FileArgSelector[],
): readonly FileArgSelector[] {
  if (TARGET_DIR_COMMANDS.has(resolvedCmd(u) ?? "") && hasTargetDir(u)) {
    return TARGET_DIR_SELECTORS;
  }
  return base;
}

/** Scan ONE resolved call against the curated file-command table. */
function scanCall(u: UnwrappedCall, mode: ProtectMode, pattern: RegExp): ScanResult {
  const base = FILE_COMMANDS[resolvedCmd(u) ?? ""];
  if (base === undefined) {
    return { match: false, dynamic: false };
  }
  let dynamic = false;
  for (const sel of selectorsFor(u, base)) {
    if (!modeIncludes(mode, sel.role)) {
      continue;
    }
    const result = scanArgs(selectorCandidates(u, sel), pattern);
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
 * last-arg writes + non-last-arg source reads, `cp`/`mv`/`install`
 * `-t`/`--target-directory=` write targets, `tee`/`rm` all-arg writes, `cat`
 * reads, `dd if=`/`of=`). A dynamic target (`> $OUT`, `cp x $DST`, `cp -t $D x`)
 * escalates per `SecurityOptions.uncertaintyDecision` for terminal (deny/ask)
 * rules; an UNRELATED dynamic operand (`dd bs=$N of=/tmp/x`) does not;
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
