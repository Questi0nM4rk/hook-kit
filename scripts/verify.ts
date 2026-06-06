#!/usr/bin/env bun
/**
 * One-command local + CI gate.
 *
 * @internal — orchestrator, not a public API. Runs every gate the repo
 * enforces (typecheck, lint, the full 3-process test split, the cross-doc
 * and suppression checks, markdownlint) plus the PR-only stability guards
 * (STABLE-export removals, CHANGELOG discipline). Failures are COLLECTED —
 * the runner does not stop at the first failure — and the summary names
 * every check that failed before exiting non-zero. Exit 0 prints an
 * all-passed line.
 *
 * Each check is spawned as its own subprocess (`Bun.spawnSync`, inherited
 * stdio) so the existing 3-process test isolation (oven-sh/bun#14516) and
 * each script's own exit-code semantics are preserved verbatim — verify
 * never re-implements a sub-check, it delegates.
 *
 * PR-only base resolution:
 *   - `--base <ref>` on the CLI wins (CI passes `origin/$BASE_REF`).
 *   - Otherwise auto-detect the default branch via `git rev-parse
 *     --abbrev-ref origin/HEAD` (→ e.g. `origin/main`, fallback
 *     `origin/main`). If it resolves AND HEAD differs from it, run the
 *     PR-only checks against that ref; otherwise print a skip line and
 *     continue (a local checkout sitting on the default branch is not a PR).
 *
 * Usage:
 *   bun scripts/verify.ts                       # local: auto-detect base
 *   bun scripts/verify.ts --base origin/main    # force the PR-only base ref
 *   bun scripts/verify.ts --only typecheck,lint # run only these checks
 *   bun scripts/verify.ts --skip test           # run all but these checks
 */

import { git } from "./_lib.js";

const SCRIPT = "verify";

export interface Check {
  /** Stable identifier used by --only / --skip and in the summary. */
  readonly name: string;
  /** argv for Bun.spawnSync. Non-empty tuple: argv[0] is the executable, so
   *  destructuring `[exe, ...rest]` yields a guaranteed `string` for `exe`
   *  (no empty-argv silent-spawn path). */
  readonly argv: readonly [string, ...string[]];
  /** PR-only checks need a base ref; skipped when none resolves. */
  readonly prOnly: boolean;
}

export interface Args {
  readonly base: string | null;
  readonly only: ReadonlySet<string> | null;
  readonly skip: ReadonlySet<string>;
}

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
}

export interface Summary {
  readonly code: number;
  readonly message: string;
}

export function parseList(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") {
      out.add(trimmed);
    }
  }
  return out;
}

/** Thrown by parseArgs on a usage error. `code` is the intended exit code;
 *  the top-level entrypoint prints the message + help and exits with it.
 *  Modelled as an exception (not an exit-in-place) so parseArgs stays pure
 *  and unit-testable without trapping `process.exit`. */
export class ArgError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = "ArgError";
    this.code = code;
  }
}

/** Read the value following a value-taking flag at `argv[i]`, requiring one
 *  exists. Throws ArgError(2) when the flag is last with no value. */
function requireValue(argv: readonly string[], i: number, flag: string): string {
  if (i + 1 >= argv.length) {
    throw new ArgError(`${SCRIPT}: ${flag} expects a value`, 2);
  }
  return argv[i + 1] ?? "";
}

export function parseArgs(argv: readonly string[]): Args {
  let base: string | null = null;
  let only: Set<string> | null = null;
  let skip = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") {
      const value = requireValue(argv, i, "--base");
      // Reject a flag-shaped value: `--base --only x` would otherwise consume
      // `--only` as the base ref and silently drop the real flag. Git refs
      // cannot begin with `-` (git check-ref-format), so reject-on-leading-dash
      // is a safe, unambiguous guard.
      if (value.startsWith("-")) {
        throw new ArgError(`${SCRIPT}: --base expects a ref, got flag-shaped '${value}'`, 2);
      }
      base = value;
      i += 1;
    } else if (a === "--only") {
      only = parseList(requireValue(argv, i, "--only"));
      i += 1;
    } else if (a === "--skip") {
      skip = parseList(requireValue(argv, i, "--skip"));
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new ArgError("--help", 0);
    } else {
      throw new ArgError(`${SCRIPT}: unrecognized arg '${String(a)}'`, 2);
    }
  }
  return { base, only, skip };
}

