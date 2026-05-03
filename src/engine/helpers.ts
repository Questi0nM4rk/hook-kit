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
