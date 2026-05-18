// Regression for nested wrapper chains that must NOT silently bypass rules:
//
//   bash -c "sudo gcc -o /etc/passwd src.c"
//
// The chain: outer is wrapped-script (bash -c '…'); engine recurses on the
// inner script, parses it; inner is wrapped (sudo gcc); unwrapCall produces
// wrapped with innerRaw = gcc call. cmd("gcc").flagValueMatches must fire
// via the polymorphic tokensAfter dispatch on innerRaw.
//
// Pinned here so future engine / shell-ast changes can't quietly break the
// chain. shell-ast BUG-008 (unwrapDeep) would simplify this, but the
// recursion + sudo-unwrap composition already covers the case today.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { runModule } from "../../src/engine/index.js";

function modOf(rule: Parameters<typeof createModule>[1][number]) {
  return createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [rule]);
}

describe("deep-nesting wrapper chains — recursion + sudo-unwrap + flagValue (regression)", () => {
  test("bash -c 'sudo gcc -o /etc/passwd src.c' — full chain fires deny", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev|usr|boot)/)
        .deny("system path via nested chain"),
    );
    const out = await runModule({
      module: mod,
      command: 'bash -c "sudo gcc -o /etc/passwd src.c"',
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("bash -c 'sudo /usr/bin/gcc -o /etc/passwd src.c' — chain + full-path inner (basename match)", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev)/)
        .deny("system path"),
    );
    const out = await runModule({
      module: mod,
      command: 'bash -c "sudo /usr/bin/gcc -o /etc/passwd src.c"',
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("sudo bash -c 'gcc -o /etc/passwd src.c' — sudo at outermost level (wrapped-opaque-then-recurse path)", async () => {
    // Today's known limitation (shell-ast BUG-008): sudo bash -c '…' unwraps
    // as wrapped(sudo→bash) at the outer level; the bash -c argument is
    // opaque to one-level unwrap. Our engine recursion fires only on
    // kind="wrapped-script", which `sudo bash -c '…'` is NOT (it's
    // `wrapped`, the inner being bash). So the inner gcc currently escapes.
    //
    // This test pins the CURRENT behavior (no terminal) so we notice if
    // shell-ast ships unwrapDeep / equivalent and the test flips to deny —
    // at which point we update the assertion + remove this comment.
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev)/)
        .deny("system path"),
    );
    const out = await runModule({
      module: mod,
      command: 'sudo bash -c "gcc -o /etc/passwd src.c"',
    });
    expect(out.terminal).toBeNull(); // BUG-008 limitation — flip when shell-ast ships unwrapDeep
  });

  test("nested bash -c 'bash -c \"gcc -o /etc/x src.c\"' — two layers of inline-shell recursion", async () => {
    // Mixed quoting (single outer, double inner) is the only POSIX shape
    // that nests cleanly without ambiguous backslash escapes.
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("nested system path"),
    );
    const out = await runModule({
      module: mod,
      command: "bash -c 'bash -c \"gcc -o /etc/x src.c\"'",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("bash -c 'sudo gcc -o $TARGET src.c' — chain + dynamic catcher", async () => {
    // Single-quote outer keeps `$TARGET` literal at the outer level so the
    // bash -c inner script is `sudo gcc -o $TARGET src.c`. Engine recurses
    // into it, parses, sees wrapped(sudo→gcc) with $TARGET as DYNAMIC value
    // for -o. flagValueDynamic catches via the polymorphic isDynamic check
    // dispatched through u.innerRaw.
    //
    // (Earlier draft used double-quote outer — that made $TARGET expand at
    // OUTER parse time, the inner script became wrapped-opaque, and engine
    // recursion never fired. shell-ast correctly classifies that as opaque;
    // hook-kit's dynamic catcher works once recursion can actually reach
    // the inner gcc call.)
    const mod = modOf(cmd("gcc").flagValueDynamic("-o").deny("dynamic -o through chain"));
    const out = await runModule({
      module: mod,
      command: "bash -c 'sudo gcc -o $TARGET src.c'",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("DYNAMIC at outer level makes inner opaque — no rule firing (limitation pin)", async () => {
    // Counterpart to the previous test: when `$VAR` appears in the OUTER
    // double-quoted script, the entire inner becomes wrapped-opaque from
    // shell-ast's perspective — there's no static script to recurse into.
    // Pinned here so we notice if shell-ast ever ships symbolic-resolution
    // and this case starts firing.
    const mod = modOf(cmd("gcc").flagValueDynamic("-o").deny("dynamic -o"));
    const out = await runModule({
      module: mod,
      command: 'bash -c "gcc -o $TARGET src.c"',
    });
    expect(out.terminal).toBeNull();
  });
});
