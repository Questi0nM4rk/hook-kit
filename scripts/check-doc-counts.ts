#!/usr/bin/env bun
/**
 * Cross-doc count-drift audit.
 *
 * @internal — CI guard, not a public API.
 *
 * Guards against silent drift between counts claimed in docs and the
 * actual source counts. Three batches of M1 caught the drift manually
 * (CLAUDE.md 8→9 in M1.2, SPEC.md 8→10 in M1.4, missing-target
 * `./state` subpath in M1.5). This script automates the audit so the
 * fourth occurrence fails CI loudly instead of slipping through.
 *
 * Currently audits:
 *
 *   1. HookKitError subclass count — diffed against `src/core/errors.ts`
 *      across CLAUDE.md / docs/SPEC.md / docs/ADAPTERS.md. Each doc may
 *      phrase the claim differently (table cell, prose, paren-list); the
 *      audit collects ALL count matches in each doc and requires every
 *      one to equal the source count.
 *
 *   2. package.json subpath exports — every `import` and `types` target
 *      must point to a file that exists on disk. L-M1.5-1 caught
 *      `./state → src/state/types.ts` advertised but absent until M1.5.
 *
 *   3. Test-count claims — the authoritative total is derived by running
 *      the same three suites the npm `test` script runs (`tests/`,
 *      `tests-isolated/`, `examples/adapter-template/tests/`) and summing
 *      each suite's `Ran (\d+) tests` line. Every `N tests` /
 *      `N TypeScript tests` claim in README.md + CLAUDE.md must equal that
 *      sum. (README claimed a stale 418; CLAUDE.md a stale 586+.)
 *
 *   4. README version markers — a hardcoded `Current: vX.Y.Z` /
 *      `Status: vX.Y.Z` in README.md that disagrees with package.json's
 *      version fails. Preferred state: none (rely on the npm version
 *      badge). README drifted to `Current: 0.7.0` while package.json was
 *      0.8.0; this guards the regression.
 *
 * Extending: add new audits as count-claims accumulate. Each audit
 * returns its violations into `violations[]`; the main loop reports all
 * and exits 1 on any non-empty.
 *
 * Usage:
 *   bun scripts/check-doc-counts.ts          # run all audits
 *   bun scripts/check-doc-counts.ts --quiet  # only print on failure
 *
 * Exit codes:
 *   0  every audit passed
 *   1  one or more audits found drift
 *   2  argument-parse or file-read failure
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = "check-doc-counts";

interface Args {
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args | null {
  let quiet = false;
  for (const a of argv) {
    if (a === "--quiet") {
      quiet = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`${SCRIPT}: unrecognized arg '${a}'\n`);
      printHelp();
      return null;
    }
  }
  return { quiet };
}

function printHelp(): void {
  process.stderr.write(`\
check-doc-counts — audit cross-doc count claims against source truth.

Usage: bun scripts/check-doc-counts.ts [--quiet]

Audits:
  1. HookKitError subclass count vs src/core/errors.ts
     (CLAUDE.md, docs/SPEC.md, docs/ADAPTERS.md)
  2. package.json subpath exports — every target file must exist
  3. Test-count claims (README.md, CLAUDE.md) vs the summed
     'Ran N tests' across the three npm-test suites
  4. README version markers (Current:/Status: vX.Y.Z) vs package.json

Exits 0 if all audits pass.
Exits 1 if any audit found drift.
Exits 2 on argument or file-read errors.
`);
}

interface Violation {
  readonly audit: string;
  readonly detail: string;
}

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${SCRIPT}: cannot read ${path}: ${msg}\n`);
    return null;
  }
}

/** Count `export class XxxError extends HookKitError` declarations in
 *  `src/core/errors.ts`. The match is anchored at line start to keep
 *  string-literal occurrences of the same shape out of the count
 *  (errors.ts has no such literals today; the anchor is forward-defence). */
function sourceSubclassCount(source: string): number {
  const re = /^export class \w+Error extends HookKitError/gm;
  return source.match(re)?.length ?? 0;
}

/** Match every count claim of the form "N HookKitError subclass[es]",
 *  "N classes — …HookKitError…", "N subclasses in src/core/errors.ts",
 *  or "N typed `HookKitError` …". Backticks around `HookKitError` are
 *  optional so prose and table-cell variants both match. The matcher
 *  returns the captured integers; the caller compares each against the
 *  source count. */
