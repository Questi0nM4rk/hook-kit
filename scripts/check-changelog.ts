#!/usr/bin/env bun
/**
 * CHANGELOG `[Unreleased]` discipline check.
 *
 * For a PR (or any commit range), fail if any commit in the range modifies
 * `src/` without ALSO modifying the `[Unreleased]` section of `CHANGELOG.md`.
 *
 * This pins the discipline: every source change is accompanied by a
 * user-facing changelog line in the same PR. Catches the common drift where
 * code lands but the changelog gets updated weeks later (or never).
 *
 * The check is per-PR, not per-commit. The PR is the unit of release-note
 * narrative, so any one commit in the PR adding the changelog line satisfies
 * the discipline for every source change in the PR. (Per-commit enforcement
 * would force every code commit to carry a redundant changelog edit;
 * per-PR mirrors how the release notes actually get composed.)
 *
 * Bypass for non-functional source changes: include `[skip-changelog]` in
 * any commit message in the range. Use sparingly — refactors that don't
 * change observable behaviour, comment-only edits, formatting passes.
 *
 * Usage:
 *   bun scripts/check-changelog.ts                  # diff against origin/main
 *   bun scripts/check-changelog.ts --base v0.8.0    # diff against another ref
 */

interface Args {
  readonly base: string;
}

function parseArgs(argv: readonly string[]): Args {
  let base = "origin/main";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && i + 1 < argv.length) {
      base = argv[i + 1] ?? base;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(`\
check-changelog — diff a commit range; require CHANGELOG[Unreleased] touched
when src/ is touched.

Usage: bun scripts/check-changelog.ts [--base <ref>]

Exits 0 if src/ wasn't touched, or if both src/ and CHANGELOG.md were touched
in the range, or if any commit message in the range contains '[skip-changelog]'.
Exits 1 if src/ was touched without CHANGELOG.md in the range.
Exits 2 on argument or git plumbing errors.
`);
      process.exit(0);
    } else {
      process.stderr.write(`check-changelog: unrecognized arg '${a}'\n`);
      process.exit(2);
    }
  }
  return { base };
}

/** Bun.spawnSync(['git', ...]) — no shell, argv passed verbatim. */
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

function changedFiles(base: string): string[] | null {
  const r = git(["diff", "--name-only", `${base}..HEAD`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`check-changelog: git diff failed against ${base}\n${r.stderr}`);
    return null;
  }
  return r.stdout.split("\n").filter((line) => line.length > 0);
}

function commitRangeMessages(base: string): string | null {
  const r = git(["log", "--format=%B%n--commit-end--", `${base}..HEAD`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`check-changelog: git log failed against ${base}\n${r.stderr}`);
    return null;
  }
  return r.stdout;
}

/** Does the change to CHANGELOG.md in the diff range touch the `[Unreleased]`
 *  section specifically (not just an entry under a tagged version)? */
