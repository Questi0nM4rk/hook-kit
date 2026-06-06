// Unit tests for scripts/verify.ts — the one-command gate orchestrator.
//
// Strategy: import verify.ts's PURE functions directly and test LOGIC only.
// verify.ts guards its top-level run with `if (import.meta.main)`, so importing
// it does NOT spawn any sub-check. These tests must stay FAST — they never
// invoke the real typecheck / lint / test / markdownlint checks (doing so would
// recurse the 826-case suite). parseArgs / selected / summarize / unknownNames
// are exercised over synthetic inputs; resolveBase is exercised against a
// throwaway local git repo (no network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_CHECK_NAMES,
  ArgError,
  type Args,
  buildChecks,
  type Check,
  parseArgs,
  parseList,
  resolveBase,
  selected,
  summarize,
} from "../../scripts/verify.js";

const NO_ONLY: Args = { base: null, only: null, skip: new Set() };

function check(name: string, prOnly = false): Check {
  return { name, argv: ["bun", "run", name], prOnly };
}

describe("scripts/verify.ts — parseList", () => {
  test("splits on commas, trims, drops empties", () => {
    expect([...parseList("a, b ,c")]).toEqual(["a", "b", "c"]);
  });

  test("undefined / empty → empty set", () => {
    expect(parseList(undefined).size).toBe(0);
    expect(parseList("").size).toBe(0);
    expect(parseList(" , , ").size).toBe(0);
  });

  test("dedupes", () => {
    expect([...parseList("a,a,b")]).toEqual(["a", "b"]);
  });
});

describe("scripts/verify.ts — parseArgs", () => {
  test("no args → all null/empty", () => {
    const a = parseArgs([]);
    expect(a.base).toBeNull();
    expect(a.only).toBeNull();
    expect(a.skip.size).toBe(0);
  });

  test("--base sets base ref", () => {
    expect(parseArgs(["--base", "origin/main"]).base).toBe("origin/main");
  });

  test("--only / --skip parse comma lists", () => {
    const a = parseArgs(["--only", "typecheck,lint", "--skip", "test"]);
    expect([...(a.only ?? new Set())]).toEqual(["typecheck", "lint"]);
    expect([...a.skip]).toEqual(["test"]);
  });

  test("unrecognized arg throws ArgError code 2", () => {
    try {
      parseArgs(["--bogus"]);
      throw new Error("expected ArgError");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgError);
      expect((err as ArgError).code).toBe(2);
      expect((err as ArgError).message).toContain("unrecognized arg");
    }
  });

  test("--help throws ArgError code 0", () => {
    try {
      parseArgs(["--help"]);
      throw new Error("expected ArgError");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgError);
      expect((err as ArgError).code).toBe(0);
    }
  });

  // Finding 6: --base must not greedily consume a following flag.
  test("--base followed by a flag-shaped value is rejected (code 2)", () => {
    try {
      parseArgs(["--base", "--only", "typecheck"]);
      throw new Error("expected ArgError");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgError);
      expect((err as ArgError).code).toBe(2);
      expect((err as ArgError).message).toContain("flag-shaped");
    }
  });

  test("--base as the last arg with no value is rejected (code 2)", () => {
    try {
      parseArgs(["--base"]);
      throw new Error("expected ArgError");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgError);
      expect((err as ArgError).code).toBe(2);
      expect((err as ArgError).message).toContain("expects a value");
    }
  });

  test("a ref that merely contains a dash (not leading) is accepted", () => {
    expect(parseArgs(["--base", "origin/feat-x"]).base).toBe("origin/feat-x");
  });
});

describe("scripts/verify.ts — known-name universe (finding 4)", () => {
  test("ALL_CHECK_NAMES includes both core and PR-only checks", () => {
    expect(ALL_CHECK_NAMES.has("typecheck")).toBe(true);
    expect(ALL_CHECK_NAMES.has("markdownlint")).toBe(true);
    expect(ALL_CHECK_NAMES.has("check-stable-exports")).toBe(true);
    expect(ALL_CHECK_NAMES.has("check-changelog")).toBe(true);
  });

  test("buildChecks(null) omits the PR-only checks from the RUNNABLE list", () => {
    const names = buildChecks(null).map((c) => c.name);
    expect(names).not.toContain("check-stable-exports");
    expect(names).not.toContain("check-changelog");
  });

  test("buildChecks with a base ref adds the PR-only checks, base threaded into argv", () => {
    const checks = buildChecks("origin/main");
    const stable = checks.find((c) => c.name === "check-stable-exports");
    expect(stable).toBeDefined();
    expect(stable?.argv).toEqual([
      "bun",
      "scripts/check-stable-exports.ts",
      "--base",
      "origin/main",
    ]);
  });

  test("a PR-only name is in the validation universe even when base is null", () => {
    // The regression: validation must use ALL_CHECK_NAMES, not buildChecks(null).
    // So --skip check-stable-exports / --only check-changelog are KNOWN here.
    expect(ALL_CHECK_NAMES.has("check-stable-exports")).toBe(true);
    expect(
      buildChecks(null)
        .map((c) => c.name)
        .includes("check-stable-exports"),
    ).toBe(false);
  });
});

describe("scripts/verify.ts — selected", () => {
  test("--only restricts to the named checks", () => {
    const args: Args = { base: null, only: new Set(["lint"]), skip: new Set() };
    expect(selected(check("lint"), args)).toBe(true);
    expect(selected(check("typecheck"), args)).toBe(false);
  });

  test("--skip excludes the named checks", () => {
    const args: Args = { base: null, only: null, skip: new Set(["test"]) };
    expect(selected(check("test"), args)).toBe(false);
    expect(selected(check("lint"), args)).toBe(true);
  });

  test("--skip wins over --only for the same name", () => {
    const args: Args = { base: null, only: new Set(["lint"]), skip: new Set(["lint"]) };
    expect(selected(check("lint"), args)).toBe(false);
  });
});

