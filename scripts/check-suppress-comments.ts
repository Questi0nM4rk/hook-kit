#!/usr/bin/env bun
/**
 * Inline suppression-comment discipline check.
 *
 * Scans TS/JS source files for inline linter suppressions and requires every
 * one to carry a content-bearing reason (>=10 non-whitespace chars after the
 * separator). Generic placeholders ("TODO", "see comment", "fix later", etc.)
 * are rejected by a denylist so the gate can't be defeated by typing chars.
 *
 * Why: an unjustified suppression is a silent acknowledgment that a rule
 * fires AND the author won't explain why. Forcing a reason at the
 * suppression site means future readers see the rationale instead of
 * archaeology-ing the commit log; future contributors can decide "still
 * applies?" without re-deriving the original context.
 *
 * Recognised markers and the separator each uses (token sequences are
 * paraphrased in this header to avoid biome / eslint self-matching the
 * docstring itself):
 *
 *   biome:  line / file-header / block forms of biome-ignore[-all] use a
 *           colon (':') between the rule name and the reason.
 *
 *   eslint: line / block forms of eslint-disable[-next-line|-line] use a
 *           double-dash ('--') between the rule list and the reason.
 *
 *   typescript: the at-ts-ignore and at-ts-expect-error directives accept
 *           either an inline colon-separated reason on the same line OR a
 *           plain-comment reason on the line immediately above.
 *
 * Reason policy:
 *
 *   - >=10 non-whitespace characters of content (counted after the separator
 *     and after collapsing consecutive whitespace).
 *   - Denylist of generic placeholders (exact match, case-insensitive, after
 *     punctuation strip): TODO, see comment, needed, fix later, wip, temp,
 *     temporary, xxx. WHY: any of these passes the >=10-char gate trivially
 *     ("see comment" is 11 chars) but conveys no information; the denylist
 *     forces a meaningful explanation instead of "checks the box."
 *
 * Modes:
 *
 *   bun scripts/check-suppress-comments.ts <file> [<file> ...]
 *     Scan only the listed files. Used by the lefthook pre-commit hook
 *     against `{staged_files}` so the check runs only on what is about to
 *     land.
 *
 *   bun scripts/check-suppress-comments.ts --all
 *     Scan every TS/TSX/JS/JSX file under src/, tests/, tests-isolated/,
 *     scripts/ recursively. Used by CI (no staged set on a fresh checkout)
 *     and for one-shot audits.
 *
 * Exit codes:
 *
 *   0  every suppression has a content-bearing reason (or no suppressions
 *      found)
 *   1  one or more suppressions are missing or have insufficient /
 *      denylisted reasons
 *   2  argument-parse error or file-read failure
 *
 * Output (stderr, one line per violation):
 *
 *   <file>:<line>:<col> -- <marker> missing or insufficient reason (need
 *   >=10 chars after separator)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = "check-suppress-comments";

const MIN_REASON_CHARS = 10;

/**
 * Generic placeholder phrases that satisfy the character-count gate but
 * convey no information. Matched case-insensitively against the reason
 * after stripping surrounding punctuation and collapsing whitespace.
 * Keep in sync with the policy comment in the header.
 */
const DENYLIST = new Set<string>([
  "todo",
  "see comment",
  "needed",
  "fix later",
  "wip",
  "temp",
  "temporary",
  "xxx",
]);

/** File extensions scanned in `--all` mode and accepted in positional-arg mode. */
const SCANNED_EXTS = new Set<string>([".ts", ".tsx", ".js", ".jsx"]);

/** Top-level directories walked in `--all` mode. */
const ALL_ROOTS: readonly string[] = ["src", "tests", "tests-isolated", "scripts"];