function unreleasedTouched(base: string): boolean | null {
  const r = git(["diff", `${base}..HEAD`, "--", "CHANGELOG.md"]);
  if (r.exitCode !== 0) {
    process.stderr.write(`check-changelog: git diff CHANGELOG.md failed\n${r.stderr}`);
    return null;
  }
  if (r.stdout.length === 0) return false;

  // Walk the unified diff; track the section the current line belongs to.
  // A line belongs to "[Unreleased]" when the most recent header above it
  // (in the FILE state implied by + or context lines) matches /^## \[Unreleased\]/.
  // For simplicity, declare the section touched if EITHER:
  //   - any +/- line is in the [Unreleased] block of the new (post-diff) file, OR
  //   - the [Unreleased] header line itself moves or its body otherwise mutates.
  // We approximate by reading the post-diff file and checking if the diff
  // introduced any added line that falls before the next `## [` header below
  // [Unreleased].
  //
  // The simplest robust approach: scan the diff hunk headers + body. If any
  // hunk body line is `+` AND it falls between a `## [Unreleased]` and the next
  // `## [` line in the post-image, count it as touched. We approximate this by
  // checking the FULL post-image CHANGELOG and the diff text together.
  const post = git(["show", `HEAD:CHANGELOG.md`]);
  if (post.exitCode !== 0) return false;
  const lines = post.stdout.split("\n");
  let unreleasedStart = -1;
  let unreleasedEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^## \[Unreleased\]/.test(line)) {
      unreleasedStart = i;
    } else if (unreleasedStart >= 0 && /^## \[/.test(line)) {
      unreleasedEnd = i;
      break;
    }
  }
  if (unreleasedStart < 0) {
    process.stderr.write(
      "check-changelog: CHANGELOG.md has no '## [Unreleased]' section; please add one.\n",
    );
    return false;
  }
  // Compare the [Unreleased] block in base vs HEAD. If they differ at all, it
  // was touched.
  const baseShow = git(["show", `${base}:CHANGELOG.md`]);
  if (baseShow.exitCode !== 0) {
    // Base has no CHANGELOG.md — treat any addition as touched.
    return unreleasedEnd > unreleasedStart + 1;
  }
  const baseLines = baseShow.stdout.split("\n");
  let baseStart = -1;
  let baseEnd = baseLines.length;
  for (let i = 0; i < baseLines.length; i++) {
    const line = baseLines[i] ?? "";
    if (/^## \[Unreleased\]/.test(line)) {
      baseStart = i;
    } else if (baseStart >= 0 && /^## \[/.test(line)) {
      baseEnd = i;
      break;
    }
  }
  if (baseStart < 0) {
    // Base had no unreleased section; HEAD does — that's a touch.
    return true;
  }
  const baseBlock = baseLines.slice(baseStart, baseEnd).join("\n");
  const headBlock = lines.slice(unreleasedStart, unreleasedEnd).join("\n");
  return baseBlock !== headBlock;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const files = changedFiles(args.base);
  if (files === null) return 2;

  const srcTouched = files.some((f) => f.startsWith("src/"));
  const changelogTouched = files.includes("CHANGELOG.md");

  if (!srcTouched) {
    process.stderr.write("check-changelog: src/ not touched; skipping check.\n");
    return 0;
  }

  if (!changelogTouched) {
    const messages = commitRangeMessages(args.base);
    if (messages === null) return 2;
    if (messages.includes("[skip-changelog]")) {
      process.stderr.write(
        "check-changelog: src/ touched but [skip-changelog] present in commit range; ok.\n",
      );
      return 0;
    }
    process.stderr.write(
      "\ncheck-changelog: ERROR — src/ changed but CHANGELOG.md was not touched.\n" +
        "Per docs/STABILITY.md, every source change ships with a [Unreleased] entry.\n" +
        "Add a line to the '## [Unreleased]' section of CHANGELOG.md, OR include\n" +
        "'[skip-changelog]' in a commit message if the change is intentionally\n" +
        "non-user-facing (refactor with no behaviour change, comment-only edit,\n" +
        "formatting pass).\n",
    );
    return 1;
  }

  const unreleased = unreleasedTouched(args.base);
  if (unreleased === null) return 2;
  if (!unreleased) {
    const messages = commitRangeMessages(args.base);
    if (messages === null) return 2;
    if (messages.includes("[skip-changelog]")) {
      process.stderr.write(
        "check-changelog: CHANGELOG.md touched but not [Unreleased]; " +
          "[skip-changelog] present; ok.\n",
      );
      return 0;
    }
    process.stderr.write(
      "\ncheck-changelog: ERROR — CHANGELOG.md was touched but the '[Unreleased]' " +
        "section did not change.\nNew changes need a bullet under '## [Unreleased]'. " +
        "Editing a prior release's notes does not count.\n",
    );
    return 1;
  }

  process.stderr.write("check-changelog: src/ + CHANGELOG.md [Unreleased] both touched; ok.\n");
  return 0;
}

process.exit(main());
