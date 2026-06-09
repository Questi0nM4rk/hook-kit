// Smoke + behavior coverage for expectModule / expectRule fluent runner.
// Mixes the real builders (cmd, path, redirect, stateful) so the runner is
// exercised end-to-end through the engine, not against a mock.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { path } from "../../src/builders/path.js";
import { redirect } from "../../src/builders/redirect.js";
import { stateful } from "../../src/builders/state.js";
import { warning } from "../../src/core/decision.js";
import { createModule } from "../../src/core/module.js";
import { expectModule, expectRule } from "../../src/testing/expect.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/testing/index.js";
import { mockState } from "../../src/testing/mock-state.js";
import { modOf as modOfHelper } from "../_helpers.js";

// expect tests mix Bash + file-tool rules, so widen the shared `modOf` matchers
// to all four tool channels via its second arg.
const modOf = (rule: Parameters<typeof createModule>[1][number]) =>
  modOfHelper(rule, ["Bash", "Edit", "Write", "Read"]);

describe("expectModule.toDeny", () => {
  test("fires on matching rule", async () => {
    const mod = modOf(cmd("rm").withFlag("--force").deny("blocked"));
    await expectModule(mod).onCommand("rm -rf /tmp/x").toDeny();
  });

  test("regex matcher on reason", async () => {
    const mod = modOf(cmd("rm").deny("dangerous deletion"));
    await expectModule(mod)
      .onCommand("rm /tmp/x")
      .toDeny(/dangerous/);
  });

  test("string matcher on reason uses ===", async () => {
    const mod = modOf(cmd("rm").deny("dangerous deletion"));
    await expectModule(mod).onCommand("rm /tmp/x").toDeny("dangerous deletion");
  });

  test("throws when reason doesn't match", async () => {
    const mod = modOf(cmd("rm").deny("foo"));
    // bun:test's `.rejects.toThrow()` types as void but resolves async at runtime; use try/await/catch so eslint can see the awaited promise.
    let caught: unknown;
    try {
      await expectModule(mod).onCommand("rm /tmp/x").toDeny(/bar/);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/expected deny reason matching/);
  });

  test("throws when terminal is not deny", async () => {
    const mod = modOf(cmd("rm").ask("review"));
    let caught: unknown;
    try {
      await expectModule(mod).onCommand("rm /tmp/x").toDeny();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/expected deny terminal/);
  });
});

describe("expectModule.toAsk", () => {
  test("fires on ask rule", async () => {
    const mod = modOf(cmd("git", "push").withFlag("--force").ask("confirm force"));
    await expectModule(mod)
      .onCommand("git push --force")
      .toAsk(/confirm/);
  });
});

describe("expectModule.toRun", () => {
  test("passes when no rule fires", async () => {
    const mod = modOf(cmd("rm").deny("blocked"));
    await expectModule(mod).onCommand("ls /tmp").toRun();
  });

  test("throws when a terminal fires", async () => {
    const mod = modOf(cmd("rm").deny("blocked"));
    let caught: unknown;
    try {
      await expectModule(mod).onCommand("rm /tmp/x").toRun();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/expected no terminal/);
  });
});

describe("expectModule.toWarn", () => {
  test("fires on warning annotation", async () => {
    const mod = modOf(cmd("rm").warning("annotated"));
    await expectModule(mod).onCommand("rm /tmp/x").toWarn();
  });

  test("regex matcher on message", async () => {
    const mod = modOf(cmd("rm").warning("hey watch out"));
    await expectModule(mod).onCommand("rm /tmp/x").toWarn(/watch/);
  });

  test("throws when no warning fires", async () => {
    const mod = modOf(cmd("rm").note("just a note"));
    let caught: unknown;
    try {
      await expectModule(mod).onCommand("rm /tmp/x").toWarn();
    } catch (err) {
      caught = err;
    }
    expect((caught as Error | undefined)?.message).toMatch(/at least one warning/);
  });
});

describe("expectModule.toNote", () => {
  test("fires on note annotation", async () => {
    const mod = modOf(cmd("rm").note("informational"));
    await expectModule(mod).onCommand("rm /tmp/x").toNote(/info/);
  });
});

