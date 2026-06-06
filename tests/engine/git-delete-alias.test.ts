import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { expandFlags } from "../../src/engine/helpers.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// BUG 7 (SA-07 regression): the alias rework dropped git's `-D → --delete
// --force` (and `-d → --delete`) expansion. The SHIPPED example rule
// `cmd("git","branch").withFlag("--delete").withFlag("--force")` no longer
// fires on `git branch -D feature` (it ran instead of asking). Restore the
// git-scoped short-flag mappings ONLY (do not re-introduce broad cross-command
// aliases — SA-07 scoped them away to kill false positives).

const branchRule = () =>
  moduleWith([cmd("git", "branch").withFlag("--delete").withFlag("--force").ask("git branch -D")]);

describe("BUG 7 — git -D / -d alias expansion", () => {
  test("-D expands to BOTH --delete and --force", () => {
    const out = expandFlags(["-D"], "git");
    expect(out).toContain("--delete");
    expect(out).toContain("--force");
  });

  test("-d expands to --delete", () => {
    expect(expandFlags(["-d"], "git")).toContain("--delete");
  });

  test("git branch -D feature → ask (shipped-rule regression)", async () => {
    const out = await runModule({ module: branchRule(), command: "git branch -D feature" });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("git branch --delete --force feature → ask", async () => {
    const out = await runModule({
      module: branchRule(),
      command: "git branch --delete --force feature",
    });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("does NOT re-introduce a global -D alias (gcc stays literal)", () => {
    expect(expandFlags(["-D"], "gcc")).toEqual(["-D"]);
  });
});
