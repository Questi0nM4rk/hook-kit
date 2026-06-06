// BUG-004: test authors can now call evaluateRule(event, rule) directly
// instead of hand-building an EvalContext or boilerplate-wrapping the rule
// in createModule + evaluate.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { custom } from "../../src/builders/custom.js";
import { deny } from "../../src/core/decision.js";
import type { Rule } from "../../src/core/types.js";
import { evaluateRule } from "../../src/engine/index.js";
import { bashEvent, editEvent } from "../_helpers.js";

describe("evaluateRule() — single-rule test helper", () => {
  test("returns the rule's decision when it fires", async () => {
    const d = await evaluateRule(bashEvent("rm -rf /"), cmd("rm").deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("returns null when the rule does not fire", async () => {
    const d = await evaluateRule(bashEvent("ls"), cmd("rm").deny("blocked"));
    expect(d).toBeNull();
  });

  test("works with custom() rules — no need to build EvalContext by hand", async () => {
    const rule: Rule = custom("test", (event) => {
      const cmdInput = event.toolInput.command;
      const command = typeof cmdInput === "string" ? cmdInput : "";
      return command.includes("secret") ? deny("found", "[custom-test]") : null;
    });
    const d = await evaluateRule(bashEvent("echo secret"), rule);
    expect(d).toEqual({ kind: "deny", reason: "found", label: "[custom-test]" });
  });

  test("preserves inline-shell recursion (bash -c '…' triggers cmd() rule)", async () => {
    const d = await evaluateRule(
      bashEvent("bash -c 'rm -rf /'"),
      cmd("rm").withFlag("--recursive").deny("hidden in inline shell"),
    );
    expect(d).toEqual({ kind: "deny", reason: "hidden in inline shell" });
  });

  test("non-Bash event with a cmd() rule returns null (no AST to evaluate)", async () => {
    const d = await evaluateRule(editEvent("/tmp/x"), cmd("rm").deny("blocked"));
    expect(d).toBeNull();
  });
});
