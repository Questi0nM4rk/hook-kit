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

  test("an allowlisted wrapper with a dynamic inner escalates (sudo $cmd, sudo allowed)", async () => {
    // Fail-open guard: the wrapper "sudo" being allowlisted must NOT certify the
    // unverifiable inner `$cmd`. The inner command can't be proven in-allowlist.
    const o = await run("sudo $cmd", allowOnly("sudo", "git").deny("not allowed"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("allowlisted wrapper with a dynamic inner denies under STRICT_DENY", async () => {
    const o = await run("sudo $cmd", allowOnly("sudo", "git").deny("not allowed"), STRICT_DENY);
    expect(o.terminal?.kind).toBe("deny");
  });

  test("wrapper with a dynamic inner where wrapper is NOT allowlisted still denies", async () => {
    const o = await run("sudo $cmd", allowOnly("git").deny("not allowed"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("sudo with an allowlisted concrete inner still runs (sudo git)", async () => {
    const o = await run("sudo git status", allowOnly("sudo", "git").deny("not allowed"));
    expect(o.terminal).toBeNull();
  });

  test("sudo with a non-allowlisted concrete inner still denies (sudo wget)", async () => {
    const o = await run("sudo wget x", allowOnly("sudo", "git").deny("not allowed"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("annotation rule stays silent on an allowlisted wrapper with dynamic inner", async () => {
    const o = await run("sudo $cmd", allowOnly("sudo", "git").warning("heads up"));
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
