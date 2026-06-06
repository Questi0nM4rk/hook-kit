// Engine helpers — flag expansion utilities.
//
// Inline-shell extraction lives in shell-ast 0.3+ via the discriminated
// `UnwrappedCall` (kind: "wrapped-script") and is consumed in engine/index.ts.
// Wrapper-vs-command dispatch likewise switches on `u.kind` at the rule sites.

// Semantic flag aliases are SCOPED PER COMMAND (SA-07). A group lists short/
// long forms that mean the same thing *for that command*; matching one matches
// the rest. Global aliasing was a false-positive source: shell-ast bundle-
// splits `gcc -Dmacro` into [-D,-m,-a,-c,-r,-o], and a global `-r → --recursive`
// then made a stray `-r` match a `--recursive` rule on gcc. Scoping aliases to
// the destructive file-ops (where -r/-R/--recursive and -f/--force are
// standard) keeps those matches working while unlisted commands match flags
// literally.
//
// `-n` is intentionally excluded everywhere: it means `--no-verify` for
// `git commit`, `--dry-run` for `git push`, `--no-checkout` for `git clone`.
// Commands needing `-n` matching should use explicit subcommand-scoped rules.
// Alias groups must be per-command-accurate: `-r`/`-R` mean "recursive" for
// rm/cp, but `git diff -R` is reverse and `ln -r` is relative — so those get
// force-only. Keep this curated to commands whose aliases are reliable; the
// tail matches flags literally.
const RECURSIVE_FORCE: readonly (readonly string[])[] = [
  ["-r", "-R", "--recursive"],
  ["-f", "--force"],
];
const FORCE_ONLY: readonly (readonly string[])[] = [["-f", "--force"]];
// chmod/chown/chgrp recurse via -R only (`-r` is not their flag) and `-f` means
// --silent, NOT --force — so recursive-only, no force group.
const RECURSIVE_ONLY: readonly (readonly string[])[] = [["-R", "--recursive"]];

/** Per-command alias groups, keyed by resolved basename. */
const COMMAND_ALIASES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  rm: RECURSIVE_FORCE,
  cp: RECURSIVE_FORCE,
  git: FORCE_ONLY,
  mv: FORCE_ONLY,
  ln: FORCE_ONLY,
  chmod: RECURSIVE_ONLY,
  chown: RECURSIVE_ONLY,
  chgrp: RECURSIVE_ONLY,
};

// Directional (one→many) short-flag expansions, keyed by resolved basename.
// Unlike the symmetric groups above, these fan a single short flag out to the
// long forms it bundles WITHOUT the reverse: `git branch -D` is exactly
// `--delete --force`, and `-d` is `--delete`. Kept git-scoped (SA-07): a
// symmetric group would make a plain `--delete` rule also match `--force`, and
// re-introducing a global `-d` alias is the false-positive source SA-07 killed.
// This restores the shipped `cmd("git","branch").withFlag("--delete")
// .withFlag("--force")` rule's match on `git branch -D feature`.
const COMMAND_FLAG_EXPANSIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  git: {
    "-D": ["--delete", "--force"],
    "-d": ["--delete"],
  },
};

/**
 * Expand `flags` with the semantic aliases scoped to `command` (resolved
 * basename). A flag present in one of the command's alias groups pulls in the
 * rest of that group, so a rule written with the short or long form matches
 * the other. Commands with no registered aliases match flags literally
 * (deduped). Bundled-short splitting is shell-ast's job, not ours.
 */
export function expandFlags(flags: readonly string[], command: string): string[] {
  const result = new Set(flags);
  addAliasGroups(result, flags, COMMAND_ALIASES[command]);
  addDirectionalExpansions(result, flags, COMMAND_FLAG_EXPANSIONS[command]);
  return [...result];
}

/** Symmetric alias groups: any member present pulls in the whole group. */
function addAliasGroups(
  result: Set<string>,
  flags: readonly string[],
  groups: readonly (readonly string[])[] | undefined,
): void {
  if (groups === undefined) {
    return;
  }
  for (const flag of flags) {
    for (const group of groups) {
      if (group.includes(flag)) {
        for (const alias of group) {
          result.add(alias);
        }
      }
    }
  }
}

/** Directional short→long expansions: a short flag fans out to its long forms
 *  WITHOUT the reverse (see COMMAND_FLAG_EXPANSIONS). */
function addDirectionalExpansions(
  result: Set<string>,
  flags: readonly string[],
  expansions: Readonly<Record<string, readonly string[]>> | undefined,
): void {
  if (expansions === undefined) {
    return;
  }
  for (const flag of flags) {
    const longs = expansions[flag];
    if (longs !== undefined) {
      for (const long of longs) {
        result.add(long);
      }
    }
  }
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
