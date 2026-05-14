// Behavior pins for the cmd() rule's dispatch on UnwrappedCall.kind.
// Each kind has a specific policy choice — without these tests, a future
// refactor of `src/rules/command.ts:95` (the dispatch one-liner) could
// silently shift the policy.
//
// Policy (matches shell-ast 0.3 migration guide):
//   plain          → match u.cmd        (e.g. cmd("rm")  fires on `rm`,        cmd("sh") does not)
//   wrapped        → match u.cmd        (sudo-aware: cmd("rm") fires on `sudo rm`)
//   wrapped-script → match u.wrapper    (cmd("bash") fires on `bash -c '…'`)
//   wrapped-opaque → match u.wrapper    (escalator catch: cmd("sudo") fires on `sudo $X`)

import { describe, expect, test } from "bun:test";
import { evaluateRule } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";
import { bashEvent } from "../_helpers.js";

describe("cmd() — kind=plain (no wrapper)", () => {
  test("matches a bare command name", async () => {
    const decision = await evaluateRule(bashEvent("rm /tmp/x"), cmd("rm").deny("plain"), {
      recurseInlineShells: false,
    });
    expect(decision?.kind === "deny" && decision.reason).toBe("plain");
  });

  test("does not match a different command", async () => {
    const decision = await evaluateRule(bashEvent("ls /tmp"), cmd("rm").deny("plain"), {
      recurseInlineShells: false,
    });
    expect(decision).toBeNull();
  });

  test("matches a bare wrapper name (bash without -c stays plain)", async () => {
    // shell-ast 0.3: wrapper-named-but-not-wrapping (bare bash, bash --version)
    // resolves to kind="plain" with cmd populated. Without this pin, a
    // policy drift toward wrapped-* for bare wrappers would silently mute
    // cmd("bash") rules on `bash` and `bash --version`.
    const decision = await evaluateRule(bashEvent("bash --version"), cmd("bash").deny("plain"), {
      recurseInlineShells: false,
    });
    expect(decision?.kind === "deny" && decision.reason).toBe("plain");
  });
});

