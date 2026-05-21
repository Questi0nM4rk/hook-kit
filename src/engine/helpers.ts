/** @internal — no stability promise, may move/rename in any release.
 *  Engine plumbing (flag expansion, unwrappedName helper) used by the
 *  builder primitives. Consumers should compose builder DSLs from
 *  `src/index.ts`; importing this module directly is not part of the
 *  v1.0 public surface.
 *
 *  Inline-shell extraction lives in shell-ast 0.3+ via the discriminated
 *  `UnwrappedCall` (kind: "wrapped-script") and is consumed in engine/index.ts.
 *  Wrapper-vs-command dispatch likewise switches on `u.kind` at the rule sites. */

const FLAG_GROUPS: readonly (readonly string[])[] = [
  ["-r", "--recursive", "-R"],
  ["-f", "--force"],
  ["-d", "--delete"],
];

// `-n` is intentionally excluded: it means `--no-verify` for `git commit`,
// `--dry-run` for `git push`, and `--no-checkout` for `git clone`. Commands
// that need `-n` matching should use explicit rules with subcommand scoping.

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

// ─── UnwrappedCall name dispatch (shared by command.ts + pipe.ts) ───────────

import { resolvedCmd, type UnwrappedCall } from "@questi0nm4rk/shell-ast";

/**
 * Project an `UnwrappedCall` onto the single "name that matters" for rule
 * matching. Two modes:
 *
 * **Default (`strictPath = false`)** — basename match via shell-ast's
 * polymorphic `resolvedCmd(u)`. Dispatches per kind:
 *
 * - `plain`          → basename of `args[0]` (so `cmd("git")` fires on `/usr/bin/git`)
 * - `wrapped`        → basename of inner cmd (sudo-aware: `cmd("rm")` fires on `sudo /usr/bin/rm /`)
 * - `wrapped-script` → basename of wrapper (`cmd("bash")` fires on `/usr/bin/bash -c '…'`)
 * - `wrapped-opaque` → basename of wrapper (`cmd("sudo")` fires on `sudo $X`)
 *
 * **Strict (`strictPath = true`)** — verbatim path-as-typed via `u.cmd` / `u.wrapper`.
 * Used by `cmd("/usr/bin/git").strictPath()` to require exact full-path match.
 *
 * Returns empty string only if `resolvedCmd` returns undefined (dynamic command
 * word) — empty-string match is impossible since `cmd("")` is meaningless.
 */
export function unwrappedName(u: UnwrappedCall, strictPath = false): string {
  if (strictPath) {
    return u.kind === "plain" || u.kind === "wrapped" ? u.cmd : u.wrapper;
  }
  return resolvedCmd(u) ?? "";
}
