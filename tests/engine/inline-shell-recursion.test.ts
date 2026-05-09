import { describe, expect, test } from "bun:test";
import type { Decision, HookEvent, HookModule, Rule } from "../../src/core/types.js";
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

async function run(command: string, rule: Rule): Promise<Decision> {
  return evaluate(bashEvent(command), [moduleWith(rule)]);
}

describe("inline-shell recursion", () => {
  test("`bash -c 'rm -rf /'` triggers a cmd('rm') rule via recursion", async () => {
    const d = await run(
      `bash -c 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("`sh -c 'rm -rf /'` also triggers", async () => {
    const d = await run(
      `sh -c 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("`eval 'rm -rf /'` triggers", async () => {
    const d = await run(
      `eval 'rm -rf /'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("nested `bash -c 'bash -c \"rm -rf /\"'` still triggers via 2-level recursion", async () => {
    const d = await run(
      `bash -c 'bash -c "rm -rf /"'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no rm -rf" });
  });

  test("benign inner script doesn't fire", async () => {
    const d = await run(
      `bash -c 'echo hi'`,
      cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"),
    );
    expect(d).toBeNull();
  });

  test("recursion can be disabled via opts", async () => {
    const event = bashEvent(`bash -c 'rm -rf /'`);
    const d = await evaluate(
      event,
      [moduleWith(cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf"))],
      { recurseInlineShells: false },
    );
    expect(d).toBeNull();
  });

  test("hitting MAX_RECURSE_DEPTH escalates with an inspection-depth reason", async () => {
    // Practical nesting beyond ~3 levels requires extreme quoting gymnastics
    // that exercise the parser, not the depth limit. Drive directly via the
    // internal _depth opt so we test the limit branch in isolation.
    const d = await evaluate(
      bashEvent("bash -c 'rm -rf /'"),
      [moduleWith(cmd("rm").deny("never matches"))],
      { _depth: 5 },
    );
    expect(d?.kind).toBe("escalate");
    expect((d as { reason: string }).reason).toContain("inspection depth");
  });

  test("rule from outer command still fires when no inner recursion needed", async () => {
    const d = await run("bash --version", cmd("bash").deny("no bash"));
    expect(d).toEqual({ kind: "deny", reason: "no bash" });
  });
});
