// tmpdir-backed state store
// See docs/SPEC.md § State Management and docs/STATE.md for the contract.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitErrorLine, FileReadError, FileWriteError, JsonParseError } from "../core/errors.js";
import type { StateStore } from "../core/types.js";

/** @stable @since 1.0.0 */
export interface TmpdirStoreOptions {
  /** Logical namespace for the file path (e.g., plugin id). */
  readonly namespace: string;
  /** Session identifier — usually `event.sessionId`. */
  readonly sessionId: string;
  /** Root directory. Defaults to `os.tmpdir()`; overridable for tests. */
  readonly root?: string;
}

// Counts open `TmpdirStore` instances per path in this process. Used to
// detect same-process violations of the concurrent-stores contract — see
// `docs/decisions/tmpdir-store-decision.md` and `docs/STATE.md` § Per-store
// guarantees. Counts open instances per path so a second instance
// surfaces a warning; the WARN fires once per (path, process) on the
// 1→2 transition. A count (not Set<TmpdirStore>) avoids retaining strong
// refs to every instance ever constructed.
const OPEN_PATHS = new Map<string, number>();

/**
 * Persists a JSON object at `<root>/hook-kit-<namespace>-<sessionId>.json`.
 *
 * Loads eagerly on construction; flushes on demand.
 *
 * **Concurrency:** single-process by design. Honours atomicity and flush
 * durability (see `docs/STATE.md` § Contract) within a single instance.
 * Does NOT honour the concurrent-stores guarantee: two `TmpdirStore`
 * instances against the same file path will silently lose the first's
 * writes when the second flushes (last-write-wins). This is the explicit
 * scope decided in `docs/decisions/tmpdir-store-decision.md`.
 *
 * Same-process detection: the constructor emits a one-time `console.warn`
 * when a second instance opens an already-open path within the same
 * process. Cross-process violations are NOT detected — same-path
 * `TmpdirStore` instances in separate processes will silently overwrite
 * each other on flush. If you see the same-process warning OR you need
 * multi-process semantics, use `SqliteStateStore` (M2.1) or author a
 * custom `StateStore` that satisfies the concurrent-stores guarantee.
 *
 * Error surfacing (0-silent-fails policy):
 *   - Constructor load failures emit a typed error line directly to stderr,
 *     then start with an empty map. (Construction has no EvaluationOutcome
 *     channel; we surface to stderr so the loss is still visible.)
 *   - `flush()` throws `FileWriteError` on persistence failure. The engine
 *     catches and emits an `error` annotation.
 * @stable @since 1.0.0
 */
export class TmpdirStore implements StateStore {
  private readonly file: string;
  private readonly data: Map<string, unknown>;

  constructor(opts: TmpdirStoreOptions) {
    const root = opts.root ?? tmpdir();
    this.file = join(root, `hook-kit-${opts.namespace}-${opts.sessionId}.json`);
    this.data = loadOrEmpty(this.file);
    registerOpenPath(this.file);
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
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.data) {
      obj[k] = v;
    }
    try {
      writeFileSync(this.file, JSON.stringify(obj), "utf8");
    } catch (cause) {
      throw new FileWriteError(this.file, cause);
    }
  }
}

/**
 * Same-process detection of concurrent-stores contract violation. Emits a
 * one-time `console.warn` when a second `TmpdirStore` opens an already-
 * open path within this process. Cross-process violations are not
 * detectable from here — see `docs/decisions/tmpdir-store-decision.md`.
 */
function registerOpenPath(file: string): void {
  const prior = OPEN_PATHS.get(file) ?? 0;
  // Warn on the 1→2 transition: second instance opening the path is the
  // contract violation. Third + subsequent still increment the count but
  // no extra warning fires — once per (path, process) keeps logs clean
  // under tight retry loops.
  if (prior === 1) {
    // biome-ignore lint/suspicious/noConsole: deliberate console.warn for consumer-misuse signal per docs/decisions/tmpdir-store-decision.md — runtime warning is the intended channel for surfacing same-process concurrent-stores contract violations to downstream consumers (NOT an internal hook-kit failure path; HookKitError would be wrong here).
    console.warn(
      `[hook-kit] TmpdirStore: multiple instances opened the same path "${file}" in this process — last-write-wins applies, see docs/STATE.md § Per-store guarantees. For multi-process work, use SqliteStateStore (M2.1) or a custom StateStore.`,
    );
  }
  OPEN_PATHS.set(file, prior + 1);
}

/**
 * Test-only reset of the same-process open-paths tracker. Lets tests
 * exercise the warning-on-second-open path without leaking state across
 * test files. Not exported from the public barrel.
 *
 * @internal — test-only; may move or rename in any release.
 */
export function __resetOpenPathsForTests(): void {
  OPEN_PATHS.clear();
}

function loadOrEmpty(file: string): Map<string, unknown> {
  if (!existsSync(file)) {
    return new Map();
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (cause) {
    emitErrorLine(new FileReadError(file, cause));
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    emitErrorLine(new JsonParseError(file, cause));
    return new Map();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }
  return new Map(Object.entries(parsed as Record<string, unknown>));
}
