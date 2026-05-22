#!/usr/bin/env bun
/**
 * Cross-doc table-drift audit.
 *
 * @internal — CI guard, not a public API.
 *
 * The "Output convention" table in `CLAUDE.md` (§ Output Convention) and
 * `docs/ADAPTERS.md` (§ Output convention) was intentionally duplicated
 * per TASK-024 — both audiences read their own file. This script
 * asserts the duplicates stay byte-identical so drift fails CI
 * immediately rather than surfacing in a future contract bug.
 *
 * Extraction rule: read the named H2 section in each file; collect
 * subsequent lines starting with `|` (markdown table rows) until the
 * next `#` heading or EOF; compare the row sequences. Heading-case
 * differences ("Output Convention" vs "Output convention") are
 * tolerated by allowing a case-insensitive heading match per file.
 *
 * Usage:
 *   bun scripts/check-output-table.ts          # default file/heading pairs
 *   bun scripts/check-output-table.ts --quiet  # only print on failure
 *
 * Exit codes:
 *   0  tables match (modulo blank lines between rows)
 *   1  tables differ; first mismatching row reported
 *   2  argument-parse, file-read, or section-missing failure
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = "check-output-table";

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
check-output-table — assert duplicated tables stay byte-identical.

Usage: bun scripts/check-output-table.ts [--quiet]

Audits:
  CLAUDE.md "Output Convention" table  ==  docs/ADAPTERS.md "Output convention" table

Exits 0 if all rows match.
Exits 1 if any row differs (or row count differs).
Exits 2 on file-read or section-missing errors.
`);
}

interface TableSource {
  readonly file: string;
  readonly headingPattern: RegExp;
}

const SOURCES: readonly [TableSource, TableSource] = [
  {
    file: "CLAUDE.md",
    // Matches `## Output Convention` and variants with parenthetical suffixes.
    // Case-insensitive so "Output convention" vs "Output Convention" doesn't
    // accidentally split the duplicated table.
    headingPattern: /^##\s+Output\s+[Cc]onvention\b/,
  },
  {
    file: "docs/ADAPTERS.md",
    headingPattern: /^##\s+Output\s+[Cc]onvention\b/,
  },
];

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(process.cwd(), path), "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${SCRIPT}: cannot read ${path}: ${msg}\n`);
    return null;
  }
}

/** Extract the first markdown table after the matching heading. Returns
 *  the array of row lines (each beginning with `|`) — the header row, the
 *  alignment row, and every data row — in source order. Skips blank
 *  lines between rows. Stops at the next `#` heading. */
function extractTable(content: string, headingRe: RegExp): readonly string[] | null {
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (headingRe.test(lines[i] ?? "")) {
      break;
    }
    i += 1;
  }
  if (i >= lines.length) {
    return null;
  }
  // Skip past the heading line; collect subsequent lines starting with `|`
  // until the next `#` heading or EOF.
  i += 1;
  const rows: string[] = [];
  let seenTable = false;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("#")) {
      break;
    }
    if (line.startsWith("|")) {
      rows.push(line);
      seenTable = true;
    } else if (seenTable && line.trim() !== "" && !line.startsWith("|")) {
      // First non-blank, non-table line AFTER the table ends the table.
      break;
    }
    i += 1;
  }
  return rows;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CI script dispatch — argv parsing + per-file extraction + row-by-row diff + report writing form one cohesive entrypoint; splitting reduces traceability.
function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    return 2;
  }

  const tables: string[][] = [];
  for (const src of SOURCES) {
    const content = readFile(src.file);
    if (content === null) {
      return 2;
    }
    const rows = extractTable(content, src.headingPattern);
    if (rows === null) {
      process.stderr.write(
        `${SCRIPT}: could not find heading matching ${String(src.headingPattern)} in ${src.file}\n`,
      );
      return 2;
    }
    if (rows.length === 0) {
      process.stderr.write(`${SCRIPT}: heading found in ${src.file} but no table rows below\n`);
      return 2;
    }
    tables.push([...rows]);
  }

  const [a, b] = tables as [string[], string[]];
  if (a.length !== b.length) {
    process.stderr.write(
      `${SCRIPT}: row count mismatch — ${SOURCES[0].file} has ${String(a.length)} rows, ${SOURCES[1].file} has ${String(b.length)}\n`,
    );
    return 1;
  }

  const mismatches: { index: number; left: string; right: string }[] = [];
  for (let i = 0; i < a.length; i++) {
    const left = a[i] ?? "";
    const right = b[i] ?? "";
    if (left !== right) {
      mismatches.push({ index: i, left, right });
    }
  }

  if (mismatches.length === 0) {
    if (!args.quiet) {
      process.stderr.write(
        `${SCRIPT}: ${SOURCES[0].file} table matches ${SOURCES[1].file} (${String(a.length)} rows)\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`${SCRIPT}: ${String(mismatches.length)} row(s) differ:\n`);
  for (const m of mismatches) {
    process.stderr.write(`  row ${String(m.index)}:\n`);
    process.stderr.write(`    ${SOURCES[0].file}: ${m.left}\n`);
    process.stderr.write(`    ${SOURCES[1].file}: ${m.right}\n`);
  }
  process.stderr.write(
    `\n${SCRIPT}: tables intentionally duplicated per TASK-024; sync the divergent rows or update both in lockstep.\n`,
  );
  return 1;
}

process.exit(main());
