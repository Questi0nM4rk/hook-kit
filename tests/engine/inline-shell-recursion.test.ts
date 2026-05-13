import { describe, expect, test } from "bun:test";
import type { HookEvent, HookModule, Rule, Terminal } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";

function bashEvent(command: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: {},
  };
}

function moduleWith(rule: Rule): HookModule {
  return { id: "m", name: "test", events: ["PreToolUse"], rules: [rule] };
}

async function runTerminal(command: string, rule: Rule): Promise<Terminal | null> {
  const outcome = await evaluate(bashEvent(command), [moduleWith(rule)]);
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
      [moduleWith(cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"))],
      { recurseInlineShells: false },
    );
    expect(outcome.terminal).toBeNull();
  });

  test("hitting MAX_RECURSE_DEPTH escalates with an inspection-depth reason", async () => {
    // Practical nesting beyond ~3 levels requires extreme quoting gymnastics
    // that exercise the parser, not the depth limit. Drive directly via the
    // internal _depth opt so we test the limit branch in isolation.
    const outcome = await evaluate(
      bashEvent("bash -c 'rm -rf /'"),
      [moduleWith(cmd("rm").deny("never matches"))],
      { _depth: 5 },
    );
    expect(outcome.terminal?.kind).toBe("escalate");
    expect(outcome.terminal?.kind === "escalate" && outcome.terminal.reason).toContain(
      "inspection depth",
    );
  });

  test("rule from outer command still fires when no inner recursion needed", async () => {
    const t = await runTerminal("bash --version", cmd("bash").deny("no bash"));
    expect(t).toEqual({ kind: "deny", reason: "no bash" });
  });
});
