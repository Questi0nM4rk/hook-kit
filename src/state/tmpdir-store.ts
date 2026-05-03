// tmpdir-backed state store
// See docs/SPEC.md § State Management

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateStore } from "../core/types.js";

export interface TmpdirStoreOptions {
  /** Logical namespace for the file path (e.g., plugin id). */
  readonly namespace: string;
  /** Session identifier — usually `event.sessionId`. */
  readonly sessionId: string;
  /** Root directory. Defaults to `os.tmpdir()`; overridable for tests. */
  readonly root?: string;
}

/**
 * Persists a JSON object at `<root>/hook-kit-<namespace>-<sessionId>.json`.
 * Loads eagerly on construction; flushes on demand. No locking — assumes
 * single-agent sequential hook invocations. Disk failures are silent
 * (Iron Law 3): state is lost but the hook never blocks.
 */
export class TmpdirStore implements StateStore {
  private readonly file: string;
  private readonly data: Map<string, unknown>;

  constructor(opts: TmpdirStoreOptions) {
    const root = opts.root ?? tmpdir();
    this.file = join(root, `hook-kit-${opts.namespace}-${opts.sessionId}.json`);
    this.data = loadOrEmpty(this.file);
  }

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
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.data) obj[k] = v;
      writeFileSync(this.file, JSON.stringify(obj), "utf8");
    } catch {
      // Iron Law 3: persistence failures are silent.
    }
  }
}

function loadOrEmpty(file: string): Map<string, unknown> {
  if (!existsSync(file)) return new Map();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>));
  } catch {
    return new Map();
  }
}
