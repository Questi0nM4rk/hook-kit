// biome-ignore-all lint/style/noMagicNumbers: integration tests use literal counter/threshold values inline so cross-feature wiring stays readable; named constants would obscure the test intent.
// biome-ignore-all lint/suspicious/noConsole: the restart-recovery test silences the M1.5 same-process warning emitted by TmpdirStore when sequentially opening two instances on the same path (NOT a concurrent-stores violation in this restart-recovery pattern).

// M1.5 + M1.1 + M1.2 triple-window e2e — per L-M1.3-5.
//
// Validates THREE features in one suite:
//   1. M1.5 StateStore contract: the 4 guarantees demonstrated against
//      MemoryStore and TmpdirStore — flush durability + last-write-wins
//      semantics + read-modify-write pattern via stateful() rules.
//   2. M1.1 DecisionObserver: observers fire on state.flush() errors via the
//      engine's `notifyEngineError("state-flush", err)` path. A throwing
//      flushFn (via mockState) surfaces as an error annotation AND a
//      DecisionEventRecord with `decision: "error"` and the synthetic
//      `<engine>:state-flush` ruleId.
//   3. M1.2 ProtocolAdapter contract: the `error` annotation from a
//      state-flush failure propagates through `outcome.annotations` with
//      the right errorCode, so any conforming adapter (CC, raw, custom)
//      can surface it via stderr or its structured-error channel.
//
// Library-mode (direct `evaluate()` calls) — NOT against the compiled
// binary. The compiled-binary e2e is covered by tests/build/*.test.ts.
// This suite covers the engine-level state contract + observer wiring at
// the engine boundary without the 10-30s compile cost.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateful } from "../../src/builders/state.js";
import { warning } from "../../src/core/decision.js";
import { createModule } from "../../src/core/module.js";
import type { HookEvent, HookModule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { __resetOpenPathsForTests, TmpdirStore } from "../../src/state/tmpdir-store.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { mockState } from "../../src/testing/mock-state.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-state-e2e-"));
  __resetOpenPathsForTests();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  __resetOpenPathsForTests();
});

/** Helper: synthetic Bash event with a deterministic sessionId for state
 *  paths. Mirrors tests/_helpers bashEvent but with sessionId override. */
function bashEvent(command: string, sessionId = "s-e2e"): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId,
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
  };
}

/** Helper: a stateful counter module. Increments `count:<command>` per
 *  invocation; emits a warning once the counter exceeds the threshold. */
function counterModule(threshold: number): HookModule {
  return createModule(
    {
      id: "state-counter",
      name: "state-counter",
      events: ["PreToolUse"],
      matchers: ["Bash"],
    },
    [
      stateful("counter", (event, state) => {
        const key = `count:${(event.toolInput.command as string | undefined) ?? ""}`;
        const prior = (state.get(key) as number | undefined) ?? 0;
        const next = prior + 1;
        state.set(key, next);
        return next > threshold
          ? warning(`counter exceeded ${String(threshold)}: now ${String(next)}`)
          : null;
      }),
    ],
  );
}

