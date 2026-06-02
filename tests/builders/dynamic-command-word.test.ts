import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-01 (#15): a cmd() security rule targets a command NAME, but the command
// word is dynamic ($CMD, $(which rm)). resolvedCmd() is undefined, so the rule
// used to silently skip — a one-token bypass of every cmd() deny. It now
// escalates per SecurityOptions.uncertaintyDecision. Annotation (warning/note)
// rules stay silent: escalating an informational annotation to ask/deny would
// invert severity and spam unrelated rules on every dynamic invocation.

const denyRm = () => moduleWith([cmd("rm").deny("rm blocked")]);

describe("SA-01 dynamic command word", () => {
  test("escalates a terminal rule to ask under the default profile", async () => {
    const out = await runModule({ module: denyRm(), command: "$CMD -rf /tmp/x" });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("escalates a terminal rule to deny under STRICT_DENY", async () => {
    const out = await runModule({
      module: denyRm(),
      command: "$CMD -rf /tmp/x",
      security: STRICT_DENY,
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("stays silent when uncertaintyDecision is 'allow' (legacy fail-open)", async () => {
    const out = await runModule({
      module: denyRm(),
      command: "$CMD -rf /tmp/x",
      security: { ...STRICT_BUT_ASKS, uncertaintyDecision: "allow" },
    });
    expect(out.terminal).toBeNull();
  });

  test("does NOT escalate an annotation (note) rule on a dynamic word", async () => {
    const out = await runModule({
      module: moduleWith([cmd("rm").note("heads up")]),
      command: "$CMD -rf /tmp/x",
    });
    expect(out.terminal).toBeNull();
    expect(out.annotations).toHaveLength(0);
  });

  test("does NOT escalate on a resolved, non-matching command", async () => {
    const out = await runModule({ module: denyRm(), command: "git status" });
    expect(out.terminal).toBeNull();
  });

  test("still denies a resolved matching command (regression guard)", async () => {
    const out = await runModule({ module: denyRm(), command: "rm -rf /tmp/x" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("carries the rule's label onto the escalation", async () => {
    const out = await runModule({
      module: moduleWith([cmd("rm").deny("rm blocked", "[guard]")]),
      command: "$CMD -rf /tmp/x",
    });
    expect(out.terminal?.label).toBe("[guard]");
  });
});
