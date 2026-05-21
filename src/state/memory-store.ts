// In-memory state store (for testing)
// See docs/SPEC.md § State Management

import type { StateStore } from "../core/types.js";

/** @stable @since 1.0.0 */
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
