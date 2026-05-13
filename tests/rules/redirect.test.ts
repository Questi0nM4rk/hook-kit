import { describe, expect, test } from "bun:test";
import type { HookEvent, HookModule, Rule, Terminal } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { redirect } from "../../src/rules/redirect.js";

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

async function run(command: string, rule: Rule): Promise<Terminal | null> {
  const outcome = await evaluate(bashEvent(command), [moduleWith(rule)]);
  return outcome.terminal;
}

describe("redirect()", () => {
  test("matches `cmd > /protected`", async () => {
    const d = await run("echo evil > /etc/passwd", redirect(/^\/etc\/passwd$/).deny("system file"));
    expect(d).toEqual({ kind: "deny", reason: "system file" });
  });

  test("matches `cmd >> /protected` (append)", async () => {
    const d = await run("echo x >> /etc/hosts", redirect(/^\/etc\/hosts$/).deny("hosts"));
    expect(d).toEqual({ kind: "deny", reason: "hosts" });
  });

  test("matches `cmd >| /protected` (clobber)", async () => {
    const d = await run("echo x >| .env", redirect(/\.env$/).deny("env"));
    expect(d).toEqual({ kind: "deny", reason: "env" });
  });

  test("matches `&>` (combined stderr+stdout)", async () => {
    const d = await run("cmd &> .env", redirect(/\.env$/).deny("env"));
    expect(d).toEqual({ kind: "deny", reason: "env" });
  });

  test("does not match read redirects", async () => {
    const d = await run("cat < .env", redirect(/\.env$/).deny("env"));
    expect(d).toBeNull();
  });

  test("does not match unrelated targets", async () => {
    const d = await run("echo hi > /tmp/log", redirect(/^\/etc\//).deny("etc"));
    expect(d).toBeNull();
  });

  test("undefined pattern matches any write redirect", async () => {
    const d = await run("echo hi > /tmp/log", redirect().deny("any redirect"));
    expect(d).toEqual({ kind: "deny", reason: "any redirect" });
  });

  test("escalate() form returns escalate decision", async () => {
    const d = await run("echo x > .env", redirect(/\.env$/).escalate("review"));
    expect(d).toEqual({ kind: "escalate", reason: "review" });
  });
});
