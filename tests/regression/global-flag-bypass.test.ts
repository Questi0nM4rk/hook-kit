// Regression for shell-ast BUG-000: leading value-taking global flags
// (`git -C /tmp`, `docker -H ...`, `kubectl --context ...`, `make -C ...`,
// `tar -C ...`) used to shift positional args, breaking hook-kit's
// subcommand-position matching. shell-ast v0.4.0 closed the bug via the
// per-tool GLOBAL_VALUE_FLAGS table in src/flags.ts; adopted in hook-kit
// 0.5.1 via the shell-ast `^0.5.1` dep range.
//
// Coverage map (each row = one previously-bypass pattern):
//   git -C <dir> <sub> [args]      — subcommand-position match must still fire
//   docker -H <host> <sub> [args]  — same
//   kubectl --context <ctx> <sub>  — same
//   make -C <dir> <target>         — args[0] = target, not <dir>
//   tar -C <dir> <op>              — args[0] = op, not <dir>
//   sudo git -C <dir> <sub>        — global-flag table applies post-unwrap

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { runModule } from "../../src/engine/index.js";

function modOf(rule: Parameters<typeof createModule>[1][number]) {
  return createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [rule]);
}

describe("shell-ast BUG-000 regression — global value-flag positional shift", () => {
  test("git -C /tmp worktree add → cmd('git', 'worktree', 'add') fires", async () => {
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "git -C /tmp worktree add /tmp/x main",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("docker -H tcp://... run → cmd('docker', 'run') fires", async () => {
    const mod = modOf(cmd("docker", "run").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "docker -H tcp://example.com:2375 run --rm ubuntu echo hi",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("kubectl --context prod get → cmd('kubectl', 'get') fires", async () => {
    const mod = modOf(cmd("kubectl", "get").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "kubectl --context prod get pods",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  // biome-ignore lint/security/noSecrets: test name describing a shell command pattern; not a credential.
  test("make -C /repo build → cmd('make') + argIncludes('build') fires", async () => {
    const mod = modOf(cmd("make").argIncludes("build").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "make -C /repo build",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("tar -C /target xf - → cmd('tar') with subcommand-style arg fires", async () => {
    // tar's `xf` is a flag-cluster, not a subcommand; this test verifies
    // that the -C value consumption doesn't break flag-cluster matching.
    const mod = modOf(cmd("tar").withFlag("-x").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "tar -C /target -xf archive.tgz",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("sudo git -C /tmp worktree add → global-flag table applies post-sudo-unwrap", async () => {
    // The sudo-aware unwrap re-runs flag resolution on the inner call.
    // The global-flag table must apply to the inner `git` for the subcommand
    // match to fire.
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "sudo git -C /tmp worktree add /tmp/x main",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("regression: bare `git worktree add` still fires (no global flag present)", async () => {
    // Sanity check that adding the global-flag table doesn't break the
    // existing happy path.
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "git worktree add /tmp/x main",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("regression: unknown tool with leading -X stays in boolean-flag mode", async () => {
    // The global-flag table is opt-in coverage; for tools not in the table,
    // leading -X tokens are still treated as boolean flags. We assert that
    // an unknown tool's positional args shift just like 0.3 behavior.
    const mod = modOf(cmd("rare-tool", "sub").deny("blocked"));
    const outcome = await runModule({
      module: mod,
      command: "rare-tool -X arbitrary-value sub",
    });
    // Pre-bump: this fires (because args[0] = "arbitrary-value", not "sub" —
    // and current cmd() requires args[0] === "sub", so it actually MISSES).
    // Post-bump: same MISS, because rare-tool isn't in the global-flag table.
    // Either way, the rule should NOT fire for this command shape.
    expect(outcome.terminal).toBeNull();
  });
});
