# CI `test` job: stale test snapshot on GitHub Actions (resolved)

**Status:** Resolved. **Scope:** why `test.yml`'s `test` job was red on PR #29
(`feat/security-uncertainty`) while the code was green everywhere else.

## Resolution — corrected root cause (the "stale snapshot" was a symptom)

The working tree was not stale on checkout, and `file:../..` was **not** the cause
(removing it entirely still reproduced the failure). The actual cause:

**`tests/build/adversarial.test.ts` executed a real `git checkout main` against the
repository, mid-test.** `hk` is a `bash -c` substitute: any command it does not
block, it **executes**. The adversarial corpus feeds it `git checkout main` (to
prove the destructive-git rule allows branch checkout vs blocking
`git checkout -- file`), and `runHk` spawned the compiled binary with **no `cwd`**,
inheriting the repo root. So the allowed `git checkout main` ran for real, reverting
the working tree to `main`'s pre-SA content (old tests, new SA test files gone) and
moving HEAD — every later file in the same `bun test tests/` run then read old code
(old assertions fail; new files `ENOENT`). It is git-invisible because HEAD + the
working tree genuinely change, so `git status` stays clean.

Why only CI: the executed `git checkout main` only **succeeds** where `main` is
freely checkout-able. A developer worktree (main checked out in the primary) and a
`.git`-less container tarball both make it **fail harmlessly** — which is exactly
why it passed local + container validation and only reddened CI's detached
`refs/pull/<n>/merge` checkout. Proven via the runner's reflog
(`checkout: moving from <merge> to main`) and reproduced locally in a detached
clone. `no-cache` / `coverageSkipTestFiles` never touched it because nothing was
wrong with bun.

**Fix:** spawn every compiled-binary invocation in the build tests with `cwd` inside
a throwaway, non-git sandbox (`tests/build/_sandbox.ts`), so executed allowed
commands cannot reach the real repo. A regression guard in `adversarial.test.ts`
("allowed commands must never touch the real repo") locks it in. The `file:../..`
self-referential workspace remains a separate latent smell (a `bun install`
hardlink farm of the whole repo into `node_modules`), but it does not cause this
failure and is out of scope here.

Everything below is the original investigation record, kept for history; its
"prime suspect" (`file:../..`) and "stale snapshot" framing are **superseded** by
the resolution above.

## Symptom

On the GitHub Actions runner, `bun run test` → `bun scripts/check-coverage.ts`
(which runs `bun test tests/ --coverage`) fails with:

```text
error: ENOENT reading "/home/runner/work/hook-kit/hook-kit/tests/builders/allow-only.test.ts"
error: ENOENT reading ".../tests/builders/protect-path.test.ts"
error: ENOENT reading ".../tests/builders/{dynamic-value-escalation,alias-scoping,dynamic-command-word}.test.ts"
(fail) cmd() — basic matching > does not match on a malformed Bash command (parse error)
(fail) .flagValueMatches() — regex predicate (A2) > dynamic value: -o $VAR — skipped silently, no match
(fail) deep-nesting wrapper chains — ... > DYNAMIC at outer level makes inner opaque — no rule firing (limitation pin)
```

## The decisive clue

`(fail) cmd() … "does not match on a malformed Bash command"` is a test name that
**no longer exists in the repo** — it was renamed to `"escalates on a malformed
Bash command (SA-03 — cannot verify)"` in commit `806399e`, which is present in
**every** commit the PR has ever had. The PR merge ref CI checks out
(`refs/pull/29/merge`, verified `c4fa84e` = head+main) contains the *new* name.

**Therefore CI is executing a STALE snapshot of the test files**, not the code it
checked out. The 3 "failures" are old pre-SA tests (asserting fail-open `null`)
running against the new engine (which now escalates) → `expect(...).toBeNull()`
fails. The `ENOENT` are the *new* test files (added on the branch) that the stale
snapshot's file list points at but can't read.

## Ruled out (with evidence)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| bun version (canary vs latest) | ❌ | CI `latest` resolves to `bun-v1.3.14`; local is `1.3.14` too |
| OS (Arch vs Ubuntu) | ❌ | `ubuntu:24.04` + bun 1.3.14 container: **798 pass, 0 fail, 0 ENOENT** |
| `--coverage` itself | ❌ | `bun test tests/ --coverage` is green in all 3 containers |
| The code / merge ref | ❌ | merge ref `c4fa84e` has the correct "escalates" tests; 3 containers green |
| setup-bun cross-run cache | ❌ | `no-cache: true` (commit `4ea7dba`) — still fails identically |
| bun instrumenting test files | ❌ | `coverageSkipTestFiles = true` (commit `c917011`) — still fails identically |

