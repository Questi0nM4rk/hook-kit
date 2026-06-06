import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import type { Rule, Terminal } from "../../src/core/types.js";
import { __setMaxRecurseDepthForTests, evaluate } from "../../src/engine/index.js";
import { bashEvent, moduleWith } from "../_helpers.js";

const mod = (rule: Rule) => moduleWith([rule]);

async function runTerminal(command: string, rule: Rule): Promise<Terminal | null> {
  const outcome = await evaluate(bashEvent(command), [mod(rule)]);
  return outcome.terminal;
}

describe("inline-shell recursion", () => {
  test("`bash -c 'rm -rf /'` triggers a cmd('rm') rule via recursion", async () => {
    const t = await runTerminal(
      `bash -c 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(t).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("`sh -c 'rm -rf /'` also triggers", async () => {
    const t = await runTerminal(
      `sh -c 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(t).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("`eval 'rm -rf /'` triggers", async () => {
    const t = await runTerminal(
      `eval 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(t).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("nested `bash -c 'bash -c \"rm -rf /\"'` still triggers via 2-level recursion", async () => {
    const t = await runTerminal(
      `bash -c 'bash -c "rm -rf /"'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(t).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("benign inner script doesn't fire", async () => {
    const t = await runTerminal(
      `bash -c 'echo hi'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(t).toBeNull();
  });

  test("recursion can be disabled via opts", async () => {
    const event = bashEvent(`bash -c 'rm -rf /'`);
    const outcome = await evaluate(
      event,
      [mod(cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"))],
      { recurseInlineShells: false },
    );
    expect(outcome.terminal).toBeNull();
  });

  test("hitting MAX_RECURSE_DEPTH escalates with an inspection-depth reason", async () => {
    // Practical nesting beyond ~3 levels requires extreme quoting gymnastics
    // that exercise the parser, not the depth limit. Drop the cap to 0 so
    // the very first recursion attempt trips the limit branch in isolation.
    __setMaxRecurseDepthForTests(0);
    try {
      const outcome = await evaluate(bashEvent("bash -c 'rm -rf /'"), [
        mod(cmd("rm").deny("never matches")),
      ]);
      expect(outcome.terminal?.kind).toBe("ask");
      expect(outcome.terminal?.kind === "ask" && outcome.terminal.reason).toContain(
        "inspection depth",
      );
    } finally {
      // biome-ignore lint/style/noMagicNumbers: 5 = default MAX_RECURSE_DEPTH restored after the bounded-recursion test.
      __setMaxRecurseDepthForTests(5);
    }
  });

  test("rule from outer command still fires when no inner recursion needed", async () => {
    const t = await runTerminal("bash --version", cmd("bash").deny("no bash"));
    expect(t).toEqual({ kind: "deny", reason: "no bash" });
  });
});
