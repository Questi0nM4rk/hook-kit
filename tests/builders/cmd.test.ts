import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import type { Annotation, Rule, Terminal } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { editEvent, moduleWith } from "../_helpers.js";

// All rule evaluation flows through `runModule` — the 0.5 test harness. The
// shortcut form (`{ module, command }`) builds the PreToolUse Bash event
// internally so tests don't need to hand-roll `HookEvent` shapes.

const nonBashEvent = () => editEvent("/tmp/x");

async function runCmd(command: string, rule: Rule): Promise<Terminal | null> {
  const outcome = await runModule({ module: moduleWith([rule]), command });
  return outcome.terminal;
}

async function runCmdAnnotations(command: string, rule: Rule): Promise<readonly Annotation[]> {
  const outcome = await runModule({ module: moduleWith([rule]), command });
  return outcome.annotations;
}

describe("cmd() — basic matching", () => {
  test("matches a single command", async () => {
    const d = await runCmd("rm foo", cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("does not match a different command", async () => {
    const d = await runCmd("git push", cmd("rm").deny("blocked"));
    expect(d).toBeNull();
  });

  test("does not run on non-Bash events", async () => {
    const outcome = await runModule({
      module: moduleWith([cmd("rm").deny("blocked")]),
      event: nonBashEvent(),
    });
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });

  test("does not match on empty Bash command", async () => {
    const d = await runCmd("", cmd("rm").deny("blocked"));
    expect(d).toBeNull();
  });

  test("escalates on a malformed Bash command (SA-03 — cannot verify)", async () => {
    // A command shell-ast can't parse can't be certified against the rule;
    // the default profile escalates (onUnparsable: ask) rather than skipping.
    const d = await runCmd("if; then", cmd("rm").deny("blocked"));
    expect(d?.kind).toBe("ask");
  });
});

describe("cmd() — subcommand position", () => {
  test("matches a 1-level subcommand", async () => {
    const d = await runCmd("git push origin main", cmd("git", "push").deny("no push"));
    expect(d).toEqual({ kind: "deny", reason: "no push" });
  });

  test("does not match a different subcommand", async () => {
    const d = await runCmd("git pull", cmd("git", "push").deny("no push"));
    expect(d).toBeNull();
  });

  test("matches a 2-level subcommand", async () => {
    const d = await runCmd(
      "gh pr comment --body x",
      cmd("gh", "pr", "comment").deny("use pr-review"),
    );
    expect(d).toEqual({ kind: "deny", reason: "use pr-review" });
  });

  test("does not match when only the first sub matches", async () => {
    const d = await runCmd("gh pr review", cmd("gh", "pr", "comment").deny("use pr-review"));
    expect(d).toBeNull();
  });

  test("does not match if the command has fewer args than sub levels", async () => {
    const d = await runCmd("gh pr", cmd("gh", "pr", "comment").deny("x"));
    expect(d).toBeNull();
  });
});

describe("cmd() — sudo unwrap", () => {
  test("matches the inner command when wrapped in sudo", async () => {
    const d = await runCmd("sudo rm foo", cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("matches the inner command when sudo carries flags with values", async () => {
    const d = await runCmd("sudo -u root rm foo", cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });
});

describe("cmd() — withFlag / withoutFlag", () => {
  test("withFlag matches when the flag is present", async () => {
    const d = await runCmd(
      "git push --force",
      cmd("git", "push").withFlag("--force").deny("no force"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no force" });
  });

  test("withFlag does not match when the flag is absent", async () => {
    const d = await runCmd(
      "git push origin",
      cmd("git", "push").withFlag("--force").deny("no force"),
    );
    expect(d).toBeNull();
  });

  test("withFlag handles short alias forms (-r matches --recursive)", async () => {
    const d = await runCmd("rm -r foo", cmd("rm").withFlag("--recursive").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("withFlag handles long alias forms (--recursive matches -r)", async () => {
    const d = await runCmd("rm --recursive foo", cmd("rm").withFlag("-r").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("withFlag handles combined short flags (-rf splits into -r + -f)", async () => {
    const d = await runCmd("rm -rf foo", cmd("rm").withFlag("--force").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("withoutFlag matches when the forbidden flag is absent", async () => {
    const d = await runCmd(
      "git push --force",
      cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease").deny("no force"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no force" });
  });

  test("withoutFlag does not match when the forbidden flag is present", async () => {
    const d = await runCmd(
      "git push --force --force-with-lease=main",
      cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease").deny("no force"),
    );
    expect(d).toBeNull();
  });
});

describe("cmd() — argIncludes / argMatches", () => {
  test("argIncludes matches an exact arg", async () => {
    const d = await runCmd(
      "git push origin main",
      cmd("git", "push").argIncludes("origin").deny("blocked"),
    );
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("argIncludes does not match when the value is absent", async () => {
    const d = await runCmd(
      "git push upstream main",
      cmd("git", "push").argIncludes("origin").deny("blocked"),
    );
    expect(d).toBeNull();
  });

  test("argMatches matches a regex pattern in any arg", async () => {
    const d = await runCmd(
      "gh api /repos/foo/bar/pulls/123/reviews",
      cmd("gh", "api")
        .argMatches(/\/pulls\/\d+\/reviews/)
        .deny("use pr-review"),
    );
    expect(d).toEqual({ kind: "deny", reason: "use pr-review" });
  });

  test("argMatches does not match when no arg matches", async () => {
    const d = await runCmd(
      "gh api /users/octocat",
      cmd("gh", "api")
        .argMatches(/\/pulls\/\d+\/reviews/)
        .deny("use pr-review"),
    );
    expect(d).toBeNull();
  });

  test("argMatches matches an unquoted flag value (--field event=COMMENT)", async () => {
    const d = await runCmd(
      "gh api graphql --field event=COMMENT",
      cmd("gh", "api", "graphql")
        .argMatches(/event=COMMENT/)
        .deny("strict"),
    );
    expect(d).toEqual({ kind: "deny", reason: "strict" });
  });
});

describe("cmd() — quoted argument resolution", () => {
  test("argMatches matches content of a simple quoted body argument (shell-ast 0.2+ resolves it as literal)", async () => {
    const d = await runCmd(
      'gh pr comment --body "this is secret"',
      cmd("gh", "pr", "comment")
        .argMatches(/secret/)
        .deny("found secret"),
    );
    expect(d).toEqual({ kind: "deny", reason: "found secret" });
  });
});

describe("cmd() — AST traversal", () => {
  test("matches a call inside command substitution", async () => {
    const d = await runCmd("echo $(rm -r foo)", cmd("rm").withFlag("-r").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("matches a call on the right side of a pipe", async () => {
    const d = await runCmd("cat /etc/passwd | rm", cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("returns the first matching decision when multiple calls are present", async () => {
    const d = await runCmd("echo hello && rm foo", cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });
});

describe("cmd() — withDdash", () => {
  test("matches when `--` separator is present", async () => {
    const d = await runCmd(
      "git checkout -- file.txt",
      cmd("git", "checkout").withDdash().deny("discard"),
    );
    expect(d).toEqual({ kind: "deny", reason: "discard" });
  });

  test("does not match when `--` is absent", async () => {
    const d = await runCmd(
      "git checkout file.txt",
      cmd("git", "checkout").withDdash().deny("discard"),
    );
    expect(d).toBeNull();
  });

  test("does not match when `--` follows a different command", async () => {
    const d = await runCmd(
      "git checkout main && rm -- file",
      cmd("git", "checkout").withDdash().deny("discard"),
    );
    expect(d).toBeNull();
  });

  test("matches even with intervening flags", async () => {
    const d = await runCmd(
      "git restore --staged -- src/x.ts",
      cmd("git", "restore").withDdash().deny("discard"),
    );
    expect(d).toEqual({ kind: "deny", reason: "discard" });
  });
});

describe("cmd() — terminal + annotation forms", () => {
  test("warning() returns a warning annotation (no terminal)", async () => {
    const anns = await runCmdAnnotations("rm foo", cmd("rm").warning("danger"));
    expect(anns).toEqual([{ kind: "warning", message: "danger" }]);
  });

  test("note() returns a note annotation (no terminal)", async () => {
    const anns = await runCmdAnnotations("rm foo", cmd("rm").note("informational"));
    expect(anns).toEqual([{ kind: "note", message: "informational" }]);
  });

  test("warning preserves label", async () => {
    const anns = await runCmdAnnotations("rm foo", cmd("rm").warning("danger", "[security]"));
    expect(anns).toEqual([{ kind: "warning", message: "danger", label: "[security]" }]);
  });

  test("escalate() returns an escalate terminal", async () => {
    const t = await runCmd("rm foo", cmd("rm").ask("ask"));
    expect(t).toEqual({ kind: "ask", reason: "ask" });
  });

  test("deny terminal label is preserved", async () => {
    const t = await runCmd("rm foo", cmd("rm").deny("blocked", "[security]"));
    expect(t).toEqual({ kind: "deny", reason: "blocked", label: "[security]" });
  });
});
