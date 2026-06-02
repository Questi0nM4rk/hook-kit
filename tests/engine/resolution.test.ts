import { describe, expect, test } from "bun:test";
import { DYNAMIC } from "@questi0nm4rk/shell-ast";
import { resolutionOf } from "../../src/engine/resolution.js";

// resolutionOf classifies a shell-ast ResolvedArg (string | DYNAMIC) into the
// three-state vocabulary every matcher consults. The DYNAMIC sentinel carries
// no source text, so the bare-arg path fills the shell-ast "<dynamic>"
// placeholder; the `unparsable` state is constructed by callers that hold no
// AST, not produced here.

describe("resolutionOf", () => {
  test("classifies a literal string arg as resolved, carrying its value", () => {
    expect(resolutionOf("/etc/passwd")).toEqual({
      state: "resolved",
      value: "/etc/passwd",
    });
  });

  test("classifies the DYNAMIC sentinel as dynamic", () => {
    expect(resolutionOf(DYNAMIC)).toEqual({
      state: "dynamic",
      sourceText: "<dynamic>",
    });
  });
});
