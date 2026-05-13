// cmd() builder — shell-ast based command matching
// See docs/SPEC.md § Rule Builders for semantics

import type { CallExprNode } from "@questi0nm4rk/shell-ast";
import { findCalls, isResolved, unwrapCall, wordToLit } from "@questi0nm4rk/shell-ast";
import {
  deny as denyDecision,
  escalate as escalateDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, EvalContext, HookEvent, Rule } from "../core/types.js";
import { expandFlags, hasFlag } from "../engine/helpers.js";

export function cmd(command: string, ...sub: string[]): CommandRuleBuilder {
  return new CommandRuleBuilder(command, sub);
}

class CommandRuleBuilder {
  constructor(
    private readonly command: string,
    private readonly sub: readonly string[],
    private flags: string[] = [],
    private noFlags: string[] = [],
    private argMatchPatterns: RegExp[] = [],
    private argIncludeValues: string[] = [],
    private requireDdash: boolean = false,
  ) {}

  withFlag(...flags: string[]): this {
    this.flags = [...this.flags, ...flags];
    return this;
  }

  withoutFlag(...flags: string[]): this {
    this.noFlags = [...this.noFlags, ...flags];
    return this;
  }

  argMatches(...patterns: RegExp[]): this {
    this.argMatchPatterns = [...this.argMatchPatterns, ...patterns];
    return this;
  }

  argIncludes(...values: string[]): this {
    this.argIncludeValues = [...this.argIncludeValues, ...values];
    return this;
  }

  /** Require the call to include the POSIX `--` end-of-options separator
   *  (e.g. `git checkout -- file` to discard, distinct from `git checkout file`). */
  withDdash(): this {
    this.requireDdash = true;
    return this;
  }

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  escalate(reason: string, label?: string): Rule {
    return this.buildRule(escalateDecision(reason, label));
  }

  /** Annotate matching invocations with a `[label] warning: <message>` line.
   *  Non-blocking: the command still runs. Use for security-relevant context
   *  the AI should see above its tool output. */
  warning(message: string, label?: string): Rule {
    return this.buildRule(warningDecision(message, label));
  }

  /** Same mechanics as `.warning()` but rendered as `[label] note: <message>`.
   *  Use for informational context where "warning" would overstate severity. */
  note(message: string, label?: string): Rule {
    return this.buildRule(noteDecision(message, label));
  }

  private buildRule(decision: NonNullable<Decision>): Rule {
    const cfg = {
      command: this.command,
      sub: [...this.sub] as readonly string[],
      flags: [...this.flags] as readonly string[],
      noFlags: [...this.noFlags] as readonly string[],
      argMatchPatterns: [...this.argMatchPatterns] as readonly RegExp[],
      argIncludeValues: [...this.argIncludeValues] as readonly string[],
      requireDdash: this.requireDdash,
    };
    return {
      kind: "command",
      async evaluate(_event: HookEvent, ctx: EvalContext): Promise<Decision> {
        const ast = await ctx.getBashAst();
        if (ast === null) return null;

        for (const call of findCalls(ast)) {
          const u = unwrapCall(call);
          if (u === null) continue;

          // Dispatch on the union — different shapes resolve to different
          // "what name does this call represent" answers. Sudo-aware
          // semantics (cmd("rm") fires on `sudo rm /`) live in the
          // "wrapped" branch via u.cmd. Shell-runners (`bash -c '…'`) and
          // opaque wrappers (`sudo $X`) report the wrapper, so a rule like
          // cmd("bash") fires on `bash -c '…'` directly and the engine's
          // inline-shell recursion handles the inner script separately.
          const name = u.kind === "plain" || u.kind === "wrapped" ? u.cmd : u.wrapper;
          if (name !== cfg.command) continue;

          // Match subcommands by position
          let subOk = true;
          for (let i = 0; i < cfg.sub.length; i++) {
            if (u.args[i] !== cfg.sub[i]) {
              subOk = false;
              break;
            }
          }
          if (!subOk) continue;

          // Flag predicates (alias-aware)
          const expanded = expandFlags(u.flags);
          if (!cfg.flags.every((f) => hasFlag(expanded, f))) continue;
          if (cfg.noFlags.some((f) => hasFlag(expanded, f))) continue;

          // Arg predicates
          if (!cfg.argIncludeValues.every((v) => u.args.includes(v))) continue;
          if (!cfg.argMatchPatterns.every((p) => u.args.some((a) => isResolved(a) && p.test(a)))) {
            continue;
          }

          // POSIX `--` end-of-options separator (e.g. git checkout -- file)
          if (cfg.requireDdash && !hasDdash(call)) continue;

          return decision;
        }
        return null;
      },
    };
  }
}

/** True if the call's raw arg list contains the POSIX `--` separator. */
function hasDdash(call: CallExprNode): boolean {
  return call.args.some((w) => wordToLit(w) === "--");
}
