import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { content } from "../../src/builders/content.js";
import { deny, warning } from "../../src/core/decision.js";
import type { Annotation, HookEvent, HookModule, Rule, Terminal } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-content-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function postToolUseEvent(toolName: string, filePath: string): HookEvent {
  return {
    eventName: "PostToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName,
    toolInput: { file_path: filePath },
    raw: {},
  };
}

function preToolUseEvent(toolName: string, filePath: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName,
    toolInput: { file_path: filePath },
    raw: {},
  };
}

function moduleWith(rule: Rule, events: string[] = ["PostToolUse"]): HookModule {
  return { id: "m", name: "test", events, rules: [rule] };
}

async function runOnFile(
  toolName: string,
  filePath: string,
  rule: Rule,
  evt: "Pre" | "Post" = "Post",
): Promise<Terminal | null> {
  const event =
    evt === "Post" ? postToolUseEvent(toolName, filePath) : preToolUseEvent(toolName, filePath);
  const events = evt === "Post" ? ["PostToolUse"] : ["PreToolUse"];
  const outcome = await evaluate(event, [moduleWith(rule, events)]);
  return outcome.terminal;
}

async function runOnFileAnnotations(
  toolName: string,
  filePath: string,
  rule: Rule,
  evt: "Pre" | "Post" = "Post",
): Promise<readonly Annotation[]> {
  const event =
    evt === "Post" ? postToolUseEvent(toolName, filePath) : preToolUseEvent(toolName, filePath);
  const events = evt === "Post" ? ["PostToolUse"] : ["PreToolUse"];
  const outcome = await evaluate(event, [moduleWith(rule, events)]);
  return outcome.annotations;
}

describe("content() — basic", () => {
  test("calls the validator with file_path and disk content on PostToolUse", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(file, "# Hello\n\n## Problem\n\nbody", "utf8");
    let receivedPath: string | undefined;
    let receivedBody: string | undefined;
    const rule = content().validate((p, b) => {
      receivedPath = p;
      receivedBody = b;
      return null;
    });
    await runOnFile("Write", file, rule);
    expect(receivedPath).toBe(file);
    expect(receivedBody).toContain("# Hello");
    expect(receivedBody).toContain("## Problem");
  });

  test("returns whatever the validator returns (deny)", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "no header", "utf8");
    const rule = content().validate((_p, body) =>
      body.startsWith("#") ? null : deny("missing header"),
    );
    const d = await runOnFile("Write", file, rule);
    expect(d).toEqual({ kind: "deny", reason: "missing header" });
  });

  test("returns whatever the validator returns (warning annotation)", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "# header\nshort", "utf8");
    const rule = content().validate((_p, body) =>
      // biome-ignore lint/style/noMagicNumbers: 100-char threshold is the literal validator parameter under test.
      body.length < 100 ? warning("could be longer") : null,
    );
    const anns = await runOnFileAnnotations("Write", file, rule);
    expect(anns).toEqual([{ kind: "warning", message: "could be longer" }]);
  });

  test("returns null when validator returns null", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "# all good", "utf8");
    const rule = content().validate(() => null);
    const d = await runOnFile("Write", file, rule);
    expect(d).toBeNull();
  });

  test("supports async validators", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "body", "utf8");
    const rule = content().validate(async (_p, body) => {
      await Promise.resolve();
      return body === "body" ? deny("yep") : null;
    });
    const d = await runOnFile("Write", file, rule);
    expect(d).toEqual({ kind: "deny", reason: "yep" });
  });
});

describe("content() — matchPath filter", () => {
  test("validator runs when matchPath is satisfied", async () => {
    const file = join(workDir, "design.md");
    writeFileSync(file, "x", "utf8");
    let called = false;
    const rule = content()
      .matchPath(/\.md$/)
      .validate(() => {
        called = true;
        return null;
      });
    await runOnFile("Write", file, rule);
    expect(called).toBe(true);
  });

  test("validator does NOT run when matchPath fails", async () => {
    const file = join(workDir, "code.cs");
    writeFileSync(file, "x", "utf8");
    let called = false;
    const rule = content()
      .matchPath(/\.md$/)
      .validate(() => {
        called = true;
        return deny("nope");
      });
    const d = await runOnFile("Write", file, rule);
    expect(called).toBe(false);
    expect(d).toBeNull();
  });
});

describe("content() — event filtering", () => {
  test("does not run on PreToolUse", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "x", "utf8");
    let called = false;
    const rule = content().validate(() => {
      called = true;
      return deny("no");
    });
    const d = await runOnFile("Write", file, rule, "Pre");
    expect(called).toBe(false);
    expect(d).toBeNull();
  });

  test("does not run on Bash PostToolUse (no file_path)", async () => {
    let called = false;
    const rule = content().validate(() => {
      called = true;
      return deny("no");
    });
    const event: HookEvent = {
      eventName: "PostToolUse",
      sessionId: "s1",
      cwd: "/tmp",
      transcriptPath: "/tmp/t.jsonl",
      toolName: "Bash",
      toolInput: { command: "ls" },
      raw: {},
    };
    const outcome = await evaluate(event, [moduleWith(rule)]);
    expect(called).toBe(false);
    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
  });
});

describe("content() — fail-open IO", () => {
  test("returns null silently when the file does not exist", async () => {
    const ghost = join(workDir, "does-not-exist.md");
    let called = false;
    const rule = content().validate(() => {
      called = true;
      return deny("no");
    });
    const d = await runOnFile("Write", ghost, rule);
    expect(called).toBe(false);
    expect(d).toBeNull();
  });

  test("returns null when validator throws (engine catches)", async () => {
    const file = join(workDir, "x.md");
    writeFileSync(file, "body", "utf8");
    const rule = content().validate(() => {
      throw new Error("boom");
    });
    const d = await runOnFile("Write", file, rule);
    expect(d).toBeNull();
  });
});
