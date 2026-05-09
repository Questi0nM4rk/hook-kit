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
    raw: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
  };
}

function nonBashEvent(): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Edit",
    toolInput: { file_path: "/tmp/x" },
    raw: {},
  };
}

function moduleWith(rule: Rule): HookModule {
  return { id: "m", name: "test", events: ["PreToolUse"], rules: [rule] };
}

async function runCmd(command: string, rule: Rule): Promise<Decision> {
  return evaluate(bashEvent(command), [moduleWith(rule)]);
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
    const d = await evaluate(nonBashEvent(), [moduleWith(cmd("rm").deny("blocked"))]);
    expect(d).toBeNull();
  });

  test("does not match on empty Bash command", async () => {
    const d = await runCmd("", cmd("rm").deny("blocked"));
    expect(d).toBeNull();
  });

  test("does not match on a malformed Bash command (parse error)", async () => {
    const d = await runCmd("if; then", cmd("rm").deny("blocked"));
    expect(d).toBeNull();
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

describe("cmd() — quoted strings become <dynamic>", () => {
  test("argMatches does not match content of a quoted body argument", async () => {
    const d = await runCmd(
      'gh pr comment --body "this is secret"',
      cmd("gh", "pr", "comment")
        .argMatches(/secret/)
        .deny("found secret"),
    );
    expect(d).toBeNull();
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

describe("cmd() — terminal forms", () => {
  test("context() returns a context decision", async () => {
    const d = await runCmd("rm foo", cmd("rm").context("informational"));
    expect(d).toEqual({ kind: "context", message: "informational" });
  });

  test("escalate() returns an escalate decision", async () => {
    const d = await runCmd("rm foo", cmd("rm").escalate("ask"));
    expect(d).toEqual({ kind: "escalate", reason: "ask" });
  });

  test("decision label is preserved", async () => {
    const d = await runCmd("rm foo", cmd("rm").deny("blocked", "[security]"));
    expect(d).toEqual({ kind: "deny", reason: "blocked", label: "[security]" });
  });
});
