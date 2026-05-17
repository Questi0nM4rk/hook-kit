// Engine boundary: HookKitError thrown from a rule is surfaced AS THAT
// SPECIFIC CLASS, not wrapped as RuleEvaluationError.
//
// The engine's catch site does `cause instanceof HookKitError ? cause : new
// RuleEvaluationError(rule.kind, cause)`. The wrapping branch is covered by
// tests/engine/run-module.test.ts; this file covers the passthrough branch
// because content.ts, tmpdir-store.flush, and (in principle) any custom
// rule that wraps external I/O all rely on it for correct error attribution.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { content } from "../../src/builders/content.js";
import {
  FileReadError,
  FileWriteError,
  type HookKitError,
  JsonParseError,
  ProcessSpawnError,
} from "../../src/core/errors.js";
import { createModule } from "../../src/core/module.js";
import type { Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { TmpdirStore } from "../../src/state/tmpdir-store.js";

/** A rule that always throws the given HookKitError on evaluation. Used to
 *  drive the engine's passthrough branch without depending on filesystem
 *  state or external services. */
function throwingRule(err: HookKitError): Rule {
  return {
    kind: "throw-fixture",
    evaluate: () => {
      throw err;
    },
  };
}

describe("engine — HookKitError thrown from rule passes through as the specific class", () => {
  test("FileReadError → error annotation with errorCode 'FileReadError' (not RuleEvaluationError)", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      throwingRule(new FileReadError("/tmp/missing", new Error("ENOENT"))),
    ]);
    const outcome = await runModule({ module: mod, command: "echo hi" });
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (err?.kind !== "error") throw new Error("expected error annotation");
    expect(err.errorCode).toBe("FileReadError");
    expect(err.message).toContain("/tmp/missing");
    // Rule did not return a decision — no terminal.
    expect(outcome.terminal).toBeNull();
  });

  test("FileWriteError, JsonParseError, ProcessSpawnError all pass through unwrapped", async () => {
    const cases = [
      { err: new FileWriteError("/tmp/x", new Error("EROFS")), code: "FileWriteError" },
      { err: new JsonParseError("/tmp/x.json", new Error("bad")), code: "JsonParseError" },
      { err: new ProcessSpawnError("git status", new Error("ENOENT")), code: "ProcessSpawnError" },
    ] as const;
    for (const { err, code } of cases) {
      const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
        throwingRule(err),
      ]);
      const outcome = await runModule({ module: mod, command: "echo hi" });
      const ann = outcome.annotations.find((a) => a.kind === "error");
      if (ann?.kind !== "error") throw new Error(`expected error annotation for ${code}`);
      expect(ann.errorCode).toBe(code);
    }
  });

  test("non-HookKit throws still wrap as RuleEvaluationError (regression check)", async () => {
    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      {
        kind: "naive-thrower",
        evaluate: () => {
          throw new TypeError("rule has a bug");
        },
      },
    ]);
    const outcome = await runModule({ module: mod, command: "echo hi" });
    const ann = outcome.annotations.find((a) => a.kind === "error");
    if (ann?.kind !== "error") throw new Error("expected error annotation");
    expect(ann.errorCode).toBe("RuleEvaluationError");
    expect(ann.message).toContain("rule has a bug");
  });
});

// content() integration: an unreadable file (path exists but reading fails)
// triggers the FileReadError throw inside the rule. Verifies the end-to-end
// path: rule code throws → engine catches → annotation emitted with the right
// errorCode. We trigger by writing a directory at the target path so
// readFileSync hits EISDIR despite existsSync returning true.
describe("content() — readFileSync failure surfaces as FileReadError annotation (not RuleEvaluationError)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "hook-kit-content-err-"));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("EISDIR (path is a directory) → FileReadError annotation", async () => {
    // existsSync(dir) === true; readFileSync(dir) throws EISDIR.
    // mkdtempSync already created the directory at workDir.
    const mod = createModule({ id: "c", name: "c", events: ["PostToolUse"], matchers: ["Write"] }, [
      content().validate(() => null),
    ]);
    const outcome = await runModule({
      module: mod,
      event: {
        eventName: "PostToolUse",
        sessionId: "s",
        cwd: workDir,
        transcriptPath: "",
        toolName: "Write",
        toolInput: { file_path: workDir }, // it's a directory
        raw: {},
      },
    });
    const ann = outcome.annotations.find((a) => a.kind === "error");
    if (ann?.kind !== "error") throw new Error("expected error annotation");
    expect(ann.errorCode).toBe("FileReadError");
    expect(ann.message).toContain(workDir);
    expect(outcome.terminal).toBeNull();
  });
});

// TmpdirStore.flush() integration via the engine: when state.flush throws
// FileWriteError, the engine's flushState wrapper catches and emits the
// typed error as an annotation (preserving the prior decision state).
describe("engine flush — state.flush throwing HookKitError surfaces specific class", () => {
  test("FileWriteError from TmpdirStore.flush surfaces as that class (not StateStoreError wrap)", async () => {
    const store = new TmpdirStore({
      namespace: "test",
      sessionId: "unwritable",
      root: "/this/path/does/not/exist",
    });
    store.set("k", "v");

    const mod = createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [
      { kind: "noop", evaluate: () => null },
    ]);
    const outcome = await runModule({ module: mod, command: "echo hi", state: store });
    const ann = outcome.annotations.find((a) => a.kind === "error");
    if (ann?.kind !== "error") throw new Error("expected error annotation from flush");
    // flush() throws FileWriteError; engine should pass it through unwrapped.
    expect(ann.errorCode).toBe("FileWriteError");
    expect(outcome.terminal).toBeNull();
  });
});
