// Engine helpers — flag expansion, redirect/pipe detection
// See docs/SPEC.md § Engine

// ─── Flag aliases ─────────────────────────────────────────────────────────────
//
// Each group lists all equivalent forms of the same flag. The bidirectional
// alias map is computed from these groups.
//
// `-n` is intentionally excluded: it means `--no-verify` for `git commit`,
// `--dry-run` for `git push`, and `--no-checkout` for `git clone`. Commands
// that need `-n` matching should use explicit rules with subcommand scoping.

const FLAG_GROUPS: readonly (readonly string[])[] = [
  ["-r", "--recursive", "-R"],
  ["-f", "--force"],
  ["-d", "--delete"],
];

/** Bidirectional alias map derived from FLAG_GROUPS. */
const FLAG_ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of FLAG_GROUPS) {
    for (const flag of group) {
      map.set(
        flag,
        group.filter((f) => f !== flag),
      );
    }
  }
  return map;
})();

/** Compound flag expansions: one flag expands to multiple canonical flags. */
const FLAG_EXPANSIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["-D", ["--delete", "--force"]],
]);

/**
 * Expand a list of flags by applying FLAG_EXPANSIONS and FLAG_ALIASES.
 * Result contains every original flag (including compound flags like `-D`)
 * plus their expansions and all alias equivalents, with full transitivity
 * through the alias graph. Duplicates are removed.
 */
export function expandFlags(flags: readonly string[]): string[] {
  const result = new Set<string>();

  for (const flag of flags) {
    result.add(flag);

    const expansion = FLAG_EXPANSIONS.get(flag);
    if (expansion !== undefined) {
      for (const f of expansion) {
        result.add(f);
      }
    }
  }

  // Add aliases — iterate until fixed point
  let prevSize = 0;
  while (result.size !== prevSize) {
    prevSize = result.size;
    for (const flag of [...result]) {
      const aliases = FLAG_ALIASES.get(flag);
      if (aliases !== undefined) {
        for (const alias of aliases) {
          result.add(alias);
        }
      }
    }
  }

  return [...result];
}

/**
 * Check whether `wanted` is present in `expanded`.
 * Uses startsWith to handle parameterized forms like `--force-with-lease=refspec`.
 *
 * Precondition: compound flags (e.g. `-D`) and aliases must be pre-expanded
 * via `expandFlags` before passing to this function.
 */
export function hasFlag(expanded: readonly string[], wanted: string): boolean {
  return expanded.some((f) => f === wanted || f.startsWith(`${wanted}=`));
}

// ─── Inline-shell extraction ─────────────────────────────────────────────────
//
// Detects `bash -c "…"`, `sh -c "…"`, `eval "…"`, `exec "…"` patterns and
// returns the embedded script source so the engine can recurse into it.
// Without this, hiding a banned command inside `bash -c` bypasses every rule.

import type { Word } from "@questi0nm4rk/shell-ast";
import { wordToLit } from "@questi0nm4rk/shell-ast";
import type { UnwrappedCall } from "@questi0nm4rk/shell-ast/semantic";

/** Commands whose first/-c argument re-enters a shell parser. */
export const INLINE_SHELL_CMDS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "ksh",
  "eval",
  "exec",
]);

/** Resolve a Word to a plain string. Handles Lit + SglQuoted + DblQuoted-with-
 *  literal-content parts; returns null for anything requiring shell expansion
 *  (e.g. $vars, command subst, parameter expansion). */
function wordToScript(word: Word): string | null {
  const chunks: string[] = [];
  for (const part of word.parts) {
    if (part.type === "Lit" || part.type === "SglQuoted") {
      chunks.push(part.value);
    } else if (part.type === "DblQuoted") {
      // Recurse into double-quoted parts; same literal-only constraint applies.
      // Allows nested forms like `bash -c "rm -rf /"` to resolve.
      let inner = "";
      let pure = true;
      for (const inside of part.parts) {
        if (inside.type === "Lit" || inside.type === "SglQuoted") {
          inner += inside.value;
        } else {
          pure = false;
          break;
        }
      }
      if (!pure) return null;
      chunks.push(inner);
    } else {
      return null;
    }
  }
  return chunks.length > 0 ? chunks.join("") : null;
}

/** Extract the inline script source from `bash -c '…'` / `eval '…'` / `exec '…'`.
 *  Returns null if the call isn't recognized, or the script word can't be
 *  resolved to a plain literal. */
export function extractInlineScript(unwrapped: UnwrappedCall): string | null {
  if (unwrapped.flags.includes("-c")) {
    let seenDashC = false;
    for (const word of unwrapped.raw.args) {
      const lit = wordToLit(word);
      if (lit === "-c") {
        seenDashC = true;
        continue;
      }
      if (seenDashC) return wordToScript(word);
    }
    return null;
  }
  if (unwrapped.cmd === "eval") {
    // POSIX eval concatenates all args with single spaces and re-parses.
    const parts = unwrapped.raw.args.slice(1).map(wordToScript);
    if (parts.length === 0 || parts.some((p) => p === null)) return null;
    return parts.filter((p): p is string => p !== null).join(" ");
  }
  if (unwrapped.cmd === "exec") {
    // exec replaces the process; inspect first arg only — no shell re-parse.
    const firstArg = unwrapped.raw.args[1];
    return firstArg !== undefined ? wordToScript(firstArg) : null;
  }
  return null;
}
