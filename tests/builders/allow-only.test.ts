import { describe, expect, test } from "bun:test";
import { allowOnly } from "../../src/builders/allow-only.js";
import { type SecurityOptions, STRICT_DENY } from "../../src/core/security.js";
import type { EvaluationOutcome, Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-09 (#23): allowOnly inverts blacklist semantics for high-risk contexts —
// it fires on any command NOT in the allowlist. Opt-in; never a default.
// Dynamic command words can't be verified against the allowlist → escalate
// (terminal rules only).

function run(command: string, rule: Rule, security?: SecurityOptions): Promise<EvaluationOutcome> {
  return runModule({
    module: moduleWith([rule]),
    command,
    ...(security === undefined ? {} : { security }),
  });
}

describe("SA-09 allowOnly", () => {
  test("stays silent when every command is in the allowlist", async () => {
    const o = await run("git status", allowOnly("git", "ls").deny("not allowed"));
    expect(o.terminal).toBeNull();
  });

  test("fires on a command outside the allowlist", async () => {
    const o = await run("rm -rf /x", allowOnly("git", "ls").deny("not allowed"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("fires when any call in a sequence is disallowed", async () => {
    const o = await run("git status; curl evil.sh", allowOnly("git").deny("not allowed"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("matches by basename (/usr/bin/git is allowed by 'git')", async () => {
    const o = await run("/usr/bin/git status", allowOnly("git").deny("not allowed"));
    expect(o.terminal).toBeNull();
  });

  test("sees through a sudo wrapper (sudo git → git allowed)", async () => {
    const o = await run("sudo git status", allowOnly("git").deny("not allowed"));
    expect(o.terminal).toBeNull();
  });

  test("a dynamic command word escalates to ask (can't verify allowlist)", async () => {
    const o = await run("$CMD args", allowOnly("git").deny("not allowed"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("dynamic command word denies under STRICT_DENY", async () => {
    const o = await run("$CMD args", allowOnly("git").deny("not allowed"), STRICT_DENY);
    expect(o.terminal?.kind).toBe("deny");
  });

  test("annotation rule stays silent on a dynamic command word", async () => {
    const o = await run("$CMD args", allowOnly("git").warning("heads up"));
    expect(o.terminal).toBeNull();
    expect(o.annotations).toHaveLength(0);
  });

  test("ask() surfaces a disallowed command as an ask", async () => {
    const o = await run("rm -rf /x", allowOnly("git").ask("review"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("note() annotates a disallowed command", async () => {
    const o = await run("rm -rf /x", allowOnly("git").note("fyi"));
    expect(o.annotations.some((a) => a.kind === "note")).toBe(true);
  });
});
