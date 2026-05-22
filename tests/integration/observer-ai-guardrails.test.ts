// biome-ignore-all lint/style/noMagicNumbers: small literal counts (expected record lengths, rule indices) and absolute path examples in regex literals where extracting to named constants obscures the test intent.
// M1.1 DecisionObserver — library-mode e2e against the ai-guardrails example.
//
// Validates observer wiring against a REAL consumer's compiled rule set, not
// hand-rolled fixtures. Library mode (direct `evaluate()` call) — NOT the
// compiled binary, which would require build-CLI work to thread observers
// from a consumer source file into the compiled output (deferred).
//
// Setup mirrors `tests/build/example-ai-guardrails.test.ts`: copy the
// example's src/ into a tmpdir, symlink hook-kit + shell-ast + zod into a
// node_modules tree at that tmpdir, dynamic-import the staged hooks.ts. The
// example itself is NOT modified — its default export (array of HookModule)
// is the entire surface this test consumes.
//
// File-observer recipe (the inline `fileObserver` in the second test) is
// documented here as the canonical pattern consumers copy into their own
// codebases — kept inline (not added as a new SDK function) per scope.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DecisionEventRecord, DecisionObserver, HookModule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { writeEvent } from "../../src/testing/events.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent } from "../_helpers.js";

const HOOK_KIT_ROOT = resolve(import.meta.dirname, "..", "..");
const EXAMPLE_ROOT = resolve(HOOK_KIT_ROOT, "examples", "ai-guardrails");

/** Stage the example into a tmpdir with node_modules symlinks so its
 *  `import { … } from "@questi0nm4rk/hook-kit"` resolves. Mirrors the
 *  `stageExample` helper in `tests/build/example-ai-guardrails.test.ts`
 *  but skips the build step — we dynamic-import the source directly. */