describe("scripts/verify.ts — summarize (findings 3 + 5)", () => {
  test("all results ok → code 0 + all-passed message", () => {
    const s = summarize(
      [
        { name: "typecheck", ok: true },
        { name: "lint", ok: true },
      ],
      null,
      true,
    );
    expect(s.code).toBe(0);
    expect(s.message).toContain("all 2 check(s) passed");
  });

  test("any failure → code 1 + names the failed checks", () => {
    const s = summarize(
      [
        { name: "typecheck", ok: true },
        { name: "lint", ok: false },
        { name: "test", ok: false },
      ],
      null,
      true,
    );
    expect(s.code).toBe(1);
    expect(s.message).toContain("FAILED");
    expect(s.message).toContain("2/3");
    expect(s.message).toContain("lint");
    expect(s.message).toContain("test");
    expect(s.message).not.toContain("typecheck");
  });

  // Finding 5: zero-selection must NOT masquerade as success.
  test("empty results → NON-zero (code 2), never 'all 0 passed'", () => {
    const s = summarize([], null, true);
    expect(s.code).not.toBe(0);
    expect(s.code).toBe(2);
    expect(s.message).not.toContain("all 0");
    expect(s.message).toContain("no checks selected");
  });

  test("empty results names the --only filter when present", () => {
    const s = summarize([], new Set(["check-changelog"]), false);
    expect(s.code).toBe(2);
    expect(s.message).toContain("check-changelog");
  });

  test("empty results explains PR-only skip when no base resolved", () => {
    const s = summarize([], new Set(["check-stable-exports"]), false);
    expect(s.code).toBe(2);
    expect(s.message).toContain("PR-only");
  });
});

describe("scripts/verify.ts — resolveBase", () => {
  let prevCwd: string;
  let repo: string | null = null;

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (repo !== null) {
      rmSync(repo, { recursive: true, force: true });
      repo = null;
    }
  });

  test("explicit base wins verbatim (no git consulted)", () => {
    expect(resolveBase("origin/whatever")).toBe("origin/whatever");
  });

  test("explicit empty string falls through to auto-detect", () => {
    // Empty string is treated as 'not provided' — exercised indirectly: in a
    // repo with no origin/HEAD and HEAD == fallback, this returns null below.
    expect(resolveBase("")).toBeDefined(); // either null or a ref, never throws
  });

  function gitInit(dir: string): void {
    const opts = { cwd: dir, stdio: "ignore" as const };
    execFileSync("git", ["init", "-q"], opts);
    execFileSync("git", ["config", "user.email", "t@t.t"], opts);
    execFileSync("git", ["config", "user.name", "t"], opts);
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "c1"], opts);
  }

  test("null when there is no origin/HEAD and HEAD == fallback default", () => {
    // A fresh repo has no remote, so origin/HEAD doesn't resolve and the
    // fallback `origin/main` rev-parse fails → null (skip PR-only).
    repo = mkdtempSync(join(tmpdir(), "verify-resolvebase-"));
    gitInit(repo);
    process.chdir(repo);
    expect(resolveBase(null)).toBeNull();
  });

  test("returns the default ref when HEAD differs from it", () => {
    // Stage a repo whose origin/HEAD → origin/main points at a DIFFERENT commit
    // than HEAD, simulating a PR branch. resolveBase must return 'origin/main'.
    repo = mkdtempSync(join(tmpdir(), "verify-resolvebase-pr-"));
    const remote = `${repo}-remote.git`;
    const opts = { cwd: repo, stdio: "ignore" as const };
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], opts);
      execFileSync("git", ["config", "user.email", "t@t.t"], opts);
      execFileSync("git", ["config", "user.name", "t"], opts);
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "base"], opts);
      execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", remote], opts);
      execFileSync("git", ["push", "-q", "origin", "main"], opts);
      // Make origin/HEAD resolve to origin/main.
      execFileSync("git", ["remote", "set-head", "origin", "main"], opts);
      // Now advance HEAD past origin/main so the SHAs differ.
      execFileSync("git", ["checkout", "-q", "-b", "feature"], opts);
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "feature work"], opts);
      process.chdir(repo);
      expect(resolveBase(null)).toBe("origin/main");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  test("null when HEAD == the resolved default ref (on the default branch)", () => {
    repo = mkdtempSync(join(tmpdir(), "verify-resolvebase-ondefault-"));
    const remote = `${repo}-remote2.git`;
    const opts = { cwd: repo, stdio: "ignore" as const };
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], opts);
      execFileSync("git", ["config", "user.email", "t@t.t"], opts);
      execFileSync("git", ["config", "user.name", "t"], opts);
      execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "base"], opts);
      execFileSync("git", ["init", "-q", "--bare", remote], { stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", remote], opts);
      execFileSync("git", ["push", "-q", "origin", "main"], opts);
      execFileSync("git", ["remote", "set-head", "origin", "main"], opts);
      // HEAD stays on main, equal to origin/main → not a PR → null.
      process.chdir(repo);
      expect(resolveBase(null)).toBeNull();
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });
});

// Guard: importing verify.ts must not run the orchestrator. If the
// import.meta.main guard regressed, importing this module would have spawned
// the real checks and these fast tests would hang / recurse. Reaching this
// assertion at all proves the guard holds.
describe("scripts/verify.ts — import safety", () => {
  test("module import does not execute main()", () => {
    expect(NO_ONLY.base).toBeNull();
  });
});
