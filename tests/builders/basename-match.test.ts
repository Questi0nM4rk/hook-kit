// A1 (0.6.0): `cmd("X")` matches by basename of the invocation's command word
// by default. `/usr/bin/git`, `./bin/git`, `git` all fire `cmd("git")`. The
// dispatch lives in engine/helpers.ts:unwrappedName via shell-ast 0.6's
// polymorphic `resolvedCmd(u)`.
//
// `.strictPath()` opts out: requires exact path-as-typed match.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { runModule } from "../../src/engine/index.js";

function modOf(rule: Parameters<typeof createModule>[1][number]) {
  return createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [rule]);
}

describe("basename-match default (A1)", () => {
  test("cmd('git') fires on bare 'git'", async () => {
    const mod = modOf(cmd("git").deny("blocked"));
    const out = await runModule({ module: mod, command: "git status" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('git') fires on '/usr/bin/git'", async () => {
    const mod = modOf(cmd("git").deny("blocked"));
    const out = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('docker') fires on '/usr/local/bin/docker'", async () => {
    const mod = modOf(cmd("docker", "run").deny("blocked"));
    const out = await runModule({ module: mod, command: "/usr/local/bin/docker run -it ubuntu" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('git') fires on relative './bin/git'", async () => {
    const mod = modOf(cmd("git").deny("blocked"));
    const out = await runModule({ module: mod, command: "./bin/git status" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('rm') fires on sudo /usr/bin/rm (wrapped + full path)", async () => {
    const mod = modOf(cmd("rm").deny("blocked"));
    const out = await runModule({ module: mod, command: "sudo /usr/bin/rm -rf /tmp/x" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('bash') fires on '/usr/bin/bash -c <script>' (wrapped-script)", async () => {
    const mod = modOf(cmd("bash").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: '/usr/bin/bash -c "echo hi"',
      recurseInlineShells: false, // isolate wrapper-name match from inner recursion
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("no match when basename differs", async () => {
    const mod = modOf(cmd("git").deny("blocked"));
    const out = await runModule({ module: mod, command: "/usr/bin/gitk --all" });
    expect(out.terminal).toBeNull();
  });

  test("cmd('git', 'worktree', 'add') subcommand match still fires on full path", async () => {
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "/usr/bin/git worktree add /tmp/x main",
    });
    expect(out.terminal?.kind).toBe("deny");
  });
});

describe(".strictPath() opt-out (A1)", () => {
  test("strictPath rule fires only on the typed path", async () => {
    const mod = modOf(cmd("/usr/bin/git").strictPath().deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("strictPath rule does NOT fire on bare command name", async () => {
    const mod = modOf(cmd("/usr/bin/git").strictPath().deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "git status" });
    expect(out.terminal).toBeNull();
  });

  test("strictPath rule does NOT fire on a different full path", async () => {
    const mod = modOf(cmd("/usr/bin/git").strictPath().deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "/opt/git/bin/git status" });
    expect(out.terminal).toBeNull();
  });

  test("strictPath('git') (no path) still requires exact 'git'", async () => {
    // Edge: user writes `cmd("git").strictPath()` — equivalent to "no basename
    // normalization, exact-match on what shell-ast captured." Bare `git` invocations
    // still match (u.cmd === "git"), but `/usr/bin/git` does not.
    const mod = modOf(cmd("git").strictPath().deny("blocked"));
    const bare = await runModule({ module: mod, command: "git status" });
    expect(bare.terminal?.kind).toBe("deny");
    const fullPath = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(fullPath.terminal).toBeNull();
  });
});
