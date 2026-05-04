import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context } from "../../src/core/decision.js";
import type { HookEvent, HookModule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { stateful } from "../../src/rules/state.js";
import { MemoryStore } from "../../src/state/memory-store.js";
import { TmpdirStore } from "../../src/state/tmpdir-store.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-stateful-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
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
        const key = `cmd:${(event.toolInput.command as string) ?? ""}`;
        const count = ((state.get(key) as number) ?? 0) + 1;
        state.set(key, count);
        if (count > threshold) {
          return context(`repeated ${count} times — break the loop`);
        }
        return null;
      }),
    ],
  };
}

describe("stateful() — cross-invocation persistence with TmpdirStore", () => {
  test("count increments across separate evaluate() calls", async () => {
    const sessionId = "session-rep";
    const namespace = "test";

    // First two invocations: silent.
    for (let i = 0; i < 3; i++) {
      const store = new TmpdirStore({ namespace, sessionId, root: workDir });
      const d = await evaluate(bashEvent("ls -la"), [repetitionModule(2)], { state: store });
      if (i < 2) expect(d).toBeNull();
    }

    // Fourth invocation: should fire because count = 4 > threshold 2.
    const store = new TmpdirStore({ namespace, sessionId, root: workDir });
    const d = await evaluate(bashEvent("ls -la"), [repetitionModule(2)], { state: store });
    expect(d).toEqual({ kind: "context", message: "repeated 4 times — break the loop" });
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
    const d = await evaluate(bashEvent("ls"), [repetitionModule(1)], { state: storeB });
    expect(d).toBeNull();
  });
});

describe("stateful() — MemoryStore fallback", () => {
  test("works with the in-memory store for tests / stateless deploys", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) {
      await evaluate(bashEvent("rm foo"), [repetitionModule(1)], { state: store });
    }
    const d = await evaluate(bashEvent("rm foo"), [repetitionModule(1)], { state: store });
    expect(d).not.toBeNull();
    expect((d as { message: string }).message).toContain("repeated 4 times");
  });

  test("default (no state passed) is a noop — counts never persist", async () => {
    const d1 = await evaluate(bashEvent("rm foo"), [repetitionModule(0)]);
    const d2 = await evaluate(bashEvent("rm foo"), [repetitionModule(0)]);
    // threshold is 0 → count > 0 fires immediately on each call.
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();
    // But the message says "repeated 1 times" both times, since state did
    // not persist.
    expect((d1 as { message: string }).message).toContain("repeated 1 times");
    expect((d2 as { message: string }).message).toContain("repeated 1 times");
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
