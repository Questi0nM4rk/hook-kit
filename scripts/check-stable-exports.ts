#!/usr/bin/env bun
/**
 * STABLE-export diff guard.
 *
 * Diffs the set of named exports in `src/index.ts` between origin/main and
 * HEAD. If any export was removed without a `BREAKING CHANGE:` footer in
 * the commit-range messages, exit non-zero so CI fails.
 *
 * This is the lightweight enforcement of the deprecation cycle promise in
 * `docs/STABILITY.md`: STABLE removals require a major bump, and the
 * conventional-commits footer is the marker that the author intends one.
 *
 * Scope (1.0.0 release-gate): only `src/index.ts` is diffed. Subpath
 * exports (./testing, ./adapters/*, ./state/*) are not yet covered; M1+
 * tasks can extend this to walk every subpath listed in
 * `docs/specs/v1.0-exports.md`.
 *
 * Usage:
 *   bun scripts/check-stable-exports.ts                  # diff against origin/main
 *   bun scripts/check-stable-exports.ts --base v0.7.0    # diff against another ref
 *   bun scripts/check-stable-exports.ts --quiet          # suppress added-export list
 */

import { commitRangeMessages, readFileAtRef, readHeadFile } from "./_lib.js";

const SCRIPT = "check-stable-exports";

interface Args {
  readonly base: string;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let base = "origin/main";
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && i + 1 < argv.length) {
      base = argv[i + 1] ?? base;
      i += 1;
    } else if (a === "--quiet") {
      quiet = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      process.stderr.write(`check-stable-exports: unrecognized arg '${a}'\n`);
      printHelp();
      process.exit(2);
    }
  }
  return { base, quiet };
}

function printHelp(): void {
  process.stderr.write(`\
check-stable-exports — diff src/index.ts exports vs a base ref.

Usage: bun scripts/check-stable-exports.ts [--base <ref>] [--quiet]

Exits 0 if no STABLE exports were removed, OR if the commit range from
<base> to HEAD contains at least one 'BREAKING CHANGE:' footer.
Exits 1 if STABLE exports were removed without a BREAKING CHANGE: footer.
Exits 2 on argument or git plumbing errors.
`);
}

/** Extract every named export from a barrel module's source text.
 *
 *  Captures both `export { ... } from` re-export clauses AND declaration-site
 *  exports (`export function foo`, `export const bar`, etc.). Doesn't follow
 *  re-exports transitively — lists what `src/index.ts` literally says, not
 *  the underlying file's full surface.
 *
 *  Designed for barrel-file shape. Do not reuse on arbitrary TS — the
 *  comment-strip pass doesn't excise string-literal contents, so a string
 *  containing `export { Foo }` could false-match. `src/index.ts` is a pure
 *  re-export barrel with no string literals; safe there. */
function parseExports(source: string): Set<string> {
  const names = new Set<string>();

  // Strip block comments + line comments to avoid matching inside JSDoc.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Match `export { ... } from "..."` and `export { ... }` (including multi-line).
  const namedExportRe = /export\s*(?:type\s*)?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical /g regex iteration over `stripped`; assignment-in-while is the documented MDN pattern.
  while ((match = namedExportRe.exec(stripped)) !== null) {
    const inner = match[1];
    if (inner === undefined) {
      continue;
    }
    for (const raw of inner.split(",")) {
      // Each member can be `Foo`, `type Foo`, `Foo as Bar`, or `type Foo as Bar`.
      // Strip the `type` modifier; the rebind target (after `as`) is the
      // public name; if no rebind, the source name is public.
      const cleaned = raw.trim().replace(/^type\s+/, "");
      if (cleaned === "") {
        continue;
      }
      const parts = cleaned.split(/\s+as\s+/);
      const publicName = (parts[1] ?? parts[0] ?? "").trim();
      if (publicName !== "") {
        names.add(publicName);
      }
    }
  }

  // Match `export function foo(...)`, `export class Foo`, `export const foo`,
  // `export interface Foo`, `export type Foo`, `export enum Foo`. Used in
  // case a future change adds direct declaration-site exports to the barrel.
  const declExportRe =
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical /g regex iteration over `stripped`; assignment-in-while is the documented MDN pattern.
  while ((match = declExportRe.exec(stripped)) !== null) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }

  return names;
}

function hasBreakingChangeFooter(messagesText: string): boolean {
  // Conventional-commits "BREAKING CHANGE:" footer or "BREAKING-CHANGE:".
  // Match at line start (footer position) but be lenient about exact case.
  return /^BREAKING[-\s]CHANGE:/im.test(messagesText);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CI script dispatch — argv parsing + git diff + report writing form one cohesive entrypoint; splitting reduces traceability.
function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const path = "src/index.ts";

  const currentSource = readHeadFile(path, SCRIPT);
  if (currentSource === null) {
    return 2;
  }

  const baseSource = readFileAtRef(args.base, path, SCRIPT);
  if (baseSource === null) {
    process.stderr.write(
      `check-stable-exports: cannot diff against ${args.base}; ` +
        "ensure the ref exists locally (e.g. 'git fetch origin main').\n",
    );
    return 2;
  }

  const currentExports = parseExports(currentSource);
  const baseExports = parseExports(baseSource);

  const removed: string[] = [];
  for (const name of baseExports) {
    if (!currentExports.has(name)) {
      removed.push(name);
    }
  }
  removed.sort();

  const added: string[] = [];
  for (const name of currentExports) {
    if (!baseExports.has(name)) {
      added.push(name);
    }
  }
  added.sort();

  if (!args.quiet) {
    process.stderr.write(`check-stable-exports: comparing ${args.base}..HEAD\n`);
    process.stderr.write(`  base exports:     ${baseExports.size}\n`);
    process.stderr.write(`  current exports:  ${currentExports.size}\n`);
    if (added.length > 0) {
      process.stderr.write(`  added (${added.length}):    ${added.join(", ")}\n`);
    }
  }

  if (removed.length === 0) {
    if (!args.quiet) {
      process.stderr.write("check-stable-exports: no removals; ok\n");
    }
    return 0;
  }

  process.stderr.write(`  removed (${removed.length}):  ${removed.join(", ")}\n`);

  const messages = commitRangeMessages(args.base, SCRIPT);
  if (messages === null) {
    return 2;
  }

  if (hasBreakingChangeFooter(messages)) {
    process.stderr.write(
      "check-stable-exports: STABLE exports were removed, but BREAKING CHANGE: " +
        "footer is present in the commit range. Major-bump intent acknowledged; ok.\n",
    );
    return 0;
  }

  process.stderr.write(
    "\ncheck-stable-exports: ERROR — STABLE exports removed without a " +
      "'BREAKING CHANGE:' commit footer.\n" +
      "Per docs/STABILITY.md, STABLE removals require a major version bump and a\n" +
      "deprecation cycle. If this removal is intentional, add a 'BREAKING CHANGE:' " +
      "footer to one of the commits in the range.\n",
  );
  return 1;
}

process.exit(main());