function stageExampleForLibMode(): { dir: string; entry: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hook-kit-ag-libmode-"));
  cpSync(join(EXAMPLE_ROOT, "src"), join(dir, "src"), { recursive: true });
  const nm = join(dir, "node_modules", "@questi0nm4rk");
  mkdirSync(nm, { recursive: true });
  symlinkSync(HOOK_KIT_ROOT, join(nm, "hook-kit"), "dir");
  symlinkSync(
    resolve(HOOK_KIT_ROOT, "node_modules", "@questi0nm4rk", "shell-ast"),
    join(nm, "shell-ast"),
    "dir",
  );
  symlinkSync(
    resolve(HOOK_KIT_ROOT, "node_modules", "zod"),
    join(dir, "node_modules", "zod"),
    "dir",
  );
  return {
    dir,
    entry: join(dir, "src", "hooks.ts"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let stage: ReturnType<typeof stageExampleForLibMode>;
let modules: readonly HookModule[];

beforeAll(async () => {
  stage = stageExampleForLibMode();
  // Dynamic import of the staged example — module-level `import` would
  // resolve at compile time before the symlinks exist.
  const mod = (await import(stage.entry)) as { default: readonly HookModule[] };
  modules = mod.default;
});

afterAll(() => {
  stage.cleanup();
});

const HEX64 = /^[0-9a-f]{64}$/;

describe("M1.1 observer — library-mode e2e against ai-guardrails example", () => {
  test("loaded modules expose the expected ids (sanity)", () => {
    const ids = modules.map((m) => m.id);
    // Snapshot the published rule-set so test failures here surface example
    // drift loudly (the e2e events below depend on these module ids existing).
    expect(ids).toContain("git-force-push");
    expect(ids).toContain("system-path-writes");
    expect(ids).toContain("protect-configs");
    expect(modules.length).toBeGreaterThanOrEqual(11);
  });

  test("known DENY: gcc -o /etc/passwd fires system-path-writes", async () => {
    const obs = mockObserver();
    const event = bashEvent("gcc -o /etc/passwd src.c");
    const outcome = await evaluate(event, modules, { observers: [obs] });

    expect(outcome.terminal?.kind).toBe("deny");
    if (outcome.terminal?.kind !== "deny") {
      throw new Error("expected deny terminal");
    }
    expect(outcome.terminal.reason).toMatch(/system path/i);

    // Observer fired exactly once — for the deny.
    expect(obs.records).toHaveLength(1);
    const r = obs.records[0];
    if (r === undefined) {
      throw new Error("expected at least one record");
    }
    expect(r.decision).toBe("deny");
    // ruleId format: <module.id>:<rule.kind>:<index>. The gcc deny is rules[0]
    // in the system-path-writes module; cmd() builders produce kind: "command".
    expect(r.ruleId).toBe("system-path-writes:command:0");
    expect(r.ruleKind).toBe("command");
    expect(r.event.toolName).toBe("Bash");
    expect(r.event.toolInputHash).toMatch(HEX64);
    expect(r.timingMs).toBeGreaterThanOrEqual(0);
    expect(r.timestamp).toBeGreaterThan(0);
  });

  test("known ASK: git push --force fires git-force-push", async () => {
    const obs = mockObserver();
    const event = bashEvent("git push --force");
    const outcome = await evaluate(event, modules, { observers: [obs] });

    expect(outcome.terminal?.kind).toBe("ask");
    if (outcome.terminal?.kind !== "ask") {
      throw new Error("expected ask terminal");
    }
    expect(outcome.terminal.reason).toMatch(/force/i);

    // One ask record from git-force-push.
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("ask");
    expect(obs.records[0]?.ruleId).toBe("git-force-push:command:0");
    expect(obs.records[0]?.event.toolInputHash).toMatch(HEX64);
  });

  test("known ASK via path rule: Write to .env fires protect-configs", async () => {
    const obs = mockObserver();
    // Trigger path() rule by sending a Write event with file_path matching
    // the .env regex (`/\.(env|env\.\w+)$/`). protect-configs matchers
    // include "Write".
    const event = writeEvent("/proj/.env", "SECRET=hunter2");
    const outcome = await evaluate(event, modules, { observers: [obs] });

    expect(outcome.terminal?.kind).toBe("ask");
    if (outcome.terminal?.kind !== "ask") {
      throw new Error("expected ask terminal");
    }
    expect(outcome.terminal.reason).toMatch(/\.env/i);

    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("ask");
    // path() rules are rule.kind "path"; the .env rule is rules[0] of protect-configs.
    expect(obs.records[0]?.ruleId).toBe("protect-configs:path:0");
    expect(obs.records[0]?.ruleKind).toBe("path");
    expect(obs.records[0]?.event.toolName).toBe("Write");
  });

  test("known CLEAN: ls /tmp produces no decisions, observer fires 0 times", async () => {
    const obs = mockObserver();
    const event = bashEvent("ls /tmp");
    const outcome = await evaluate(event, modules, { observers: [obs] });

    expect(outcome.terminal).toBeNull();
    expect(outcome.annotations).toEqual([]);
    expect(obs.records).toEqual([]);
  });

  test("observer-throw fail-open: throwing on deny still produces the deny + ObserverError", async () => {
    // Real consumer's rule + a throwing observer = the engine's fail-open
    // boundary at work. The deny terminal MUST still surface; the throw
    // becomes an `error` annotation alongside.
    const obs = mockObserver({ throwOn: (r: DecisionEventRecord) => r.decision === "deny" });
    const event = bashEvent("gcc -o /etc/passwd src.c");
    const outcome = await evaluate(event, modules, { observers: [obs] });

    // Deny still happens.
    expect(outcome.terminal?.kind).toBe("deny");
    // ObserverError annotation landed on the outcome.
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind === "error" && errors[0].errorCode).toBe("ObserverError");
    // Record was still captured (push happens before the throw inside mockObserver).
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("deny");
  });

  test("file-observer recipe: appendFileSync per record (JSONL audit log)", async () => {
    // Canonical pattern consumers copy: write each decision to a JSONL file
    // for post-hoc audit / replay. NOT a new SDK function — it's a 5-line
    // inline observer. Documented here so M1.1's "consumers can sink to
    // file" claim is exercised against a real rule set, not a placeholder.
    //
    // Anti-pattern note documented in SPEC § Observability: appendFileSync
    // blocks the engine. Fine for tests and low-volume sinks; for hot paths,
    // enqueue + flush out-of-band.
    const logPath = join(stage.dir, "decisions.jsonl");
    const fileObserver: DecisionObserver = {
      onDecision: (r) => {
        appendFileSync(logPath, `${JSON.stringify(r)}\n`);
      },
    };

    const event = bashEvent("git push --force");
    const outcome = await evaluate(event, modules, { observers: [fileObserver] });

    expect(outcome.terminal?.kind).toBe("ask");
    // Read the JSONL back and verify the record landed.
    const contents = readFileSync(logPath, "utf8").trim().split("\n");
    expect(contents).toHaveLength(1);
    const parsed = JSON.parse(contents[0] ?? "") as DecisionEventRecord;
    expect(parsed.decision).toBe("ask");
    expect(parsed.ruleId).toBe("git-force-push:command:0");
    expect(parsed.event.toolInputHash).toMatch(HEX64);
  });
});
