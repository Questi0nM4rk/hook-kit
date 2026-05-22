#!/usr/bin/env bun
/**
 * Coverage-floor enforcer for `tests/` suite.
 *
 * @internal — CI guard, not a public API.
 *
 * Why a custom script: Bun's `[test] coverageThreshold` bunfig key is
 * not enforced in 1.3.x — see oven-sh/bun#7367 / #8111 / #17664. The
 * CLI flag `--coverage-threshold` also doesn't exist (silent no-op;
 * not in `bun test --help`). To get real enforcement now we run
 * `bun test tests/ --coverage`, parse the `All files` row of the text
 * reporter, and exit non-zero if floors are not met. When Bun's native
 * enforcement starts working again, this script becomes a belt-and-
 * suspenders check and can be deleted in favor of bunfig alone.
 *
 * Floors codify status quo (2026-05-22): 84% functions / 89% lines.
 * Raising past 85% is its own follow-up batch — current shortfall
 * concentrated in src/wrapper/hk.ts (compiled-binary entrypoint) and
 * src/core/event.ts (factories tested through consumers, not directly).
 */

const FN_FLOOR = 0.84; // 84% functions — current measured 84.65
const LN_FLOOR = 0.89; // 89% lines     — current measured 89.29
const PERCENT = 100; // bun text reporter prints percentages; convert ↔ fraction.
const SCRIPT = "check-coverage";

// Run the regular-suite tests with coverage. Mirror current `bun run test`
// invocation: `bun test tests/ --coverage`. Bun writes the test progress
// header to stdout but the coverage TABLE (which we parse) AND the
// pass/fail summary go to stderr — capture both, pass them through to the
// terminal, parse stderr for the `All files` aggregate row.
const proc = Bun.spawnSync(["bun", "test", "tests/", "--coverage"], {
  stdout: "pipe",
  stderr: "pipe",
});

const stdout = proc.stdout.toString("utf8");
const stderr = proc.stderr.toString("utf8");
process.stdout.write(stdout);
process.stderr.write(stderr);

if (proc.exitCode !== 0) {
  // proc.exitCode is typed `number | null` in Bun types; the !== 0 check
  // means it's non-null and non-zero here, but ESLint's narrowing of
  // template-string interpolation + the ?? guard both need String() / a
  // non-null exit value to satisfy strict-type-checked.
  const code = proc.exitCode;
  process.stderr.write(`${SCRIPT}: bun test exited with ${String(code)}\n`);
  process.exit(code);
}

// The text reporter renders one row per file plus an `All files` aggregate row.
// Shape: ` All files                             |   84.65 |   89.29 |`
// We split on `|`, trim, and pull the second/third columns as percentages.
const allFilesLine = stderr.split("\n").find((line) => /^\s*All files\s*\|/.test(line));

if (allFilesLine === undefined) {
  process.stderr.write(`${SCRIPT}: could not find 'All files' row in coverage output\n`);
  process.exit(2);
}

const cols = allFilesLine.split("|").map((s) => s.trim());
// cols: ["All files", "84.65", "89.29", ""]
const funcsPct = Number.parseFloat(cols[1] ?? "");
const linesPct = Number.parseFloat(cols[2] ?? "");

if (!(Number.isFinite(funcsPct) && Number.isFinite(linesPct))) {
  process.stderr.write(
    `${SCRIPT}: failed to parse coverage percentages from '${allFilesLine.trim()}'\n`,
  );
  process.exit(2);
}

const funcsFrac = funcsPct / PERCENT;
const linesFrac = linesPct / PERCENT;

const failures: string[] = [];
if (funcsFrac < FN_FLOOR) {
  failures.push(
    `function coverage ${funcsPct.toFixed(2)}% < floor ${(FN_FLOOR * PERCENT).toFixed(0)}%`,
  );
}
if (linesFrac < LN_FLOOR) {
  failures.push(
    `line coverage ${linesPct.toFixed(2)}% < floor ${(LN_FLOOR * PERCENT).toFixed(0)}%`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`${SCRIPT}: coverage floor not met\n`);
  for (const f of failures) {
    process.stderr.write(`  ${f}\n`);
  }
  process.exit(1);
}

process.stderr.write(
  `${SCRIPT}: ok (${funcsPct.toFixed(2)}% funcs / ${linesPct.toFixed(2)}% lines)\n`,
);
