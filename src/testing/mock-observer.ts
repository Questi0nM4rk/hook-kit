// mockObserver — capture-and-replay DecisionObserver for tests. Wraps the
// production DecisionObserver interface with a records buffer + optional
// throwOn predicate so tests don't hand-roll their own capture closures and
// throw-fixtures. Throws inside onDecision are caught by the engine and
// surfaced as ObserverError annotations; the predicate is the supported way
// to exercise that path in tests.

import type { DecisionEventRecord, DecisionObserver } from "../core/types.js";

/** Options for `mockObserver()`.
 *  @stable @since 1.0.0 */
export interface MockObserverOpts {
  /** When set, the observer throws on every record where the predicate
   *  returns `true`. Used to exercise the engine's observer-throw fail-open
   *  path. The thrown Error message is `"mock-observer: throwOn fired"`. */
  readonly throwOn?: (record: DecisionEventRecord) => boolean;
}

/** Capture-and-replay observer for tests. Records every call to `onDecision`
 *  in `records`; throws on records matching `opts.throwOn` so the engine's
 *  throw-handling can be tested without hand-rolled fixtures. `reset()`
 *  clears the buffer in place (preserves the array identity).
 *  @stable @since 1.0.0 */
export interface MockObserver extends DecisionObserver {
  readonly records: readonly DecisionEventRecord[];
  reset(): void;
}

/** Build a MockObserver. Returns a fresh instance per call; no shared state
 *  between mockObserver() calls.
 *  @stable @since 1.0.0 */
export function mockObserver(opts: MockObserverOpts = {}): MockObserver {
  const records: DecisionEventRecord[] = [];
  const { throwOn } = opts;
  return {
    records,
    onDecision: (record): void => {
      records.push(record);
      if (throwOn?.(record) === true) {
        throw new Error("mock-observer: throwOn fired");
      }
    },
    reset: (): void => {
      records.length = 0;
    },
  };
}