/** Directory names skipped during the `--all` walk. */
const SKIPPED_DIRS = new Set<string>(["node_modules", "dist", ".git", ".claude"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly marker: string;
  readonly detail: string;
}

interface Args {
  readonly mode: "files" | "all";
  readonly files: readonly string[];
}

function parseArgs(argv: readonly string[]): Args | null {
  if (argv.length === 0) {
    process.stderr.write(`${SCRIPT}: no files passed and --all not set\n`);
    printHelp();
    return null;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (argv.includes("--all")) {
    if (argv.length !== 1) {
      process.stderr.write(`${SCRIPT}: --all takes no positional args\n`);
      return null;
    }
    return { mode: "all", files: [] };
  }
  return { mode: "files", files: argv };
}

function printHelp(): void {
  process.stderr.write(`\
check-suppress-comments -- require a >=10-char reason on inline linter suppressions.

Usage:
  bun scripts/check-suppress-comments.ts <file> [<file> ...]
  bun scripts/check-suppress-comments.ts --all

Exits 0 if every suppression has a content-bearing reason (>=10 non-whitespace
chars, not in the generic-placeholder denylist).
Exits 1 if any suppression is missing or has an insufficient/denylisted reason.
Exits 2 on argument or file-read errors.

Recognised markers: biome-ignore, biome-ignore-all (line + block forms),
eslint-disable* (line + block forms), @ts-ignore, @ts-expect-error.
Separators: ':' for biome and TS, '--' for ESLint. TS markers also accept the
reason on the line immediately above.
`);
}

function isScannedExt(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return SCANNED_EXTS.has(name.slice(dot));
}

function collectFilesUnderRoot(root: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${SCRIPT}: cannot read directory ${root}: ${msg}\n`);
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") {
      continue;
    }
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      collectFilesUnderRoot(full, out);
      continue;
    }
    if (entry.isFile() && isScannedExt(entry.name)) {
      out.push(full);
    }
  }
}

function gatherFiles(args: Args): string[] {
  if (args.mode === "all") {
    const out: string[] = [];
    for (const root of ALL_ROOTS) {
      let exists = false;
      try {
        exists = statSync(root).isDirectory();
      } catch {
        // Root missing in some layouts (e.g. fresh clone before scripts/ exists); skip silently.
      }
      if (exists) {
        collectFilesUnderRoot(root, out);
      }
    }
    out.sort();
    return out;
  }
  return [...args.files];
}

/** True if `s` collapses to a denylisted placeholder phrase. */
function isDenylistedReason(s: string): boolean {
  const collapsed = s
    .toLowerCase()
    .replace(/[.,;:!?"'`()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) {
    return true;
  }
  return DENYLIST.has(collapsed);
}

/** Count non-whitespace chars in `s`. */
function nonWhitespaceLen(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (!/\s/.test(ch)) {
      n += 1;
    }
  }
  return n;
}

/**
 * Validate a reason string. Returns null if acceptable, or a short detail
 * string describing the failure if not.
 */
function validateReason(reason: string | null): string | null {
  if (reason === null) {
    return "no separator found";
  }
  const trimmed = reason.trim();
  if (nonWhitespaceLen(trimmed) < MIN_REASON_CHARS) {
    return `reason has ${String(nonWhitespaceLen(trimmed))} non-whitespace chars (need >=${String(MIN_REASON_CHARS)})`;
  }
  if (isDenylistedReason(trimmed)) {
    return `reason matches generic-placeholder denylist (${trimmed})`;
  }
  return null;
}

