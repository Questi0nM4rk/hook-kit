// Tests for the requireFlag / requireOneOf DSL sugar added in 0.5.
//
// Both are pure sugar over the existing predicate engine — same flag-presence
// check, different polarity / readability. No engine changes, no new field
// types beyond an OR-group accumulator on the builder.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { runModule } from "../../src/engine/index.js";
import { modOf } from "../_helpers.js";

describe("requireFlag — presence-only form", () => {
  test("fires when the flag is present (alias to withFlag)", async () => {
    const mod = modOf(cmd("git").requireFlag("--no-edit").deny("blocked"));
    const outcome = await runModule({ module: mod, command: "git merge --no-edit branch" });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("does not fire when the flag is absent", async () => {
    const mod = modOf(cmd("git").requireFlag("--no-edit").deny("blocked"));
    const outcome = await runModule({ module: mod, command: "git merge branch" });
    expect(outcome.terminal).toBeNull();
  });

  test("alias expansion still works (`-r` matches `--recursive`)", async () => {
    const mod = modOf(cmd("rm").requireFlag("--recursive").deny("blocked"));
    const outcome = await runModule({ module: mod, command: "rm -r /tmp/x" });
    expect(outcome.terminal?.kind).toBe("deny");
  });
});

describe("requireFlag — value form (--name=value)", () => {
  test("fires when flag is present with matching value (=value syntax)", async () => {
    const mod = modOf(cmd("gh", "api").requireFlag("--method", "POST").deny("write API call"));
    const outcome = await runModule({
      module: mod,
      command: "gh api --method=POST /repos/x/y/issues",
    });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("does not fire when value differs", async () => {
    const mod = modOf(cmd("gh", "api").requireFlag("--method", "POST").deny("write API call"));
    const outcome = await runModule({
      module: mod,
      command: "gh api --method=GET /repos/x/y/issues",
    });
    expect(outcome.terminal).toBeNull();
  });

  test("does not fire when flag is absent entirely", async () => {
    const mod = modOf(cmd("gh", "api").requireFlag("--method", "POST").deny("write API call"));
    const outcome = await runModule({
      module: mod,
      command: "gh api /repos/x/y/issues",
    });
    expect(outcome.terminal).toBeNull();
  });
});

describe("requireOneOf — OR-group semantics", () => {
  test("fires when at least one of the listed flags is present", async () => {
    const mod = modOf(cmd("git", "branch").requireOneOf("-D", "--delete").deny("branch deletion"));
    const outcome = await runModule({ module: mod, command: "git branch -D feature" });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("fires for either flag in the OR group", async () => {
    const mod = modOf(cmd("git", "branch").requireOneOf("-D", "--delete").deny("branch deletion"));
    const outcome = await runModule({ module: mod, command: "git branch --delete feature" });
    expect(outcome.terminal?.kind).toBe("deny");
  });

  test("does not fire when none of the OR-group flags are present", async () => {
    const mod = modOf(cmd("git", "branch").requireOneOf("--repo", "--owner").deny("scoped"));
    const outcome = await runModule({ module: mod, command: "git branch -v" });
    expect(outcome.terminal).toBeNull();
  });

  test("chained requireOneOf calls AND together (each group needs a match)", async () => {
    const mod = modOf(
      cmd("docker", "run")
        .requireOneOf("--rm", "-it")
        .requireOneOf("--name", "--label")
        .deny("compound"),
    );
    // Has --rm (group 1) but no --name/--label (group 2) → does NOT fire
    const noLabel = await runModule({
      module: mod,
      command: "docker run --rm ubuntu echo hi",
    });
    expect(noLabel.terminal).toBeNull();
    // Has both groups satisfied → fires
    const both = await runModule({
      module: mod,
      command: "docker run --rm --name=mybox ubuntu echo hi",
    });
    expect(both.terminal?.kind).toBe("deny");
  });
});

describe("requireFlag / requireOneOf compose with existing builders", () => {
  test("requireFlag + withoutFlag composes (must have X but not Y)", async () => {
    const mod = modOf(
      cmd("git", "push")
        .requireFlag("--force")
        .withoutFlag("--force-with-lease")
        .ask("unsafe force-push"),
    );
    const outcome = await runModule({
      module: mod,
      command: "git push --force origin main",
    });
    expect(outcome.terminal?.kind).toBe("ask");
    // The safe variant should NOT fire
    const safe = await runModule({
      module: mod,
      command: "git push --force-with-lease origin main",
    });
    expect(safe.terminal).toBeNull();
  });
});
