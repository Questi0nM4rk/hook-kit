// Isolated working dir for spawning the compiled hk binary in build tests.
//
// WHY THIS EXISTS — the footgun it closes:
// `hk` is a `bash -c` substitute: any command it does NOT block, it EXECUTES
// verbatim (the shell-wrapper output convention). The adversarial/e2e corpora
// deliberately feed it commands that the rules ALLOW (e.g. `git checkout main`,
// `git pull`, `git push --force-with-lease`) to prove the rules don't over-block.
// If the binary is spawned with the test process's cwd (the hook-kit repo root),
// those allowed commands run AGAINST THE REAL REPOSITORY:
//   - `git checkout main` reverts the working tree to main (old test files, new
//     ones gone) and moves HEAD — corrupting every later test file in the same
//     `bun test` run. This is git-invisible (working tree + HEAD genuinely change),
//     so `git status` stays clean while CI runs stale code.
//   - `git push --force-with-lease` / `git pull` are real remote operations.
// It only manifests where `main` is freely checkout-able: CI's detached
// `refs/pull/<n>/merge` checkout reproduces it; a developer worktree (main checked
// out in the primary) and a `.git`-less tarball both mask it — which is exactly
// why it survived local + container validation and only reddened CI.
//
// THE GUARANTEE: spawn the staged binary with `cwd` inside a throwaway, non-git
// directory. Allowed commands then execute harmlessly there (a fresh tmp dir has
// no `.git` and no remote, so git operations fail without side effects), and can
// never touch the real repo. The "allowed commands execute in an isolated cwd"
// case in tests/build/adversarial.test.ts locks this in.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
  /** Absolute path to the throwaway, non-git working directory. */
  readonly dir: string;
  /** Remove the sandbox. Call from afterAll. */
  cleanup(): void;
}

/**
 * Create an isolated, non-git throwaway directory to use as the `cwd` for every
 * compiled-binary spawn in a build test. Always pass `cwd: sandbox.dir` to
 * `Bun.spawn` so commands the binary executes cannot reach the real repository.
 */
export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "hk-bin-sandbox-"));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
