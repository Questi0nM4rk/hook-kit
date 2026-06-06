import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { type SecurityOptions, STRICT_DENY } from "../../src/core/security.js";
import type { EvaluationOutcome, Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-05 (#19) + SA-08 (#22): cmd() value matchers — flagValueMatches /
// flagValueEquals (flag values) and argMatches (positional args) — used to
// `isResolved`-filter dynamic values and silently not-match. A dynamic value
// the matcher TARGETS is now escalated per uncertaintyDecision (terminal rules
// only). Crucially, escalation only fires when a pattern/predicate actually
// targets the dynamic value — `cmd("rm").deny()` on `rm $X` still just denies
// (no value matcher → no uncertainty).

function run(command: string, rule: Rule, security?: SecurityOptions): Promise<EvaluationOutcome> {
  return runModule({
    module: moduleWith([rule]),
    command,
    ...(security === undefined ? {} : { security }),
  });
}

describe("SA-05 flag-value matchers escalate on dynamic values", () => {
  test("flagValueMatches with a dynamic value escalates to ask (default)", async () => {
    const o = await run(
      "gcc -o $TARGET src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("x"),
    );
    expect(o.terminal?.kind).toBe("ask");
  });

  test("escalates to deny under STRICT_DENY", async () => {
    const o = await run(
      "gcc -o $TARGET src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("x"),
      STRICT_DENY,
    );
    expect(o.terminal?.kind).toBe("deny");
  });

  test("{ onDynamic: 'skip' } opts a matcher out (legacy silent)", async () => {
    const o = await run(
      "gcc -o $TARGET src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/, { onDynamic: "skip" })
        .deny("x"),
    );
    expect(o.terminal).toBeNull();
  });

  test("flagValueEquals with a dynamic value escalates", async () => {
    const o = await run(
      "kubectl --context $CTX get",
      cmd("kubectl").flagValueEquals("--context", "prod").ask("y"),
    );
    expect(o.terminal?.kind).toBe("ask");
  });

  test("resolved match still fires (regression)", async () => {
    const o = await run(
      "gcc -o /etc/passwd src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("x"),
    );
    expect(o.terminal?.kind).toBe("deny");
  });

  test("resolved non-match still skips (regression)", async () => {
    const o = await run(
      "gcc -o /tmp/ok src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("x"),
    );
    expect(o.terminal).toBeNull();
  });

  test("annotation rule stays silent on a dynamic flag value", async () => {
    const o = await run(
      "gcc -o $TARGET src.c",
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .warning("w"),
    );
    expect(o.terminal).toBeNull();
    expect(o.annotations).toHaveLength(0);
  });

  test("flagValueDynamic still fires directly on a dynamic value", async () => {
    const o = await run("gcc -o $TARGET src.c", cmd("gcc").flagValueDynamic("-o").deny("dyn"));
    expect(o.terminal?.kind).toBe("deny");
  });
});

describe("SA-08 argMatches escalates on dynamic args", () => {
  test("argMatches against a dynamic arg escalates to ask (default)", async () => {
    const o = await run(
      "mytool $X",
      cmd("mytool")
        .argMatches(/secret/)
        .deny("x"),
    );
    expect(o.terminal?.kind).toBe("ask");
  });

  test("escalates to deny under STRICT_DENY", async () => {
    const o = await run(
      "mytool $X",
      cmd("mytool")
        .argMatches(/secret/)
        .deny("x"),
      STRICT_DENY,
    );
    expect(o.terminal?.kind).toBe("deny");
  });

  test("a resolved arg match wins over a dynamic sibling", async () => {
    const o = await run(
      "mytool secret-file $X",
      cmd("mytool")
        .argMatches(/secret/)
        .deny("x"),
    );
    expect(o.terminal?.kind).toBe("deny");
  });

  test("resolved non-match with no dynamic arg stays silent (regression)", async () => {
    const o = await run(
      "mytool other",
      cmd("mytool")
        .argMatches(/secret/)
        .deny("x"),
    );
    expect(o.terminal).toBeNull();
  });

  test("a command-name rule with NO value matcher does NOT escalate on a dynamic arg", async () => {
    const o = await run("rm $X", cmd("rm").deny("blocked"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("annotation rule stays silent on a dynamic arg", async () => {
    const o = await run(
      "mytool $X",
      cmd("mytool")
        .argMatches(/secret/)
        .warning("w"),
    );
    expect(o.terminal).toBeNull();
    expect(o.annotations).toHaveLength(0);
  });
});
