// Tests for the runModule test harness export — the module-level evaluator
// for writing tests without hand-building bash matrices or HookEvent fixtures.
//
// See src/engine/index.ts § runModule for the API. Replaces the bash-matrix
// style that previously had to compile a binary, exec it, and grep stdout.

import { describe, expect, test } from "bun:test";
import { createModule } from "../../src/core/module.js";
import { runModule } from "../../src/engine/index.js";
import { cmd } from "../../src/rules/command.js";
import { content } from "../../src/rules/content.js";

describe("runModule — test harness", () => {
  test("command shortcut: builds a PreToolUse Bash event from a string", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("rm").withFlag("-r").withFlag("-f").deny("blocked"),
    ]);
    const outcome = await runModule({ module: mod, command: "rm -rf /tmp/x" });
    expect(outcome.terminal?.kind).toBe("deny");
    expect((outcome.terminal as { reason: string }).reason).toBe("blocked");
  });

  test("returns full outcome, including warning/note annotations", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("git", "push").withFlag("--force").warning("force-push? double check"),
    ]);
    const outcome = await runModule({ module: mod, command: "git push --force" });
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations.filter((a) => a.kind === "warning")).toHaveLength(1);
  });

  test("accepts an array of modules for multi-module integration tests", async () => {
    const mod1 = createModule({ id: "a", name: "a", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("git", "push").note("module-a fired"),
    ]);
    const mod2 = createModule({ id: "b", name: "b", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("git", "push").warning("module-b fired"),
    ]);
    const outcome = await runModule({ module: [mod1, mod2], command: "git push" });
    expect(outcome.annotations).toHaveLength(2);
  });

  test("event override: full HookEvent for non-Bash testing", async () => {
    // PostToolUse + Write event, content() rule reads the file body. Tests
    // that runModule passes through the event verbatim without forcing Bash.
    const mod = createModule({ id: "x", name: "x", events: ["PostToolUse"], matchers: ["Write"] }, [
      content()
        .matchPath(/\.env$/)
        .validate((_path, body) =>
          body.includes("SECRET") ? { kind: "deny", reason: "leaked secret" } : null,
        ),
    ]);
    // No file on disk → content() returns null because the rule checks
    // existsSync first. We're just verifying the event flows through.
    const outcome = await runModule({
      module: mod,
      event: {
        eventName: "PostToolUse",
        sessionId: "s",
        cwd: "/tmp",
        transcriptPath: "",
        toolName: "Write",
        toolInput: { file_path: "/nonexistent/.env" },
        raw: {},
      },
    });
    expect(outcome.terminal).toBeNull();
  });

  test("error annotations surface in outcome.annotations (0.5 contract)", async () => {
    // A rule that throws a non-HookKitError gets wrapped as RuleEvaluationError.
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      {
        kind: "thrower",
        evaluate: () => {
          throw new TypeError("rule bug");
        },
      },
    ]);
    const outcome = await runModule({ module: mod, command: "echo hi" });
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (err?.kind !== "error") throw new Error("expected error annotation");
    expect(err.errorCode).toBe("RuleEvaluationError");
    expect(err.message).toContain("rule bug");
    // No terminal because the rule didn't reach its decision branch.
    expect(outcome.terminal).toBeNull();
  });

  test("deny preserves error annotations, drops warning/note", async () => {
    // One rule throws (error annotation), a different rule denies. Per merge
    // policy: deny drops warning/note but error annotations survive.
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      // Rule 1: a warning before the throw + deny.
      cmd("rm").note("about to be denied"),
      // Rule 2: throws.
      {
        kind: "thrower",
        evaluate: () => {
          throw new Error("infra bug");
        },
      },
      // Rule 3: deny terminates the run.
      cmd("rm").deny("rm blocked"),
    ]);
    const outcome = await runModule({ module: mod, command: "rm /tmp/x" });
    expect(outcome.terminal?.kind).toBe("deny");
    // warning/note dropped, error survives.
    expect(outcome.annotations.filter((a) => a.kind === "note")).toHaveLength(0);
    expect(outcome.annotations.filter((a) => a.kind === "error")).toHaveLength(1);
  });

  test("no input given: empty bash command, engine returns empty outcome", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      cmd("rm").deny("blocked"),
    ]);
    const outcome = await runModule({ module: mod });
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });
});
