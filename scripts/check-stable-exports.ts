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

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

/** Run `git <args>` without spawning a shell. Bun.spawnSync invokes the
 *  binary directly via posix_spawn; argv elements are passed verbatim, so
 *  no shell metacharacter interpretation. */
function git(args: readonly string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout?.toString("utf8") ?? "",
    stderr: result.stderr?.toString("utf8") ?? "",
    exitCode: result.exitCode ?? 1,
  };
}

/** Extract every named export from a TypeScript barrel module's source text.
 *  Returns the set of identifiers as they appear in `export { ... }` clauses
 *  AND in `export <type|interface|class|function|const> NAME` declarations.
 *
 *  Limitations:
 *  - Doesn't follow re-exports transitively (it lists what `index.ts` says,
 *    not the underlying file's full surface).
 *  - Stripped-down regex parse, not a TS AST walk — sufficient for the
 *    single barrel file `src/index.ts` which uses only `export { ... } from`
 *    forms. Failing-loud if we ever add declaration-site exports (function
 *    foo() {} in the barrel itself), so the regex would miss them and the
 *    diff would warn falsely. Acceptable for the 1.0.0 cut. */
function parseExports(source: string): Set<string> {
  const names = new Set<string>();

  // Strip block comments + line comments to avoid matching inside JSDoc.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  // Match `export { ... } from "..."` and `export { ... }` (including multi-line).
  const namedExportRe = /export\s*(?:type\s*)?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = namedExportRe.exec(stripped)) !== null) {
    const inner = match[1];
    if (inner === undefined) continue;
    for (const raw of inner.split(",")) {
      // Each member can be `Foo`, `type Foo`, `Foo as Bar`, or `type Foo as Bar`.
      // Strip the `type` modifier; the rebind target (after `as`) is the
      // public name; if no rebind, the source name is public.
      const cleaned = raw.trim().replace(/^type\s+/, "");
      if (cleaned === "") continue;
      const parts = cleaned.split(/\s+as\s+/);
      const publicName = (parts[1] ?? parts[0] ?? "").trim();
      if (publicName !== "") names.add(publicName);
    }
  }

  // Match `export function foo(...)`, `export class Foo`, `export const foo`,
  // `export interface Foo`, `export type Foo`, `export enum Foo`. Used in
  // case a future change adds direct declaration-site exports to the barrel.
  const declExportRe =
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  while ((match = declExportRe.exec(stripped)) !== null) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }

  return names;
}

function readBaseFile(base: string, path: string): string | null {
  const r = git(["show", `${base}:${path}`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`check-stable-exports: failed to read ${base}:${path}\n${r.stderr}`);
    return null;
  }
  return r.stdout;
}

function readHeadFile(path: string): string | null {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    process.stderr.write(`check-stable-exports: ${path} not found in working tree\n`);
    return null;
  }
  return readFileSync(abs, "utf8");
}

function commitRangeMessages(base: string): { ok: boolean; text: string } {
  const r = git(["log", "--format=%B%n--commit-end--", `${base}..HEAD`]);
  if (r.exitCode !== 0) {
    process.stderr.write(
      `check-stable-exports: failed to read commits from ${base}..HEAD\n${r.stderr}`,
    );
    return { ok: false, text: "" };
  }
  return { ok: true, text: r.stdout };
}

function hasBreakingChangeFooter(messagesText: string): boolean {
  // Conventional-commits "BREAKING CHANGE:" footer or "BREAKING-CHANGE:".
  // Match at line start (footer position) but be lenient about exact case.
  return /^BREAKING[-\s]CHANGE:/im.test(messagesText);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const path = "src/index.ts";

  const currentSource = readHeadFile(path);
  if (currentSource === null) return 2;

  const baseSource = readBaseFile(args.base, path);
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
    if (!currentExports.has(name)) removed.push(name);
  }
  removed.sort();

  const added: string[] = [];
  for (const name of currentExports) {
    if (!baseExports.has(name)) added.push(name);
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
    if (!args.quiet) process.stderr.write("check-stable-exports: no removals; ok\n");
    return 0;
  }

  process.stderr.write(`  removed (${removed.length}):  ${removed.join(", ")}\n`);

  const { ok, text } = commitRangeMessages(args.base);
  if (!ok) return 2;

  if (hasBreakingChangeFooter(text)) {
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