// Marker regexes -- run per-line; column maps directly to the matched offset.
// `biome-ignore-all` has priority over `biome-ignore` because the former is a strict superset.
const BIOME_IGNORE_ALL_RE = /(\/\/|\/\*)\s*biome-ignore-all\b([^*]*)/;
const BIOME_IGNORE_RE = /(\/\/|\/\*)\s*biome-ignore\b(?!-all)([^*]*)/;
const ESLINT_RE = /(\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b([\s\S]*?)(?:\*\/|$)/;
const TS_IGNORE_RE = /\/\/\s*@(ts-ignore|ts-expect-error)\b([\s\S]*?)$/;

interface MarkerMatch {
  readonly marker: string;
  readonly index: number;
  readonly rest: string;
  readonly kind: "biome" | "eslint" | "ts-ignore";
}

/**
 * Locate the first suppression marker on a line, in priority order:
 * the file-header biome form wins over the per-line biome form (the former
 * is a strict superset), then the eslint variants, then the typescript
 * suppression directives.
 */
function findMarker(line: string): MarkerMatch | null {
  const allMatch = BIOME_IGNORE_ALL_RE.exec(line);
  if (allMatch) {
    return {
      marker: "biome-ignore-all",
      index: allMatch.index,
      rest: allMatch[2] ?? "",
      kind: "biome",
    };
  }
  const biomeMatch = BIOME_IGNORE_RE.exec(line);
  if (biomeMatch) {
    return {
      marker: "biome-ignore",
      index: biomeMatch.index,
      rest: biomeMatch[2] ?? "",
      kind: "biome",
    };
  }
  const eslintMatch = ESLINT_RE.exec(line);
  if (eslintMatch) {
    const matched = eslintMatch[0];
    let label = "eslint-disable";
    if (matched.includes("eslint-disable-next-line")) {
      label = "eslint-disable-next-line";
    } else if (matched.includes("eslint-disable-line")) {
      label = "eslint-disable-line";
    }
    return {
      marker: label,
      index: eslintMatch.index,
      rest: eslintMatch[2] ?? "",
      kind: "eslint",
    };
  }
  const tsMatch = TS_IGNORE_RE.exec(line);
  if (tsMatch) {
    return {
      marker: `@${tsMatch[1] ?? "ts-ignore"}`,
      index: tsMatch.index,
      rest: tsMatch[2] ?? "",
      kind: "ts-ignore",
    };
  }
  return null;
}

/**
 * Extract the reason after the marker, applying the per-kind separator rule.
 * Returns the raw reason text (untrimmed) or null if the separator is absent.
 */
function extractInlineReason(kind: MarkerMatch["kind"], rest: string): string | null {
  if (kind === "biome" || kind === "ts-ignore") {
    const idx = rest.indexOf(":");
    if (idx < 0) {
      return null;
    }
    let r = rest.slice(idx + 1);
    r = r.replace(/\*\/\s*$/, "");
    return r;
  }
  const idx = rest.indexOf("--");
  if (idx < 0) {
    return null;
  }
  let r = rest.slice(idx + 2);
  r = r.replace(/\*\/\s*$/, "");
  return r;
}

/**
 * Extract a reason that lives on the line ABOVE (used as a fallback for
 * the typescript suppression directives which can carry the reason as a
 * preceding `// ...` comment line).
 */
function extractAboveReason(prevLine: string | undefined): string | null {
  if (prevLine === undefined) {
    return null;
  }
  if (findMarker(prevLine)) {
    return null;
  }
  const trimmed = prevLine.trim();
  if (trimmed.startsWith("//")) {
    return trimmed.slice(2);
  }
  const block = /^\/\*([\s\S]*?)\*\/\s*$/.exec(trimmed);
  if (block) {
    return block[1] ?? "";
  }
  return null;
}

/**
 * Update block-comment state for a single line. Returns the new state
 * (true if the line ends with an unclosed block comment). Walks
 * left-to-right tracking whether we're inside `/* ... *\/`; opens/closes
 * inside an already-open block are no-ops.
 *
 * Limitation: doesn't handle string literals that contain `/*` -- a true
 * lexer would, but TS strings rarely include literal `/*` sequences and a
 * false-skip there would just under-report, not over-report.
 */
function advanceBlockCommentState(line: string, startInBlock: boolean): boolean {
  let cursor = 0;
  let openHere: boolean = startInBlock;
  while (cursor < line.length) {
    if (openHere) {
      const close = line.indexOf("*/", cursor);
      if (close < 0) {
        break;
      }
      openHere = false;
      cursor = close + 2;
    } else {
      const open = line.indexOf("/*", cursor);
      if (open < 0) {
        break;
      }
      openHere = true;
      cursor = open + 2;
    }
  }
  return openHere;
}

/**
 * Resolve the reason text for a marker, applying the inline-or-above
 * fallback for the typescript directives.
 */
function resolveReason(
  match: MarkerMatch,
  lines: readonly string[],
  lineIdx: number,
): string | null {
  const inlineReason = extractInlineReason(match.kind, match.rest);
  if (match.kind !== "ts-ignore") {
    return inlineReason;
  }
  if (validateReason(inlineReason) === null) {
    return inlineReason;
  }
  // Typescript markers can carry their reason on the preceding comment line.
  const above = extractAboveReason(lines[lineIdx - 1]);
  return above ?? inlineReason;
}

/**
 * Scan a single line for a suppression marker and append a violation if
 * the resolved reason fails the policy. Mutates `violations` in place.
 *
 * Block-comment-aware: lines that began inside a multi-line block comment
 * are skipped (their text is documentation, not an active suppression).
 * Block markers like `/* biome-ignore X: reason *\/` opening AND closing
 * on the same line still scan -- they ARE active suppressions.
 */
function scanLine(
  filePath: string,
  lines: readonly string[],
  lineIdx: number,
  violations: Violation[],
): void {
  const line = lines[lineIdx] ?? "";
  const match = findMarker(line);
  if (!match) {
    return;
  }
  const reason = resolveReason(match, lines, lineIdx);
  const detail = validateReason(reason);
  if (detail === null) {
    return;
  }
  violations.push({
    file: filePath,
    line: lineIdx + 1,
    col: match.index + 1,
    marker: match.marker,
    detail,
  });
}

/**
 * Top-level per-file scanner. Walks lines, maintains block-comment state,
 * delegates marker matching + reason validation to `scanLine`.
 */
function scanContent(filePath: string, content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const startedInBlock = inBlockComment;
    inBlockComment = advanceBlockCommentState(line, inBlockComment);
    if (startedInBlock) {
      continue;
    }
    scanLine(filePath, lines, i, violations);
  }
  return violations;
}