export function printHelp(): void {
  process.stderr.write(`\
${SCRIPT} — run every repo gate, collect failures, summarize.

Usage: bun scripts/verify.ts [--base <ref>] [--only <c1,c2>] [--skip <c1,c2>]

Runs (in order): typecheck, lint, test, check-suppress-comments,
check-doc-counts, check-output-table, markdownlint, and — when a base ref
resolves — the PR-only checks check-stable-exports and check-changelog.

  --base <ref>   Base ref for the PR-only checks (e.g. origin/main). When
                 omitted, auto-detected from origin/HEAD; skipped if HEAD
                 already is the default branch.
  --only <list>  Comma-separated check names; run only those.
  --skip <list>  Comma-separated check names; run all but those.

Exits 0 if every selected check passes; non-zero with a summary naming
each failed check otherwise. Exits 2 on argument errors or when --only /
--skip names an unknown check, or when nothing was selected to run.
`);
}

/** Resolve the PR-only base ref. Returns the explicit `--base` value when
 *  given; otherwise auto-detects the default branch and returns it only when
 *  HEAD differs from it (i.e. we're plausibly on a PR branch). Returns null
 *  to mean "skip the PR-only checks". */
export function resolveBase(explicit: string | null): string | null {
  if (explicit !== null && explicit !== "") {
    return explicit;
  }
  const head = git(["rev-parse", "HEAD"]);
  const def = git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const defaultRef = def.exitCode === 0 ? def.stdout.trim() : "origin/main";
  if (defaultRef === "") {
    return null;
  }
  const defaultSha = git(["rev-parse", defaultRef]);
  if (defaultSha.exitCode !== 0) {
    return null;
  }
  if (head.exitCode === 0 && head.stdout.trim() === defaultSha.stdout.trim()) {
    return null;
  }
  return defaultRef;
}

/** The non-PR-only checks — always present regardless of base. */
const CORE_CHECKS: readonly Check[] = [
  { name: "typecheck", argv: ["bun", "run", "typecheck"], prOnly: false },
  { name: "lint", argv: ["bun", "run", "lint"], prOnly: false },
  { name: "test", argv: ["bun", "run", "test"], prOnly: false },
  {
    name: "check-suppress-comments",
    argv: ["bun", "scripts/check-suppress-comments.ts", "--all"],
    prOnly: false,
  },
  { name: "check-doc-counts", argv: ["bun", "scripts/check-doc-counts.ts"], prOnly: false },
  { name: "check-output-table", argv: ["bun", "scripts/check-output-table.ts"], prOnly: false },
  {
    name: "markdownlint",
    argv: ["bunx", "--bun", "markdownlint-cli2", "**/*.md", "#node_modules/**", "#dist/**"],
    prOnly: false,
  },
];

/** Names of the PR-only checks. Their argv depends on the resolved base ref,
 *  so the runnable Check objects are built lazily in buildChecks — but the
 *  NAMES are static so --only / --skip validation has a complete universe
 *  even when no base resolves (otherwise `--only check-changelog` on a push
 *  run would wrongly report an unknown check). */
const PR_ONLY_CHECK_NAMES = ["check-stable-exports", "check-changelog"] as const;

/** Every check name verify knows about, base-independent. Validation of
 *  --only / --skip uses THIS set, not the base-dependent runnable list. */
export const ALL_CHECK_NAMES: ReadonlySet<string> = new Set<string>([
  ...CORE_CHECKS.map((c) => c.name),
  ...PR_ONLY_CHECK_NAMES,
]);

export function buildChecks(base: string | null): readonly Check[] {
  if (base === null) {
    return CORE_CHECKS;
  }
  return [
    ...CORE_CHECKS,
    {
      name: "check-stable-exports",
      argv: ["bun", "scripts/check-stable-exports.ts", "--base", base],
      prOnly: true,
    },
    {
      name: "check-changelog",
      argv: ["bun", "scripts/check-changelog.ts", "--base", base],
      prOnly: true,
    },
  ];
}