describe("expectModule chained setup", () => {
  test("withState makes state available to stateful rule", async () => {
    const state = mockState({ "deletes:count": 0 });
    const rule = stateful("counter", (_event, s) => {
      const n = (s.get("deletes:count") as number) + 1;
      s.set("deletes:count", n);
      if (n >= 2) {
        return warning(`hit ${String(n)}`);
      }
      return null;
    });
    const mod = modOf(rule);
    await expectModule(mod).withState(state).onCommand("rm /tmp/x").toRun();
    await expectModule(mod).withState(state).onCommand("rm /tmp/y").toWarn(/hit 2/);
    expect(state.get("deletes:count")).toBe(2);
  });

  test("withShellAstOpts threads through to engine", async () => {
    // kustomize isn't in shell-ast's built-in globalFlags table — register here.
    // Re-pointed terraform -> kustomize: shell-ast 0.8.0 ships terraform built-in,
    // so its registration is a no-op and the deny would fire even if
    // withShellAstOpts didn't thread through. kustomize is still unregistered, so
    // the deny PROVES the opts reached the engine's resolver.
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    await expectModule(mod)
      .withShellAstOpts({ globalFlags: { kustomize: ["--load-restrictor"] } })
      .onCommand("kustomize --load-restrictor LoadRestrictionsNone build /overlay")
      .toDeny();
  });

  test("noInlineShellRecursion disables bash -c inner pass", async () => {
    const mod = modOf(cmd("rm").deny("blocked"));
    // With recursion (default), bash -c "rm" fires the rule
    await expectModule(mod).onCommand('bash -c "rm /tmp/x"').toDeny();
    // Without recursion, only outer 'bash' is seen — rule doesn't fire
    await expectModule(mod).noInlineShellRecursion().onCommand('bash -c "rm /tmp/x"').toRun();
  });
});

describe("expectModule.withSecurity", () => {
  // A cmd() terminal rule whose target is a DYNAMIC command word ($CMD) can't
  // be statically certified (SA-01), so it escalates per the security profile:
  // ask under STRICT_BUT_ASKS, deny under STRICT_DENY. Same rule + command,
  // different profile → different terminal. This is the exact test/prod
  // divergence the SDK exists to prevent.
  const denyRm = () => modOf(cmd("rm").deny("rm blocked"));

  test("STRICT_BUT_ASKS profile yields ask", async () => {
    await expectModule(denyRm()).withSecurity(STRICT_BUT_ASKS).onCommand("$CMD -rf /tmp/x").toAsk();
  });

  test("STRICT_DENY profile yields deny", async () => {
    await expectModule(denyRm()).withSecurity(STRICT_DENY).onCommand("$CMD -rf /tmp/x").toDeny();
  });

  test("omitting withSecurity keeps the engine default (STRICT_BUT_ASKS → ask)", async () => {
    await expectModule(denyRm()).onCommand("$CMD -rf /tmp/x").toAsk();
  });

  test("withSecurity threads through expectRule too", async () => {
    await expectRule(cmd("rm").deny("rm blocked"))
      .withSecurity(STRICT_DENY)
      .onCommand("$CMD -rf /tmp/x")
      .toDeny();
  });
});

describe("expectModule event variety", () => {
  test("onWrite synthesizes Write event", async () => {
    const mod = modOf(
      path(/\.env$/)
        .onWrite()
        .deny("no env writes"),
    );
    await expectModule(mod).onWrite("/tmp/.env", "x=1").toDeny();
  });

  test("onRead synthesizes Read event", async () => {
    const mod = modOf(
      path(/\.env$/)
        .onRead()
        .deny("no env reads"),
    );
    await expectModule(mod).onRead("/tmp/.env").toDeny();
  });

  test("onEdit synthesizes Edit event", async () => {
    const mod = modOf(
      path(/migrations/)
        .onWrite()
        .deny("no migration edits"),
    );
    await expectModule(mod).onEdit("/tmp/migrations/001.sql", "old", "new").toDeny();
  });

  test("redirect rule fires on shell event", async () => {
    const mod = modOf(redirect(/\/etc\//).deny("no /etc writes"));
    await expectModule(mod).onCommand("echo hi > /etc/passwd").toDeny();
  });
});

describe("expectModule.outcome() escape hatch", () => {
  test("returns full EvaluationOutcome for custom assertions", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("rm").warning("w1"),
      cmd("rm").note("n1"),
    ]);
    const out = await expectModule(mod).onCommand("rm /tmp/x").outcome();
    expect(out.terminal).toBeNull();
    expect(out.annotations).toHaveLength(2);
    expect(out.annotations[0]?.kind).toBe("warning");
    expect(out.annotations[1]?.kind).toBe("note");
  });
});

describe("expectRule single-rule shortcut", () => {
  test("wraps rule in synthetic module", async () => {
    await expectRule(cmd("rm").deny("blocked"))
      .onCommand("rm /tmp/x")
      .toDeny(/blocked/);
  });

  test("works for non-bash rules too (synthetic module accepts all events)", async () => {
    await expectRule(
      path(/\.env$/)
        .onWrite()
        .deny("no env"),
    )
      .onWrite("/tmp/.env")
      .toDeny();
  });
});

describe("expectModule array form", () => {
  test("accepts multiple modules — annotations from both stack", async () => {
    const m1 = createModule({ id: "m1", name: "m1", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("rm").warning("from m1"),
    ]);
    const m2 = createModule({ id: "m2", name: "m2", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("rm").note("from m2"),
    ]);
    const out = await expectModule([m1, m2]).onCommand("rm /tmp/x").outcome();
    expect(out.annotations).toHaveLength(2);
  });
});
