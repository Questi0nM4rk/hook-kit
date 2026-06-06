import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import type { EvaluationOutcome, Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-07 (#21): semantic flag aliases (-r ↔ --recursive, -f ↔ --force) were
// expanded GLOBALLY, so shell-ast's bundled split of `gcc -Dmacro` →
// [-D,-m,-a,-c,-r,-o] made a stray `-r` match a `--recursive` rule on gcc.
// Aliases are now command-scoped: only curated commands (rm, cp, …) expand
// short↔long. Unlisted commands match flags literally. Literal long flags
// (git push --force) still match anywhere — no expansion needed.

function run(command: string, rule: Rule): Promise<EvaluationOutcome> {
  return runModule({ module: moduleWith([rule]), command });
}

describe("SA-07 command-scoped flag aliases", () => {
  test("gcc -Dmacro does not false-match a --recursive rule", async () => {
    const o = await run("gcc -Dmacro f.c", cmd("gcc").withFlag("--recursive").deny("x"));
    expect(o.terminal).toBeNull();
  });

  test("rm -r still matches --recursive (rm aliases are scoped in)", async () => {
    const o = await run("rm -r /x", cmd("rm").withFlag("--recursive").deny("x"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("rm -f still matches --force", async () => {
    const o = await run("rm -f /x", cmd("rm").withFlag("--force").deny("x"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("an unlisted command does not expand short aliases", async () => {
    const o = await run("mytool -r foo", cmd("mytool").withFlag("--recursive").deny("x"));
    expect(o.terminal).toBeNull();
  });

  test("literal long flags still match on any command (git push --force)", async () => {
    const o = await run("git push --force", cmd("git", "push").withFlag("--force").deny("x"));
    expect(o.terminal?.kind).toBe("deny");
  });
});
