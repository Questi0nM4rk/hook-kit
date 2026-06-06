import { describe, expect, test } from "bun:test";
import { redirect } from "../../src/builders/redirect.js";
import { STRICT_DENY } from "../../src/core/security.js";
import type { HookEvent, HookModule, Rule, Terminal } from "../../src/core/types.js";
import { evaluate, runModule } from "../../src/engine/index.js";

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
    const d = await run("echo x > .env", redirect(/\.env$/).ask("review"));
    expect(d).toEqual({ kind: "ask", reason: "review" });
  });
});

// SA (#14): a redirect() security rule targets a path PATTERN, but the redirect
// target word is dynamic (`> $TARGET`, `> $(mktemp)`). wordToLit() returns null,
// so the rule used to silently skip — a fail-open bypass of every redirect deny.
// It now escalates per SecurityOptions.uncertaintyDecision for terminal rules.
// Annotation (warning/note) rules stay silent: escalating them inverts severity.
describe("redirect() dynamic-target escalation", () => {
  const denyEtc = () => moduleWith(redirect(/^\/etc\//).deny("system path"));

  test("escalates a terminal rule to ask under the default profile", async () => {
    const out = await runModule({ module: denyEtc(), command: "echo evil > $TARGET" });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("escalates a terminal rule to deny under STRICT_DENY", async () => {
    const out = await runModule({
      module: denyEtc(),
      command: "echo evil > $TARGET",
      security: STRICT_DENY,
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("stays silent when uncertaintyDecision is 'allow' (legacy fail-open)", async () => {
    const out = await runModule({
      module: denyEtc(),
      command: "echo evil > $TARGET",
      security: { ...STRICT_DENY, uncertaintyDecision: "allow" },
    });
    expect(out.terminal).toBeNull();
  });

  test("does NOT escalate an annotation (note) rule on a dynamic target", async () => {
    const out = await runModule({
      module: moduleWith(redirect(/^\/etc\//).note("heads up")),
      command: "echo evil > $TARGET",
    });
    expect(out.terminal).toBeNull();
    expect(out.annotations).toHaveLength(0);
  });

  test("still denies a resolved matching target (regression guard)", async () => {
    const out = await runModule({
      module: denyEtc(),
      command: "echo evil > /etc/passwd",
      security: STRICT_DENY,
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("does NOT escalate on a resolved, non-matching target", async () => {
    const out = await runModule({
      module: denyEtc(),
      command: "echo hi > /tmp/log",
      security: STRICT_DENY,
    });
    expect(out.terminal).toBeNull();
  });

  test("undefined pattern (match-any) is unaffected by the dynamic path", async () => {
    const out = await runModule({
      module: moduleWith(redirect().deny("any redirect")),
      command: "echo evil > $TARGET",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("carries the rule's label onto the escalation", async () => {
    const out = await runModule({
      module: moduleWith(redirect(/^\/etc\//).deny("system path", "[guard]")),
      command: "echo evil > $TARGET",
    });
    expect(out.terminal?.label).toBe("[guard]");
  });
});
