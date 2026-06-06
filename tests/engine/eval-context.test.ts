import { describe, expect, test } from "bun:test";
import type { Rule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { bashEvent, moduleWith, writeEvent } from "../_helpers.js";

// `nonBashEvent` keeps a `Write`-tool, file-path event for the
// non-Bash-AST-skip cases; the SDK `writeEvent` produces exactly that shape.
const nonBashEvent = () => writeEvent("/tmp/f.txt");

/** Helper rule that captures whatever the engine passed it. */
function spyRule(callback: (ast: unknown) => void): Rule {
  return {
    kind: "spy",
    async evaluate(_event, ctx) {
      callback(await ctx.getBashAst());
      return null;
    },
  };
}

describe("EvalContext.getBashAst", () => {
  test("returns a parsed AST for a Bash event", async () => {
    let captured: unknown = "untouched";
    await evaluate(bashEvent("echo hello"), [moduleWith([spyRule((ast) => (captured = ast))])]);
    expect(captured).not.toBeNull();
    expect((captured as { type: string }).type).toBe("File");
  });

  test("returns null for non-Bash events", async () => {
    let captured: unknown = "untouched";
    await evaluate(nonBashEvent(), [moduleWith([spyRule((ast) => (captured = ast))])]);
    expect(captured).toBeNull();
  });

  test("returns null when the Bash command is empty", async () => {
    let captured: unknown = "untouched";
    await evaluate(bashEvent(""), [moduleWith([spyRule((ast) => (captured = ast))])]);
    expect(captured).toBeNull();
  });

  test("returns null on parse error (fail open)", async () => {
    let captured: unknown = "untouched";
    await evaluate(bashEvent("if; then"), [moduleWith([spyRule((ast) => (captured = ast))])]);
    expect(captured).toBeNull();
  });

  test("caches the AST across rules in one invocation (parse called once)", async () => {
    const captured: unknown[] = [];
    await evaluate(bashEvent("echo hello"), [
      moduleWith([
        spyRule((ast) => captured.push(ast)),
        spyRule((ast) => captured.push(ast)),
        spyRule((ast) => captured.push(ast)),
      ]),
    ]);
    // biome-ignore lint/style/noMagicNumbers: 3 = the spyRule count above; assertion shape mirrors the fixture.
    expect(captured.length).toBe(3);
    expect(captured[0]).toBe(captured[1]);
    expect(captured[1]).toBe(captured[2]);
  });

  test("AST is fresh per evaluate() invocation", async () => {
    let first: unknown;
    let second: unknown;
    await evaluate(bashEvent("echo a"), [moduleWith([spyRule((ast) => (first = ast))])]);
    await evaluate(bashEvent("echo b"), [moduleWith([spyRule((ast) => (second = ast))])]);
    expect(first).not.toBe(second);
  });
});
