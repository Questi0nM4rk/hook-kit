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

interface Check {
  /** Stable identifier used by --only / --skip and in the summary. */
  readonly name: string;
  /** argv for Bun.spawnSync (argv[0] is the executable). */
  readonly argv: readonly string[];
  /** PR-only checks need a base ref; skipped when none resolves. */
  readonly prOnly: boolean;
}

interface Args {
  readonly base: string | null;
  readonly only: ReadonlySet<string> | null;
  readonly skip: ReadonlySet<string>;
}

function parseList(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") {
      out.add(trimmed);
    }
  }
  return out;
}

function parseArgs(argv: readonly string[]): Args {
  let base: string | null = null;
  let only: Set<string> | null = null;
  let skip = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && i + 1 < argv.length) {
      base = argv[i + 1] ?? null;
      i += 1;
    } else if (a === "--only" && i + 1 < argv.length) {
      only = parseList(argv[i + 1]);
      i += 1;
    } else if (a === "--skip" && i + 1 < argv.length) {
      skip = parseList(argv[i + 1]);
      i += 1;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`${SCRIPT}: unrecognized arg '${String(a)}'\n`);
      printHelp();
      process.exit(2);
    }
  }
  return { base, only, skip };
}

function printHelp(): void {
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
each failed check otherwise. Exits 2 on argument errors.
`);
}

/** Resolve the PR-only base ref. Returns the explicit `--base` value when
 *  given; otherwise auto-detects the default branch and returns it only when
 *  HEAD differs from it (i.e. we're plausibly on a PR branch). Returns null
 *  to mean "skip the PR-only checks". */
function resolveBase(explicit: string | null): string | null {
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

function buildChecks(base: string | null): readonly Check[] {
  const checks: Check[] = [
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
  if (base !== null) {
    checks.push({
      name: "check-stable-exports",
      argv: ["bun", "scripts/check-stable-exports.ts", "--base", base],
      prOnly: true,
    });
    checks.push({
      name: "check-changelog",
      argv: ["bun", "scripts/check-changelog.ts", "--base", base],
      prOnly: true,
    });
  }
  return checks;
}

/** Validate that every name in --only / --skip refers to a real check.
 *  Returns the set of unknown names (empty when all valid). */
function unknownNames(selectors: ReadonlySet<string>, known: ReadonlySet<string>): string[] {
  const unknown: string[] = [];
  for (const name of selectors) {
    if (!known.has(name)) {
      unknown.push(name);
    }
  }
  return unknown.sort();
}

function selected(check: Check, args: Args): boolean {
  if (args.only !== null && !args.only.has(check.name)) {
    return false;
  }
  return !args.skip.has(check.name);
}

function runCheck(check: Check): boolean {
  const [exe, ...rest] = check.argv;
  const tag = check.prOnly ? " [pr-only]" : "";
  process.stderr.write(`\n${SCRIPT}: >> ${check.name}${tag} (${check.argv.join(" ")})\n`);
  const result = Bun.spawnSync([exe ?? "bun", ...rest], {
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

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const base = resolveBase(args.base);
  const checks = buildChecks(base);
  const knownNames = new Set(checks.map((c) => c.name));

  const bad = [
    ...unknownNames(args.only ?? new Set(), knownNames),
    ...unknownNames(args.skip, knownNames),
  ];
  if (bad.length > 0) {
    process.stderr.write(
      `${SCRIPT}: unknown check name(s): ${bad.join(", ")}\n` +
        `${SCRIPT}: known checks: ${[...knownNames].join(", ")}\n`,
    );
    return 2;
  }

  if (base === null) {
    process.stderr.write(`${SCRIPT}: skipping PR-only checks (no base ref)\n`);
  }

  const failed: string[] = [];
  let ran = 0;
  for (const check of checks) {
    if (!selected(check, args)) {
      continue;
    }
    ran += 1;
    if (!runCheck(check)) {
      failed.push(check.name);
    }
  }

  process.stderr.write("\n");
  if (failed.length > 0) {
    process.stderr.write(
      `${SCRIPT}: FAILED — ${String(failed.length)}/${String(ran)} check(s): ${failed.join(", ")}\n`,
    );
    return 1;
  }
  process.stderr.write(`${SCRIPT}: all ${String(ran)} check(s) passed\n`);
  return 0;
}

process.exit(main());
