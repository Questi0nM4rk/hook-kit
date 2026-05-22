// In-memory state store (for testing)
// See docs/SPEC.md § State Management

import type { StateStore } from "../core/types.js";

/**
 * In-memory `StateStore` backed by a per-instance `Map<string, unknown>`.
 *
 * **Concurrency:** single-process only. Each instance owns its own `Map`;
 * two `MemoryStore`s in the same process do NOT share state. Cross-process
 * concurrency is impossible by construction — `Map` is process-local. The
 * single-process scope makes the contract trivially satisfied: every `set`
 * / `delete` is a single in-memory mutation, observable by every read that
 * follows, with no torn intermediates. `flush()` is a no-op because there
 * is no backing storage to persist to.
 *
 * For tests and stateless hooks where persistence doesn't matter. For
 * cross-invocation persistence within a single process, use `TmpdirStore`.
 * For multi-process work, `SqliteStateStore` (ships in M2.1) is the
 * intended choice.
 *
 * See `docs/STATE.md` § Per-store guarantees for the contract matrix.
 *
 * @stable @since 1.0.0
 */
export class MemoryStore implements StateStore {
  private readonly data = new Map<string, unknown>();

  get(key: string): unknown {
    return this.data.get(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  flush(): void {
    // no-op — memory store doesn't persist
  }
}
