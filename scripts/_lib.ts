/**
 * Shared helpers for CI-time stability scripts.
 *
 * @internal — not part of any public API. Both `check-stable-exports.ts`
 * and `check-changelog.ts` (and any future stability guard) import from
 * here to avoid drift across copies of git-subprocess + changelog-scan
 * boilerplate.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Run `git <args>` synchronously without spawning a shell. Bun.spawnSync
 *  invokes the binary directly via posix_spawn; argv elements pass verbatim,
 *  so no shell metacharacter interpretation. */
export function git(args: readonly string[]): GitResult {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    exitCode: result.exitCode,
  };
}

/** Concatenated commit messages from `<base>..HEAD`, separated by
 *  `--commit-end--` so callers can split when they need per-commit text.
 *  Returns null on git failure (caller writes to stderr + exits 2). */
export function commitRangeMessages(base: string, scriptName: string): string | null {
  const r = git(["log", "--format=%B%n--commit-end--", `${base}..HEAD`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`${scriptName}: git log failed against ${base}\n${r.stderr}`);
    return null;
  }
  return r.stdout;
}

/** Read a working-tree file. Returns null + writes to stderr on read
 *  failure. No pre-flight existsSync: try-then-handle avoids the TOCTOU
 *  shape and matches the zero-silent-fails policy. */
export function readHeadFile(path: string, scriptName: string): string | null {
  const abs = resolve(process.cwd(), path);
  try {
    return readFileSync(abs, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${scriptName}: ${path} not readable: ${msg}\n`);
    return null;
  }
}

/** Read a file's contents at a git ref. Returns null + writes to stderr
 *  on failure. */
export function readFileAtRef(ref: string, path: string, scriptName: string): string | null {
  const r = git(["show", `${ref}:${path}`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`${scriptName}: failed to read ${ref}:${path}\n${r.stderr}`);
    return null;
  }
  return r.stdout;
}

/** Locate the `## [Unreleased]` section in a split CHANGELOG.md. Returns
 *  `[start, end)` line indices (end exclusive), or null if no section
 *  is present. End is the next `## [` heading, or end-of-file. */
export function findUnreleasedBlock(lines: readonly string[]): readonly [number, number] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## [Unreleased]")) {
      start = i;
    } else if (start >= 0 && line.startsWith("## [")) {
      return [start, i];
    }
  }
  if (start < 0) {
    return null;
  }
  return [start, lines.length];
}