/** Validate that every name in --only / --skip refers to a real check.
 *  Returns the sorted list of unknown names (empty when all valid). */
export function unknownNames(selectors: ReadonlySet<string>, known: ReadonlySet<string>): string[] {
  const unknown: string[] = [];
  for (const name of selectors) {
    if (!known.has(name)) {
      unknown.push(name);
    }
  }
  return unknown.sort();
}

export function selected(check: Check, args: Args): boolean {
  if (args.only !== null && !args.only.has(check.name)) {
    return false;
  }
  return !args.skip.has(check.name);
}

/** Aggregate per-check results into an exit code + summary message. Pure over
 *  its inputs (no spawning, no process state) so the failure / all-pass /
 *  zero-selection logic is unit-testable in isolation. `requestedOnly` is the
 *  --only set (or null) and `baseResolved` whether a PR base was found — both
 *  used only to explain WHY nothing ran when `results` is empty. */
export function summarize(
  results: readonly CheckResult[],
  requestedOnly: ReadonlySet<string> | null,
  baseResolved: boolean,
): Summary {
  if (results.length === 0) {
    // Nothing ran. This is NEVER success — a valid-but-out-of-context --only
    // (e.g. a PR-only check on a push run with no base) or an all-skip would
    // otherwise masquerade as green. Exit non-zero and explain.
    const onlyList = requestedOnly === null ? "" : ` (--only ${[...requestedOnly].join(",")})`;
    const why = baseResolved
      ? ""
      : " — note: PR-only checks (check-stable-exports, check-changelog) are skipped when no base ref resolves";
    return { code: 2, message: `${SCRIPT}: no checks selected to run${onlyList}${why}` };
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length > 0) {
    return {
      code: 1,
      message: `${SCRIPT}: FAILED — ${String(failed.length)}/${String(results.length)} check(s): ${failed.join(", ")}`,
    };
  }
  return { code: 0, message: `${SCRIPT}: all ${String(results.length)} check(s) passed` };
}

function runCheck(check: Check): boolean {
  const [exe, ...rest] = check.argv;
  const tag = check.prOnly ? " [pr-only]" : "";
  process.stderr.write(`\n${SCRIPT}: >> ${check.name}${tag} (${check.argv.join(" ")})\n`);
  const result = Bun.spawnSync([exe, ...rest], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const ok = result.exitCode === 0;
  process.stderr.write(
    `${SCRIPT}: ${ok ? "PASS" : "FAIL"} ${check.name} (exit ${String(result.exitCode)})\n`,
  );
  return ok;
}

export function main(argv: readonly string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      if (err.message !== "--help") {
        process.stderr.write(`${err.message}\n`);
      }
      printHelp();
      return err.code;
    }
    throw err;
  }

  // Finding 4: validate --only / --skip against the FULL static universe of
  // check names, independent of whether a base resolved. A PR-only name is a
  // real check even when this run won't execute it.
  const bad = [
    ...unknownNames(args.only ?? new Set(), ALL_CHECK_NAMES),
    ...unknownNames(args.skip, ALL_CHECK_NAMES),
  ];
  if (bad.length > 0) {
    process.stderr.write(
      `${SCRIPT}: unknown check name(s): ${bad.join(", ")}\n` +
        `${SCRIPT}: known checks: ${[...ALL_CHECK_NAMES].join(", ")}\n`,
    );
    return 2;
  }

  const base = resolveBase(args.base);
  if (base === null) {
    process.stderr.write(`${SCRIPT}: skipping PR-only checks (no base ref)\n`);
  }

  const results: CheckResult[] = [];
  for (const check of buildChecks(base)) {
    if (!selected(check, args)) {
      continue;
    }
    results.push({ name: check.name, ok: runCheck(check) });
  }

  const summary = summarize(results, args.only, base !== null);
  process.stderr.write(`\n${summary.message}\n`);
  return summary.code;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