describe("M1.5 state e2e — triple-window (contract + observer + adapter)", () => {
  test("case 1: happy path — stateful rule writes a counter; observer fires per decision; flush succeeds silently", async () => {
    // Demonstrates M1.5 atomicity + flush durability + M1.1 observer firing
    // through the engine boundary. State increments cleanly; observer sees
    // the warning annotation; no error annotations surface.
    const store = mockState({});
    const obs = mockObserver();
    const mod = counterModule(2);

    // Three invocations: first two are below threshold (no warning), third
    // crosses threshold and emits warning.
    const r1 = await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store, observers: [obs] });
    const r2 = await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store, observers: [obs] });
    const r3 = await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store, observers: [obs] });

    // M1.5 atomicity: counter increments visible to each subsequent eval.
    expect(store.get("count:rm /tmp/x")).toBe(3);

    // First two: no terminal, no annotations (below threshold).
    expect(r1.terminal).toBeNull();
    expect(r1.annotations).toHaveLength(0);
    expect(r2.terminal).toBeNull();
    expect(r2.annotations).toHaveLength(0);

    // Third: warning annotation surfaces.
    expect(r3.terminal).toBeNull();
    expect(r3.annotations).toHaveLength(1);
    expect(r3.annotations[0]?.kind).toBe("warning");

    // M1.1: observer captured only the warning record (the two no-op
    // decisions are null and don't fire observers).
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("warning");
    // stateful() wraps with kind "stateful:<id>" — see src/builders/state.ts.
    expect(obs.records[0]?.ruleId).toBe("state-counter:stateful:counter:0");

    // No error annotations across any evaluation.
    expect(r1.annotations.filter((a) => a.kind === "error")).toHaveLength(0);
    expect(r2.annotations.filter((a) => a.kind === "error")).toHaveLength(0);
    expect(r3.annotations.filter((a) => a.kind === "error")).toHaveLength(0);
  });

  test("case 2: flush failure — state.flush() throws → engine catches → error annotation surfaces → observer fires with decision:'error' and ruleId:<engine>:state-flush", async () => {
    // M1.5 fail-open boundary + M1.1 engine-error observer wiring + M1.2
    // error-annotation propagation, all in one test. The mockState flushFn
    // throws synchronously; engine's flushState wrapper catches and emits
    // a StateStoreError annotation + invokes the observer through the
    // notifyEngineError("state-flush", err) path documented in
    // src/engine/index.ts.
    const flushError = new Error("simulated disk-full at flush boundary");
    const store = mockState(
      {},
      {
        flushFn: () => {
          throw flushError;
        },
      },
    );
    const obs = mockObserver();
    const mod = counterModule(10);

    const outcome = await evaluate(bashEvent("rm /tmp/x"), [mod], {
      state: store,
      observers: [obs],
    });

    // M1.5 fail-open: rule still ran cleanly, but flush failed.
    expect(outcome.terminal).toBeNull();

    // M1.2 error annotation surfaces with the right errorCode.
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind === "error" && errors[0].errorCode).toBe("StateStoreError");

    // M1.1: observer captured the engine-emitted error with the synthetic
    // ruleId `<engine>:state-flush` and timingMs=0 (no rule.evaluate()
    // bracketed) per the convention in src/engine/index.ts:notifyEngineError.
    const errorRecords = obs.records.filter((r) => r.decision === "error");
    expect(errorRecords).toHaveLength(1);
    expect(errorRecords[0]?.ruleId).toBe("<engine>:state-flush");
    expect(errorRecords[0]?.ruleKind).toBe("state-flush");
    expect(errorRecords[0]?.timingMs).toBe(0);
  });

  test("case 3: last-write-wins on concurrent in-process stores — M1.5 Guarantee 3 demonstrated against MemoryStore", async () => {
    // Two stateful rules both touching the same key against the SAME store
    // instance. The contract guarantees per-key atomicity (Guarantee 1) so
    // each set is observable to subsequent reads in the same evaluate()
    // frame; the final value reflects the last write (which is the same
    // semantics as Guarantee 3's last-write-wins when two stores serialize
    // their writes against shared storage).
    const store = mockState({});
    const obs = mockObserver();
    const mod = createModule(
      {
        id: "two-writers",
        name: "two-writers",
        events: ["PreToolUse"],
        matchers: ["Bash"],
      },
      [
        // Rule 1: writes "a".
        stateful("writer-a", (_event, state) => {
          state.set("contested", "a");
          return null;
        }),
        // Rule 2 (evaluated after Rule 1 in the same evaluate frame):
        // writes "b". The contract: "b" wins (last write).
        stateful("writer-b", (_event, state) => {
          state.set("contested", "b");
          return null;
        }),
      ],
    );

    await evaluate(bashEvent("ls /tmp"), [mod], { state: store, observers: [obs] });

    // M1.5 Guarantee 1 + Guarantee 3 in single-process form: the SAME
    // store sees Rule 2's write as authoritative; Rule 1's value is
    // overwritten cleanly with no torn intermediate.
    expect(store.get("contested")).toBe("b");
  });

  test("case 4: restart recovery — TmpdirStore flush + new instance round-trips state across simulated process restart", async () => {
    // M1.5 Guarantee 2 (flush durability) demonstrated end-to-end. First
    // store: stateful rule writes a counter, engine flushes on
    // evaluate-end. Close store (drop reference). New store on the same
    // path: counter visible. Subsequent invocations continue from the
    // persisted value.
    //
    // Silence the same-process warning since this IS the canonical
    // round-trip pattern (sequential, not concurrent).
    const originalWarn = console.warn;
    console.warn = (): void => {
      /* silenced — restart-recovery is sequential, not concurrent-stores violation */
    };
    try {
      const sessionId = "restart-recovery";
      const mod = counterModule(100);

      // "First process": three invocations against a fresh TmpdirStore.
      const store1 = new TmpdirStore({ namespace: "state-e2e", sessionId, root: workDir });
      await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store1 });
      await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store1 });
      await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store1 });
      // Engine auto-flushes at end of each evaluate(); explicit flush
      // here too as belt-and-suspenders for the restart simulation.
      // TmpdirStore.flush is sync void; no await needed.
      store1.flush();

      // "Second process": fresh TmpdirStore at the same path. Per M1.5
      // Guarantee 2, prior writes are durable + visible.
      const store2 = new TmpdirStore({ namespace: "state-e2e", sessionId, root: workDir });
      expect(store2.get("count:rm /tmp/x")).toBe(3);

      // Continue incrementing: the counter ticks from the persisted value.
      const r4 = await evaluate(bashEvent("rm /tmp/x"), [mod], { state: store2 });
      expect(store2.get("count:rm /tmp/x")).toBe(4);
      // Below threshold (100) so no warning.
      expect(r4.annotations).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});