function readFile(file: string): string | null {
  try {
    return readFileSync(resolve(process.cwd(), file), "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${SCRIPT}: cannot read ${file}: ${msg}\n`);
    return null;
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    return 2;
  }
  const files = gatherFiles(args);
  if (files.length === 0) {
    if (args.mode === "all") {
      process.stderr.write(`${SCRIPT}: no scanned files found under ${ALL_ROOTS.join(", ")}\n`);
    }
    return 0;
  }

  let allViolations: Violation[] = [];
  let readFailures = 0;
  for (const file of files) {
    if (!isScannedExt(file)) {
      continue;
    }
    const content = readFile(file);
    if (content === null) {
      readFailures += 1;
      continue;
    }
    const v = scanContent(file, content);
    if (v.length > 0) {
      allViolations = allViolations.concat(v);
    }
  }

  if (readFailures > 0) {
    return 2;
  }

  if (allViolations.length === 0) {
    return 0;
  }

  for (const v of allViolations) {
    process.stderr.write(
      `${v.file}:${String(v.line)}:${String(v.col)} -- ${v.marker} missing or insufficient reason ` +
        `(need >=${String(MIN_REASON_CHARS)} chars after separator; ${v.detail})\n`,
    );
  }
  process.stderr.write(
    `\n${SCRIPT}: ${String(allViolations.length)} violation(s). ` +
      "Add a content-bearing reason after the marker's separator " +
      "(':' for biome / @ts-*, '--' for eslint). Reasons must be >=10 non-whitespace " +
      "characters and not match the generic-placeholder denylist " +
      "(TODO, see comment, needed, fix later, wip, temp, temporary, xxx).\n",
  );
  return 1;
}

process.exit(main());
