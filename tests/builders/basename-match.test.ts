// A1 (0.6.0): `cmd("X")` matches by basename of the invocation's command word
// by default. `/usr/bin/git`, `./bin/git`, `git` all fire `cmd("git")`. The
// dispatch lives in engine/helpers.ts:unwrappedName via shell-ast 0.6's
// polymorphic `resolvedCmd(u)`.
//
// Two routes to exact-match (no basename normalization):
//   1. Path-shaped cmd arg — `cmd("/usr/bin/git")` auto-detects from "/"
//      and switches to exact match without boilerplate.
//   2. `.matchExact()` modifier — for bare-name exact match (rare vendored-
//      binary pattern: "allow /opt/git/bin/git, deny system `git`").

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

describe("path-shape auto-detection (A1)", () => {
  test("cmd('/usr/bin/git') fires only on that exact invocation (no modifier needed)", async () => {
    const mod = modOf(cmd("/usr/bin/git").deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("cmd('/usr/bin/git') does NOT fire on bare command name", async () => {
    const mod = modOf(cmd("/usr/bin/git").deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "git status" });
    expect(out.terminal).toBeNull();
  });

  test("cmd('/usr/bin/git') does NOT fire on a different full path", async () => {
    const mod = modOf(cmd("/usr/bin/git").deny("vendored-git-only"));
    const out = await runModule({ module: mod, command: "/opt/git/bin/git status" });
    expect(out.terminal).toBeNull();
  });

  test("cmd('./bin/git') auto-detects path-mode from relative '/'", async () => {
    const mod = modOf(cmd("./bin/git").deny("relative-path"));
    const fires = await runModule({ module: mod, command: "./bin/git status" });
    expect(fires.terminal?.kind).toBe("deny");
    const doesNot = await runModule({ module: mod, command: "git status" });
    expect(doesNot.terminal).toBeNull();
  });

  test(".matchExact() on a path-shaped cmd is redundant but harmless", async () => {
    const mod = modOf(cmd("/usr/bin/git").matchExact().deny("explicit"));
    const out = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(out.terminal?.kind).toBe("deny");
  });
});

describe(".matchExact() opt-out on bare cmd names (A1)", () => {
  test("cmd('git').matchExact() requires exact 'git', NOT '/usr/bin/git'", async () => {
    // The vendored-binary pattern: deny default `git` but allow `/opt/git/bin/git`.
    const mod = modOf(cmd("git").matchExact().deny("blocked"));
    const bare = await runModule({ module: mod, command: "git status" });
    expect(bare.terminal?.kind).toBe("deny");
    const fullPath = await runModule({ module: mod, command: "/usr/bin/git status" });
    expect(fullPath.terminal).toBeNull();
  });
});