**Containers do NOT reproduce it.** `oven/bun:1.3.14` (Debian), `ubuntu:24.04` +
bun 1.3.14, and local Arch all run the full suite green. The failure is exclusive
to the GitHub Actions runner.

### Container repro recipe (for floor / no-regression checks only — does NOT repro the CI bug)

```bash
WT=$(pwd)   # the feat/security-uncertainty worktree
docker run --rm -v "$WT":/host:ro ubuntu:24.04 bash -c '
  apt-get update -qq && apt-get install -y -qq curl unzip git ca-certificates >/dev/null
  curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" >/dev/null; export PATH=$HOME/.bun/bin:$PATH
  mkdir /work; (cd /host && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - .) | (cd /work && tar xf -)
  cd /work && bun install --frozen-lockfile --ignore-scripts >/dev/null
  bun test tests/ --coverage 2>&1 | tail -5'   # => 798 pass, 0 fail
```

## Prime suspect: the `file:../..` example workspace copy (from #28)

`package.json` `workspaces` + the examples' `"@questi0nm4rk/hook-kit": "file:../.."`
dep (added in #28 to make `bun test examples/adapter-template/tests/` and
`bun run typecheck` resolve the local package) makes bun store a **full copy of
the repo — including `tests/`** — as `@questi0nm4rk+hook-kit@root` under
`node_modules/.bun/`. Confirmed the copy contains `tests/builders/cmd.test.ts`
etc. This is the ONLY mechanism that puts a second, snapshot-able copy of the
test files into the tree. The leading theory is that on the GHA filesystem, bun's
test/coverage pass discovers and runs this copy (or a bun-internal `file:`-dep
cache of it) in a stale/partial state → old test code + ENOENT. Why it only
manifests on GHA (not in containers) is the open question.

## Fixes attempted this session (all insufficient)

1. `4ea7dba` — `no-cache: true` on both `setup-bun` steps. No change.
2. `c917011` — `coverageSkipTestFiles = true` in `bunfig.toml`. No change.

Both are reasonable CI hygiene and were left in place; revisit if they interfere.

## Recommended next steps (most promising first)

1. **Eliminate the repo-copying `file:../..` mechanism** — it is the common thread
   in every theory and caused this regression. Options:
   - Replace the workspaces+`file:` deps with a **committed symlink**
     `examples/<x>/node_modules/@questi0nm4rk/hook-kit -> ../../../..` (force-add
     past `.gitignore` with a negation). The example is then NOT a workspace, so
     `bun install` ignores it and never makes the `@root` copy. Resolves both
     `bun test examples/.../tests/` and `bun run typecheck`.
   - OR drop `bun test examples/adapter-template/tests/` from the root `test`
     script (the adapter is already CI-smoke-tested via the compiled-binary
     `tests/build/adapter-template-e2e.test.ts`) AND give each example a local
     `tsconfig.json` with a `paths` map for typecheck — removing the need for the
     workspace entirely.
   Then push and watch CI (the only env that reproduces).
2. **Add `coveragePathIgnorePatterns = ["**/node_modules/**"]`** to `bunfig.toml`
   in case bun's coverage is scanning the `@root` copy specifically.
3. **Reproduce on a real GHA runner** — `act` (nektos/act) with the
   `ubuntu-24.04` image, or a self-hosted runner, since containers don't repro.
4. **Search bun issues** for `file:` workspace dep + `--coverage` + `ENOENT` /
   stale test discovery; this looks like a bun bug worth filing upstream with the
   minimal repro (a repo with a `file:../..` self-referential workspace + tests).

## State at handoff

- Branch `feat/security-uncertainty` @ `c917011` (pushed). PR **#29 open, NOT
  merged** (kept as the cc-review test bed). All other CI checks green
  (Semgrep / Markdownlint / cc-review). Only `test` is red, for the reason above.
- The security feature itself is complete + reviewed: all `/code-review` findings
  and all 19 cc-review findings fixed; **798 tests pass locally and in every
  container.** The red CI is purely this GHA `test`-snapshot issue, not the code.
- Related: cc-review fixes `Questi0nM4rk/cc-review` #44/#45/#46 (closed); the
  example-resolution origin is PR #28 (merged to main).