describe("cmd() — kind=wrapped (sudo-aware, matches inner cmd)", () => {
  test("matches the inner command through sudo", async () => {
    // The canonical sudo-aware case: cmd("rm") fires on `sudo rm /tmp/x`
    // because the wrapped branch dispatches on u.cmd (inner) not u.wrapper.
    const decision = await evaluateRule(bashEvent("sudo rm /tmp/x"), cmd("rm").deny("wrapped"), {
      recurseInlineShells: false,
    });
    expect(decision?.kind === "deny" && decision.reason).toBe("wrapped");
  });

  test("matches inner cmd when wrapper carries its own flags", async () => {
    const decision = await evaluateRule(
      bashEvent("sudo --user root rm /tmp/x"),
      cmd("rm").deny("wrapped-with-flags"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("wrapped-with-flags");
  });

  test("does NOT match the wrapper when an inner cmd was resolved", async () => {
    // cmd("sudo") on `sudo rm` is intentionally a non-match — the wrapped
    // branch reports u.cmd ("rm"), not u.wrapper ("sudo"). This keeps
    // sudo-rules tight (they fire only on dynamic/opaque sudo invocations
    // via the wrapped-opaque branch — see escalator-catch test below).
    const decision = await evaluateRule(bashEvent("sudo rm /tmp/x"), cmd("sudo").deny("wrong"), {
      recurseInlineShells: false,
    });
    expect(decision).toBeNull();
  });

  test("inner-cmd flag predicates apply to the wrapped inner command", async () => {
    // `sudo rm -rf /tmp/x` — u.flags should be the inner rm's flags, not sudo's.
    const decision = await evaluateRule(
      bashEvent("sudo rm -rf /tmp/x"),
      cmd("rm").withFlag("--recursive").withFlag("--force").deny("wrapped-flags"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("wrapped-flags");
  });
});

describe("cmd() — kind=wrapped-script (the v0.2-leak fix)", () => {
  test("cmd(wrapper) fires on `<wrapper> -c '...'`", async () => {
    // BEHAVIOR PIN: this fires in v0.3 and DIDN'T in v0.2 (where unwrapCall
    // returned {wrapper:"bash", cmd:null}, killing the match). The dispatch
    // dispatches wrapped-script to u.wrapper, so cmd("bash") fires on
    // `bash -c '…'`. Don't silently regress this — operators expect a
    // cmd("bash") rule to fire on bash invocations, regardless of -c.
    //
    // Note: engine inline-shell recursion is ON by default and would ALSO
    // re-evaluate the inner script. We disable it here (recurseInlineShells:
    // false) to assert the OUTER call's dispatch in isolation.
    const decision = await evaluateRule(
      bashEvent("bash -c 'echo ok'"),
      cmd("bash").deny("wrapped-script"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("wrapped-script");
  });

  test("cmd(wrapper) fires on `eval '...'`", async () => {
    const decision = await evaluateRule(
      bashEvent("eval 'echo ok'"),
      cmd("eval").deny("wrapped-script-eval"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("wrapped-script-eval");
  });

  test("cmd(non-wrapper) does NOT match a wrapped-script wrapper", async () => {
    // cmd("ls") must not fire on `bash -c 'echo ok'` — the wrapped-script's
    // u.wrapper is "bash", not "ls".
    const decision = await evaluateRule(bashEvent("bash -c 'echo ok'"), cmd("ls").deny("wrong"), {
      recurseInlineShells: false,
    });
    expect(decision).toBeNull();
  });
});

describe("cmd() — kind=wrapped-opaque (escalator catch)", () => {
  test("cmd(wrapper) fires when the inner command is dynamic", async () => {
    // ESCALATOR CATCH: `sudo $X` is wrapped-opaque (wrapper detected, inner
    // unresolvable). The dispatch reports u.wrapper, so cmd("sudo") fires.
    // Security-relevant: an attacker can hide intent behind shell expansion
    // (`sudo $CMD_VAR`) — the wrapper-name rule still triggers escalation.
    const decision = await evaluateRule(
      bashEvent("sudo $DYNCMD /tmp/x"),
      cmd("sudo").ask("wrapped-opaque"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "ask" && decision.reason).toBe("wrapped-opaque");
  });

  test("cmd(wrapper) fires when bash -c carries a dynamic script", async () => {
    // `bash -c "$SCRIPT"` is also wrapped-opaque/wrapped-script depending on
    // shell-ast's inner-string resolution. Either way, cmd("bash") must fire
    // on the wrapper name to catch the dynamic-script escalation.
    const decision = await evaluateRule(
      bashEvent('bash -c "$SCRIPT"'),
      cmd("bash").ask("wrapped-opaque-bash"),
      { recurseInlineShells: false },
    );
    expect(decision?.kind === "ask" && decision.reason).toBe("wrapped-opaque-bash");
  });
});

describe("cmd() — inline-shell recursion (the security half of the wrapped-script story)", () => {
  test("cmd(inner) fires on the inner command of `bash -c '<inner>'` via recursion", async () => {
    // Even though cmd("rm") doesn't match the OUTER `bash -c '…'` call
    // (wrapped-script dispatch reports u.wrapper="bash", not "rm"), the
    // engine's recursion re-evaluates the inner script and the inner `rm`
    // is then matched as kind=plain. This is the canonical hiding-place
    // bypass; the rule must still fire.
    const decision = await evaluateRule(
      bashEvent("bash -c 'rm -rf /tmp/x'"),
      cmd("rm").deny("recursion"),
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("recursion");
  });

  test("cmd(inner) fires on the inner command of `eval '<inner>'` via recursion", async () => {
    const decision = await evaluateRule(
      bashEvent("eval 'rm -rf /tmp/x'"),
      cmd("rm").deny("recursion-eval"),
    );
    expect(decision?.kind === "deny" && decision.reason).toBe("recursion-eval");
  });
});
