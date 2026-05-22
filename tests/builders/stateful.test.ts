// biome-ignore-all lint/style/noMagicNumbers: stateful tests use literal counter/threshold fixtures inline for state-transition assertions; named constants would obscure the test intent.
// biome-ignore-all lint/performance/noAwaitInLoops: state-progression tests require sequential awaits to observe the counter ticking through each evaluate call.
// biome-ignore-all lint/suspicious/noConsole: tests silence console.warn around TmpdirStore round-trip flows (NOT concurrent-stores violation) so the M1.5 same-process warning doesn't pollute test output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateful } from "../../src/builders/state.js";
import { warning } from "../../src/core/decision.js";
import type { Annotation, HookEvent, HookModule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { MemoryStore } from "../../src/state/memory-store.js";
import { __resetOpenPathsForTests, TmpdirStore } from "../../src/state/tmpdir-store.js";

let workDir: string;
let originalWarn: typeof console.warn;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-stateful-"));
  // These tests exercise sequential read-flush-reopen (NOT concurrent-stores
  // violation), so silence the M1.5 same-process warning emitted by
  // TmpdirStore when a second instance opens an already-open path.
  // The reset + console.warn silence belt-and-suspenders: reset clears the
  // tracker between tests, silence swallows any warning that fires within
  // a single test that opens multiple instances on the same path.
  __resetOpenPathsForTests();
  originalWarn = console.warn;
  console.warn = (): void => {
    /* silenced — these tests intentionally open multiple instances on same paths */
  };
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  __resetOpenPathsForTests();
  console.warn = originalWarn;
});

function bashEvent(command: string, sessionId = "s1"): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId,
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: {},
  };
}

function repetitionModule(threshold: number): HookModule {
  return {
    id: "rep",
    name: "repetition",
    events: ["PreToolUse"],
    matchers: ["Bash"],
    rules: [
      stateful("repetition", (event, state) => {
        const key = `cmd:${(event.toolInput.command as string | undefined) ?? ""}`;
        const count = ((state.get(key) as number | undefined) ?? 0) + 1;
        state.set(key, count);
        if (count > threshold) {
          return warning(`repeated ${String(count)} times — break the loop`);
        }
        return null;
      }),
    ],
  };
}

function annotationMessages(anns: readonly Annotation[]): string[] {
  return anns.map((a) => a.message);
}

describe("stateful() — cross-invocation persistence with TmpdirStore", () => {
  test("count increments across separate evaluate() calls", async () => {
    const sessionId = "session-rep";
    const namespace = "test";

    // First two invocations: silent (no annotations).
    for (let i = 0; i < 3; i++) {
      const store = new TmpdirStore({ namespace, sessionId, root: workDir });
      const out = await evaluate(bashEvent("ls -la"), [repetitionModule(2)], { state: store });
      if (i < 2) {
        expect(out.annotations).toEqual([]);
      }
    }

    // Fourth invocation: should fire because count = 4 > threshold 2.
    const store = new TmpdirStore({ namespace, sessionId, root: workDir });
    const out = await evaluate(bashEvent("ls -la"), [repetitionModule(2)], { state: store });
    expect(out.annotations).toEqual([
      { kind: "warning", message: "repeated 4 times — break the loop" },
    ]);
  });

  test("sessions are isolated by sessionId", async () => {
    const namespace = "test";
    // Session A: hit it twice.
    for (let i = 0; i < 2; i++) {
      const store = new TmpdirStore({ namespace, sessionId: "a", root: workDir });
      await evaluate(bashEvent("ls"), [repetitionModule(1)], { state: store });
    }
    // Session B: first call should still be silent.
    const storeB = new TmpdirStore({ namespace, sessionId: "b", root: workDir });
    const out = await evaluate(bashEvent("ls"), [repetitionModule(1)], { state: storeB });
    expect(out.annotations).toEqual([]);
  });
});

describe("stateful() — MemoryStore fallback", () => {
  test("works with the in-memory store for tests / stateless deploys", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) {
      await evaluate(bashEvent("rm foo"), [repetitionModule(1)], { state: store });
    }
    const out = await evaluate(bashEvent("rm foo"), [repetitionModule(1)], { state: store });
    expect(out.annotations.length).toBeGreaterThan(0);
    expect(annotationMessages(out.annotations).join(" ")).toContain("repeated 4 times");
  });

  test("default (no state passed) is a noop — counts never persist", async () => {
    const out1 = await evaluate(bashEvent("rm foo"), [repetitionModule(0)]);
    const out2 = await evaluate(bashEvent("rm foo"), [repetitionModule(0)]);
    // threshold is 0 → count > 0 fires immediately on each call.
    expect(out1.annotations.length).toBeGreaterThan(0);
    expect(out2.annotations.length).toBeGreaterThan(0);
    // But the message says "repeated 1 times" both times, since state did
    // not persist.
    expect(annotationMessages(out1.annotations).join(" ")).toContain("repeated 1 times");
    expect(annotationMessages(out2.annotations).join(" ")).toContain("repeated 1 times");
  });
});

describe("stateful() — flushes after evaluate", () => {
  test("the state file exists on disk after evaluate completes", async () => {
    const sessionId = "flush-check";
    const namespace = "test";
    const store = new TmpdirStore({ namespace, sessionId, root: workDir });
    await evaluate(bashEvent("git status"), [repetitionModule(99)], { state: store });

    // A new store instance should see the value.
    const fresh = new TmpdirStore({ namespace, sessionId, root: workDir });
    expect(fresh.get("cmd:git status")).toBe(1);
  });
});
