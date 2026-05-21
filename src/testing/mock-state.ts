// mockState — in-memory StateStore for tests. Wraps `MemoryStore` from
// src/state/memory-store.ts so the test path and the production "memory"
// backend behave identically. Adds two test-only ergonomics: an initial
// seed object and an optional flushFn override (the production MemoryStore
// is no-op flush; tests sometimes need to inject failures or count calls).

import type { StateStore } from "../core/types.js";
import { MemoryStore } from "../state/memory-store.js";

/** @stable @since 1.0.0 */
export interface MockStateOpts {
  /** Custom flush behavior. Default no-op (matches MemoryStore). Throw from
   *  this fn to test the engine's `StateStoreError` annotation path. */
  readonly flushFn?: () => void | Promise<void>;
}

/**
 * In-memory StateStore for tests. Seeds `initial` into the underlying
 * `MemoryStore`; mutations apply identically to production memory semantics.
 * Pass `flushFn` to override the default no-op flush.
 *
 *   const state = mockState({ "deletions:count": 5 });
 *   await expectModule(mod).withState(state).onCommand("rm /tmp/x").toWarn();
 *   expect(state.get("deletions:count")).toBe(6);  // rule incremented
 *
 * Each call returns a fresh store — no shared state between mockState() calls.
 * @stable @since 1.0.0
 */
export function mockState(
  initial: Record<string, unknown> = {},
  opts: MockStateOpts = {},
): StateStore {
  const store = new MemoryStore();
  for (const [key, value] of Object.entries(initial)) {
    store.set(key, value);
  }
  if (opts.flushFn === undefined) {
    return store;
  }
  // Wrap the no-op flush with the injected fn. All other methods delegate.
  // The async wrap is intentional: a sync-throw from `flushFn` surfaces as a
  // rejected promise, mirroring the engine's `await state.flush()` site so
  // tests can `expect(state.flush()).rejects.toThrow(...)`.
  const flushFn = opts.flushFn;
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    has: (key) => store.has(key),
    delete: (key) => {
      store.delete(key);
    },
    async flush(): Promise<void> {
      await flushFn();
    },
  };
}