function extractSubclassCountClaims(content: string): readonly number[] {
  const claims: number[] = [];
  // Phrasings observed across docs (2026-05-22):
  //   "10 `HookKitError` subclasses"       — CLAUDE.md table cell + ADAPTERS.md prose
  //   "10 subclasses in src/core/errors.ts"— CLAUDE.md 0-silent-fails bullet
  //   "(10 classes — FileReadError, …"     — SPEC.md exception-hierarchy paren-list
  const patterns: readonly RegExp[] = [
    /(\d+)\s+`?HookKitError`?\s+subclasses?\b/g,
    /(\d+)\s+subclasses?\s+in\s+`?src\/core\/errors\.ts/g,
    /\((\d+)\s+classes\s+—\s+[A-Z]\w*Error/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical /g regex iteration over `content`; assignment-in-while is the documented MDN pattern.
    while ((match = re.exec(content)) !== null) {
      const n = Number.parseInt(match[1] ?? "", 10);
      if (Number.isFinite(n)) {
        claims.push(n);
      }
    }
  }
  return claims;
}

function auditHookKitErrorCount(violations: Violation[]): boolean {
  const AUDIT = "hookkit-error-count";
  const source = readFile("src/core/errors.ts");
  if (source === null) {
    return false;
  }
  const truth = sourceSubclassCount(source);
  if (truth === 0) {
    violations.push({
      audit: AUDIT,
      detail:
        "src/core/errors.ts: no `export class XxxError extends HookKitError` declarations found",
    });
    return false;
  }

  const docs: readonly string[] = ["CLAUDE.md", "docs/SPEC.md", "docs/ADAPTERS.md"];
  let anyFailure = false;
  for (const doc of docs) {
    const content = readFile(doc);
    if (content === null) {
      anyFailure = true;
      continue;
    }
    const claims = extractSubclassCountClaims(content);
    // No claim is fine — not every doc carries one; we only fail on a
    // claim that disagrees with the source-of-truth count.
    for (const claim of claims) {
      if (claim !== truth) {
        violations.push({
          audit: AUDIT,
          detail: `${doc}: claims ${String(claim)} HookKitError subclasses; src/core/errors.ts has ${String(truth)}`,
        });
        anyFailure = true;
      }
    }
  }
  return !anyFailure;
}

interface PackageExports {
  readonly exports?: Record<string, unknown>;
}

function auditPackageJsonExportTargets(violations: Violation[]): boolean {
  const AUDIT = "package-json-export-targets";
  const raw = readFile("package.json");
  if (raw === null) {
    return false;
  }
  let pkg: PackageExports;
  try {
    pkg = JSON.parse(raw) as PackageExports;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({ audit: AUDIT, detail: `package.json: parse failed (${msg})` });
    return false;
  }
  const exportsField = pkg.exports;
  if (exportsField === undefined || typeof exportsField !== "object") {
    return true;
  }

  let anyFailure = false;
  for (const [subpath, entry] of Object.entries(exportsField)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    // Each entry maps condition names ("import", "types", "default", …)
    // to file paths. Conditions like { node: { import: "…" } } can nest;
    // one level of recursion covers that. Today the package.json is flat;
    // the recursion is forward-defence.
    walkExportEntry(subpath, entry as Record<string, unknown>, violations, () => {
      anyFailure = true;
    });
  }
  return !anyFailure;
}

/** Conditions whose targets are build artifacts (e.g. `dist/types/**`)
 *  that only exist after `bun run build`. CI must NOT fail when these are
 *  absent on a fresh checkout — the build step would error first. The
 *  audit is checking the `import` condition (source path) where the
 *  L-M1.5-1 `./state → src/state/types.ts` drift actually occurred. */
const BUILD_ARTIFACT_CONDITIONS = new Set<string>(["types"]);

function walkExportEntry(
  subpath: string,
  entry: Record<string, unknown>,
  violations: Violation[],
  onFailure: () => void,
): void {
  const AUDIT = "package-json-export-targets";
  for (const [condition, value] of Object.entries(entry)) {
    if (BUILD_ARTIFACT_CONDITIONS.has(condition)) {
      continue;
    }
    if (typeof value === "string") {
      const target = resolve(process.cwd(), value);
      if (!existsSync(target)) {
        violations.push({
          audit: AUDIT,
          detail: `package.json exports: '${subpath}.${condition}' → '${value}' does not exist`,
        });
        onFailure();
      }
    } else if (typeof value === "object" && value !== null) {
      walkExportEntry(
        `${subpath}.${condition}`,
        value as Record<string, unknown>,
        violations,
        onFailure,
      );
    }
  }
}

/** The three suites the npm `test` script exercises. `tests/` is run via the
 *  coverage wrapper in the actual script; here we invoke it directly with
 *  `bun test tests/` since we only need the `Ran N tests` count, not coverage.
 *  Keep this list in sync with the `test` script in package.json. */
const TEST_SUITES: readonly string[] = [
  "tests/",
  "tests-isolated/",
  "examples/adapter-template/tests/",
];

/** Run `bun test <dir>` and return the `Ran (\d+) tests` total parsed from
 *  stderr (bun writes the run summary there). Returns null if the suite
 *  produced no parseable summary line — caller treats that as a read-failure
 *  rather than silently undercounting. */
function suiteTestCount(dir: string): number | null {
  const r = Bun.spawnSync(["bun", "test", dir], { stdout: "pipe", stderr: "pipe" });
  const stderr = r.stderr.toString("utf8");
  // Last `Ran N test(s)` line is the suite total (bun prints one at the end).
  // The noun is singular when N === 1 ("Ran 1 test across 1 file"), so the
  // trailing `s` is optional — otherwise a one-test suite parses as null.
  const matches = [...stderr.matchAll(/Ran (\d+) tests?\b/g)];
  const last = matches.at(-1);
  if (last?.[1] === undefined) {
    process.stderr.write(
      `${SCRIPT}: 'bun test ${dir}' produced no 'Ran N tests' line (exit ${String(r.exitCode)}); ` +
        "cannot derive the authoritative test count.\n",
    );
    return null;
  }
  return Number.parseInt(last[1], 10);
}

/** Authoritative test total = sum of the three npm-test suites' `Ran N`
 *  counts. Returns null if any suite couldn't be counted. */
function authoritativeTestTotal(): number | null {
  let total = 0;
  for (const dir of TEST_SUITES) {
    const n = suiteTestCount(dir);
    if (n === null) {
      return null;
    }
    total += n;
  }
  return total;
}

/** Match every `N tests` / `N TypeScript tests` claim in a doc. The capture is
 *  the integer; the caller compares each against the authoritative total. The
 *  optional `TypeScript ` infix covers CLAUDE.md's "N TypeScript tests"
 *  phrasing alongside README's plain "N tests". */
function extractTestCountClaims(content: string): readonly number[] {
  const claims: number[] = [];
  const re = /(\d+)\s+(?:TypeScript\s+)?tests\b/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical /g regex iteration over `content`; assignment-in-while is the documented MDN pattern.
  while ((match = re.exec(content)) !== null) {
    const n = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(n)) {
      claims.push(n);
    }
  }
  return claims;
}

/** Audit 3: every `N tests` claim in README.md + CLAUDE.md must equal the
 *  summed `Ran N` across the three npm-test suites.
 *
 *  Cheap-exit: if neither doc carries a test-count claim there is nothing to
 *  verify, so we skip the (expensive) suite run entirely and pass. This also
 *  keeps synthetic-fixture unit tests — which stage no README and no `tests/`
 *  dir — green: a repo with no claim never triggers the suite run.
 *
 *  Returns false on drift, or on inability to derive the truth WHEN a claim
 *  exists (the latter pushes no violation, so the caller treats it as a
 *  read-failure → exit 2). */
function auditTestCount(violations: Violation[]): boolean {
  const AUDIT = "test-count";
  const docs: readonly string[] = ["README.md", "CLAUDE.md"];

  // Collect claims first; only derive the (expensive) truth if any doc claims.
  const present: { readonly doc: string; readonly claims: readonly number[] }[] = [];
  for (const doc of docs) {
    // Doc absent (e.g. synthetic fixture has no README) — nothing to check for
    // that doc. existsSync avoids readFile's stderr-on-ENOENT (which would
    // pollute --quiet success output). Matches the no-claim-is-fine philosophy.
    if (!existsSync(resolve(process.cwd(), doc))) {
      continue;
    }
    const content = readFile(doc);
    if (content === null) {
      continue;
    }
    present.push({ doc, claims: extractTestCountClaims(content) });
  }
  const totalClaims = present.reduce((n, p) => n + p.claims.length, 0);
  if (totalClaims === 0) {
    return true; // no claims anywhere → nothing to verify; skip the suite run
  }

  const truth = authoritativeTestTotal();
  if (truth === null) {
    return false; // read-failure: surfaced as exit 2 by main()
  }

  let anyFailure = false;
  for (const { doc, claims } of present) {
    for (const claim of claims) {
      if (claim !== truth) {
        violations.push({
          audit: AUDIT,
          detail: `${doc}: claims ${String(claim)} tests; the three npm-test suites total ${String(truth)}`,
        });
        anyFailure = true;
      }
    }
  }
  return !anyFailure;
}

interface PackageVersion {
  readonly version?: string;
}

/** Audit 4: a hardcoded `Current: vX.Y.Z` / `Status: vX.Y.Z` marker in
 *  README.md must match package.json's version. The preferred state is no such
 *  marker at all (rely on the npm version badge); this only fires when a marker
 *  exists AND disagrees, so a clean README with no marker passes. */
function auditReadmeVersionMarker(violations: Violation[]): boolean {
  const AUDIT = "readme-version-marker";
  const raw = readFile("package.json");
  if (raw === null) {
    return false;
  }
  let pkg: PackageVersion;
  try {
    pkg = JSON.parse(raw) as PackageVersion;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({ audit: AUDIT, detail: `package.json: parse failed (${msg})` });
    return false;
  }
  const version = pkg.version;
  if (version === undefined) {
    // No version field (e.g. synthetic fixture's minimal package.json) — there
    // is nothing to compare a marker against, so skip rather than fail.
    return true;
  }

  // README absent (synthetic fixtures stage none) → no marker to check; skip.
  if (!existsSync(resolve(process.cwd(), "README.md"))) {
    return true;
  }
  const readme = readFile("README.md");
  if (readme === null) {
    return false;
  }

  // `Current:` / `Status:` optionally followed by markdown emphasis/backticks,
  // then a vX.Y.Z (leading `v` optional). Bold/inline-code wrappers around the
  // version are tolerated so `Current: **`0.7.0`**` matches.
  const re = /\b(Current|Status)\s*:\s*[*`]*v?(\d+\.\d+\.\d+)/g;
  let anyFailure = false;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical /g regex iteration over `readme`; assignment-in-while is the documented MDN pattern.
  while ((match = re.exec(readme)) !== null) {
    const marked = match[2];
    if (marked !== undefined && marked !== version) {
      violations.push({
        audit: AUDIT,
        detail: `README.md: hardcoded '${match[1] ?? ""}: ${marked}' disagrees with package.json version ${version}. Prefer removing the marker and relying on the npm version badge.`,
      });
      anyFailure = true;
    }
  }
  return !anyFailure;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    return 2;
  }

  const violations: Violation[] = [];
  let readFailure = false;

  // Each audit signals (ok, drift, read-failure) by combining bool return
  // with violations.push: ok=true + 0 pushes; drift=false + N pushes;
  // read-failure=false + 0 pushes (the file was unreadable before any
  // claim could be checked). Distinguish by inspecting violations after.
  const errCountOk = auditHookKitErrorCount(violations);
  if (!(errCountOk || violations.some((v) => v.audit === "hookkit-error-count"))) {
    readFailure = true;
  }

  const exportsOk = auditPackageJsonExportTargets(violations);
  if (!(exportsOk || violations.some((v) => v.audit === "package-json-export-targets"))) {
    readFailure = true;
  }

  const testCountOk = auditTestCount(violations);
  if (!(testCountOk || violations.some((v) => v.audit === "test-count"))) {
    readFailure = true;
  }

  const versionMarkerOk = auditReadmeVersionMarker(violations);
  if (!(versionMarkerOk || violations.some((v) => v.audit === "readme-version-marker"))) {
    readFailure = true;
  }

  if (readFailure) {
    return 2;
  }

  if (violations.length === 0) {
    if (!args.quiet) {
      process.stderr.write(`${SCRIPT}: all audits passed\n`);
    }
    return 0;
  }

  for (const v of violations) {
    process.stderr.write(`${SCRIPT} [${v.audit}]: ${v.detail}\n`);
  }
  process.stderr.write(
    `\n${SCRIPT}: ${String(violations.length)} drift(s) found.\n` +
      "Fix each doc to match the source-of-truth count, or update the source if the\n" +
      "doc value is correct. For new subpath exports, also create the target file in\n" +
      "the same commit (L-M1.5-1).\n",
  );
  return 1;
}

process.exit(main());
