// Regression for nested wrapper chains that must NOT silently bypass rules.
//
// Two chain shapes are covered:
//
//   1.  bash -c "sudo gcc -o /etc/passwd src.c"  (bash outer)
//       Chain: wrapped-script[bash:"sudo gcc..."] → wrapped[sudo→gcc] →
//       plain[gcc]. Engine recurses on the wrapped-script's inner; inner pass
//       sees the sudo-gcc, runs cmd("gcc").flagValueMatches via the
//       polymorphic tokensAfter dispatch on innerRaw.
//
//   2.  sudo bash -c "gcc -o /etc/passwd src.c"  (sudo outer — was BUG-008)
//       Chain: wrapped[sudo→bash] → wrapped-script[bash:"gcc..."] → plain[gcc].
//       Closed in hook-kit 0.8 via shell-ast 0.7's unwrapDeepParsed walk —
//       the engine scans the full chain for a wrapped-script layer and
//       recurses on its inner script, so the sudo-outermost shape resolves
//       symmetrically to the bash-outermost shape.

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

  test("sudo bash -c 'gcc -o /etc/passwd src.c' — sudo at outermost level (closes BUG-008)", async () => {
    // Was the BUG-008 case: sudo bash -c '…' unwraps as wrapped(sudo→bash) at
    // the outer level, so the v0.6 one-level unwrapCall in recurseInlineShells
    // couldn't see the inner bash -c script and the gcc call escaped. shell-ast
    // 0.7's unwrapDeepParsed walks the full chain: wrapped[sudo→bash] →
    // wrapped-script[bash:"gcc..."] → plain[gcc]. The engine now scans the
    // chain for the wrapped-script layer and recurses on its inner script,
    // resolving this case symmetrically to the bash-outermost shape above.
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev)/)
        .deny("system path"),
    );
    const out = await runModule({
      module: mod,
      command: 'sudo bash -c "gcc -o /etc/passwd src.c"',
    });
    expect(out.terminal?.kind).toBe("deny");
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
