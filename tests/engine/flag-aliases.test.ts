import { describe, expect, test } from "bun:test";
import { expandFlags, hasFlag } from "../../src/engine/helpers.js";

describe("expandFlags (command-scoped, SA-07)", () => {
  test("returns empty array for empty input", () => {
    expect(expandFlags([], "rm")).toEqual([]);
  });

  test("preserves a flag with no aliases", () => {
    expect(expandFlags(["--json"], "rm")).toEqual(["--json"]);
  });

  test("expands -r to its aliases (-R, --recursive) for a listed command", () => {
    const out = expandFlags(["-r"], "rm");
    expect(out).toContain("-r");
    expect(out).toContain("-R");
    expect(out).toContain("--recursive");
  });

  test("expands -R to its aliases (-r, --recursive)", () => {
    const out = expandFlags(["-R"], "rm");
    expect(out).toContain("-r");
    expect(out).toContain("-R");
    expect(out).toContain("--recursive");
  });

  test("expands --recursive to its aliases (-r, -R)", () => {
    const out = expandFlags(["--recursive"], "rm");
    expect(out).toContain("-r");
    expect(out).toContain("-R");
    expect(out).toContain("--recursive");
  });

  test("expands -f to --force and back", () => {
    expect(expandFlags(["-f"], "rm")).toContain("--force");
    expect(expandFlags(["--force"], "rm")).toContain("-f");
  });

  test("does NOT expand aliases for an unlisted command (gcc)", () => {
    // The SA-07 fix: gcc's bundled `-r` (from `-Dmacro`) must stay literal.
    expect(expandFlags(["-r"], "gcc")).toEqual(["-r"]);
    expect(expandFlags(["-f"], "gcc")).toEqual(["-f"]);
  });

  test("merges multiple input flags without duplicates", () => {
    const out = expandFlags(["-r", "--recursive", "-R"], "rm");
    const recursiveCount = out.filter((f) => f === "--recursive").length;
    expect(recursiveCount).toBe(1);
  });

  test("preserves unrelated flags alongside expanded ones", () => {
    const out = expandFlags(["-r", "--json"], "rm");
    expect(out).toContain("-R");
    expect(out).toContain("--json");
  });

  test("does not touch parameterized flag values like --field=x", () => {
    // biome-ignore lint/security/noSecrets: test fixture string for shell-AST flag parsing; not a credential.
    const out = expandFlags(["--field=event=COMMENT"], "gh");
    // biome-ignore lint/security/noSecrets: test fixture string for shell-AST flag parsing; not a credential.
    expect(out).toEqual(["--field=event=COMMENT"]);
  });
});

describe("hasFlag", () => {
  test("matches an exact flag", () => {
    expect(hasFlag(["--force"], "--force")).toBe(true);
  });

  test("returns false when the flag is absent", () => {
    expect(hasFlag(["--json"], "--force")).toBe(false);
  });

  test("matches a parameterized form like --force-with-lease=refspec", () => {
    expect(hasFlag(["--force-with-lease=main"], "--force-with-lease")).toBe(true);
  });

  test("does not match an unrelated parameterized form", () => {
    expect(hasFlag(["--json=full"], "--force")).toBe(false);
  });

  test("requires the caller to pre-expand for alias matching", () => {
    expect(hasFlag(["-r"], "--recursive")).toBe(false);
    expect(hasFlag(expandFlags(["-r"], "rm"), "--recursive")).toBe(true);
  });

  test("returns false on empty input", () => {
    expect(hasFlag([], "--force")).toBe(false);
  });
});
