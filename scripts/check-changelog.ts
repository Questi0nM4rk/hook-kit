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

import {
  commitRangeMessages,
  findUnreleasedBlock,
  git,
  readFileAtRef,
  readHeadFile,
} from "./_lib.js";

const SCRIPT = "check-changelog";

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
      process.stderr.write(`check-changelog: unrecognized arg '${String(a)}'\n`);
      process.exit(2);
    }
  }
  return { base };
}

function changedFiles(base: string): string[] | null {
  const r = git(["diff", "--name-only", `${base}..HEAD`]);
  if (r.exitCode !== 0) {
    process.stderr.write(`${SCRIPT}: git diff failed against ${base}\n${r.stderr}`);
    return null;
  }
  return r.stdout.split("\n").filter((line) => line.length > 0);
}

/** True if the `[Unreleased]` section differs between `<base>:CHANGELOG.md`
 *  and the current working-tree CHANGELOG.md. If the section is missing
 *  from one side, treat that asymmetry as a touch. */
function unreleasedTouched(base: string): boolean | null {
  const headSource = readHeadFile("CHANGELOG.md", SCRIPT);
  if (headSource === null) {
    return null;
  }
  const headBlock = findUnreleasedBlock(headSource.split("\n"));
  if (headBlock === null) {
    process.stderr.write(
      `${SCRIPT}: CHANGELOG.md has no '## [Unreleased]' section; please add one.\n`,
    );
    return false;
  }

  const baseSource = readFileAtRef(base, "CHANGELOG.md", SCRIPT);
  if (baseSource === null) {
    return headBlock[1] > headBlock[0] + 1;
  }
  const baseLines = baseSource.split("\n");
  const baseBlock = findUnreleasedBlock(baseLines);
  if (baseBlock === null) {
    return true;
  }

  const headLines = headSource.split("\n");
  return baseLines.slice(...baseBlock).join("\n") !== headLines.slice(...headBlock).join("\n");
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const files = changedFiles(args.base);
  if (files === null) {
    return 2;
  }

  const srcTouched = files.some((f) => f.startsWith("src/"));
  const changelogTouched = files.includes("CHANGELOG.md");

  if (!srcTouched) {
    process.stderr.write("check-changelog: src/ not touched; skipping check.\n");
    return 0;
  }

  if (!changelogTouched) {
    const messages = commitRangeMessages(args.base, SCRIPT);
    if (messages === null) {
      return 2;
    }
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
  if (unreleased === null) {
    return 2;
  }
  if (!unreleased) {
    const messages = commitRangeMessages(args.base, SCRIPT);
    if (messages === null) {
      return 2;
    }
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
