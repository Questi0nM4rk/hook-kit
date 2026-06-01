# State stores — concurrency contract for hook-kit

`StateStore` is the persistence interface for `stateful()` rules. The same five-method interface — `get`, `set`, `has`, `delete`, `flush` — is consumed by the engine, implemented by hook-kit's two shipped stores (`MemoryStore`, `TmpdirStore`), and authored by consumers who back state with a custom store (SQLite, Redis, PostgreSQL, an in-house service). This document is the contract every implementation must honour.

The contract is `@stable @since 1.0.0` per [`docs/STABILITY.md`](./STABILITY.md). Breaking changes go through the deprecation cycle.

Read this before authoring a custom `StateStore`; read it before changing the shipped implementations (`src/state/memory-store.ts`, `src/state/tmpdir-store.ts`); read it whenever a `stateful()` rule needs more than a single-key counter and you have to reason about read-modify-write semantics.

## Contract

`StateStore` is the five-method interface in [`src/core/types.ts`](../src/core/types.ts):

```ts
export interface StateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  flush(): void | Promise<void>;
}
```

Reference implementations:

- [`src/state/memory-store.ts`](../src/state/memory-store.ts) — in-memory `Map`, single-process, no persistence. Test default.
- [`src/state/tmpdir-store.ts`](../src/state/tmpdir-store.ts) — JSON file at `<root>/hook-kit-<namespace>-<sessionId>.json`. Production default for single-agent runs. Single-process by design — see § Per-store guarantees.
- `SqliteStateStore` — planned for M2.1. Multi-process via SQLite WAL mode + busy-timeout retries.

The engine wires `flush()` into the end of every `evaluate()` (success or short-circuit) so rules see a "set + forget" persistence model. Per [`docs/SPEC.md`](./SPEC.md) § State Management, `flush()` failures are caught and surface as `error` annotations on the outcome (engine-boundary fail-open); they NEVER block the user's command.

Four guarantees every conforming implementation MUST honour:

### Guarantee 1: Atomicity

Every `set(key, value)` and `delete(key)` is atomic with respect to concurrent readers against the same backing storage. A reader either sees the pre-state value (or absence) OR the post-state value (or absence); it MUST NOT see a torn intermediate — a partial write, a half-deleted entry, or any state that was never observable to a single-threaded caller.

**Why it matters.** Without atomicity, a `stateful()` rule that reads a counter to decide deny-vs-warn could read garbage during another rule's increment and pick the wrong terminal. The atomicity guarantee makes per-key reasoning a single concern; the consumer doesn't reason about partial updates.

**Worked example.** A `stateful()` rule that counts `rm` invocations:

```ts
stateful("rm-counter", (event, state) => {
  // Atomicity guarantees: this read sees EITHER the prior count OR the
  // result of another concurrent rule's set — never an in-progress write.
  const prior = (state.get("rm:count") as number | undefined) ?? 0;
  const next = prior + 1;
  state.set("rm:count", next);
  // Set is atomic; readers in this evaluate() see `next` immediately.
  // Readers in concurrent stores (other processes / sessions) see `next`
  // after the next flush() — see Guarantee 2.
  return next > MAX_DELETES ? deny("quota exceeded") : warning(`rm #${String(next)}`);
});
```

Atomicity is a per-key property. It does NOT extend across keys — see Guarantee 4.

### Guarantee 2: Flush durability

After `flush()` resolves (sync `void` or `await`-ed `Promise<void>`), all prior `set` / `delete` mutations on this instance are durable: visible to FRESH `StateStore` instances opened against the same backing storage AND recoverable across process restart. The instance that called `flush()` may continue to mutate; subsequent mutations are not yet durable until the next `flush()`.

**Why it matters.** Stateful rules persist across hook invocations (each invocation is a fresh process). Without flush durability, a counter set in one invocation would be invisible to the next. The engine calls `flush()` automatically at the end of every `evaluate()` so the rule author never writes the call.

**Worked example.** Round-trip across process restart:

```ts
// First invocation
const store1 = new TmpdirStore({ namespace: "rm-guard", sessionId: "abc" });
store1.set("rm:count", 5);
await store1.flush();
// File on disk now contains `{"rm:count":5}`.

// Process exits, fresh process starts (different PID, same session).

// Second invocation
const store2 = new TmpdirStore({ namespace: "rm-guard", sessionId: "abc" });
// Flush durability guarantees: store2.get sees the persisted value.
expect(store2.get("rm:count")).toBe(5);
```

`MemoryStore.flush()` is a no-op because there is no backing storage to persist to — single-process scope makes durability irrelevant. `TmpdirStore.flush()` performs a single `writeFileSync` of the serialized map; the OS's file-write atomicity does the rest. `SqliteStateStore.flush()` (M2.1) will fsync the WAL.

The return-type union `void | Promise<void>` exists for stores whose persistence is asynchronous (network, fsync). Engine code is `await state.flush()` — the `await` is correct for both sync and async returns.

### Guarantee 3: Concurrent stores

Multiple `StateStore` instances pointing at the same backing storage MUST safely interleave. The contract is **last-write-wins per key**: when two instances `set("k", a)` and `set("k", b)` against the same backing storage, every subsequent reader (in either instance, or a third fresh instance) sees one of `{a, b}` consistently — never a torn third value. Reads see the latest committed write.

**Why it matters.** Multi-process work is a real use case: a CI runner with parallel hook-kit invocations against a shared state file, a long-lived broker process accumulating cross-session counters, a daemon serving multiple hook events concurrently. The contract makes "two processes share state" a workable pattern; the alternative is per-process islands of state that drift silently.

**Worked example.** Two processes incrementing the same counter against a shared SQLite-backed store:

```ts
// Process A
const a = new SqliteStateStore({ path: "/tmp/shared.sqlite" });
a.set("invocations", ((a.get("invocations") as number | undefined) ?? 0) + 1);
await a.flush();

// Process B (concurrent with A)
const b = new SqliteStateStore({ path: "/tmp/shared.sqlite" });
b.set("invocations", ((b.get("invocations") as number | undefined) ?? 0) + 1);
await b.flush();

// Fresh reader, after both flushes complete.
const c = new SqliteStateStore({ path: "/tmp/shared.sqlite" });
// Last-write-wins guarantee: c sees EITHER 1 (race lost prior to read) OR
// the second writer's value. The contract does NOT promise A+B sum (2);
// that requires read-modify-write with conflict retry — see § Read-modify-
// write pattern.
const seen = c.get("invocations") as number;
expect(seen === 1 || seen === 2).toBe(true);
```

Different stores satisfy this guarantee through different mechanisms:

- `MemoryStore` satisfies it vacuously — there is no "concurrent instance against the same backing storage" because the storage IS the instance. Two `MemoryStore`s are two unrelated stores.
- `SqliteStateStore` (M2.1) uses SQLite's WAL mode + busy-timeout retries to serialize writes.
- `TmpdirStore` does NOT satisfy this guarantee — see § Per-store guarantees.

### Guarantee 4: No multi-key transactions

The contract DOES NOT provide multi-key atomicity, compare-and-swap, or transactional semantics. A single key's read-modify-write is the CONSUMER's problem to solve compositionally — usually via the retry-on-conflict pattern documented in § Read-modify-write pattern. There is no `state.transaction(() => { ... })` API.

**Why it matters.** Multi-key transactions are expensive to implement portably (every backing store has different transaction semantics; SQLite has BEGIN/COMMIT, Redis has MULTI/EXEC, an in-memory `Map` has nothing) and most `stateful()` rules don't need them. The 1.0 contract scopes to the minimum every store can honour cheaply; consumers who need cross-key atomicity can either compose retry-on-conflict, or back state with a custom store that exposes the underlying transaction API directly.

**Worked example.** A rule that needs to atomically update two keys cannot do it with `StateStore` alone:

```ts
// UNSAFE under concurrent stores: there is no atomic "update both" primitive.
stateful("counter-and-history", (event, state) => {
  const count = ((state.get("count") as number | undefined) ?? 0) + 1;
  const history = (state.get("history") as string[] | undefined) ?? [];
  history.push(event.toolName);
  state.set("count", count);   // (1)
  state.set("history", history); // (2)
  // A concurrent store between (1) and (2) might write its own count, then
  // its own history, leaving the two keys disagreeing about which event
  // came last. The contract does NOT prevent this.
  return null;
});
```

The safe shape: use a single composite key (`"counter:history"` holding `{ count, history }`) so the single-key atomicity guarantee covers the bundle; OR back state with a custom store that exposes the transaction primitive your domain requires.

## Read-modify-write pattern

`get → mutate → set` against the same key is the canonical `stateful()` shape. Under concurrent stores (Guarantee 3), two callers reading the same value, mutating, and writing back can both win — the last one's write overwrites the first. This is the "lost-update problem"; the contract does NOT solve it for you. Consumers compose the solution via retry-on-conflict.

### Safe pattern: retry-on-conflict

The right shape for read-modify-write on a single key is: read, mutate, set, then re-read to detect overlap; on overlap, retry with the fresh value. Pseudo-code:

```ts
stateful("rm-counter", async (event, state) => {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const prior = (state.get("rm:count") as number | undefined) ?? 0;
    const next = prior + 1;
    state.set("rm:count", next);
    await state.flush();
    // Re-read to detect concurrent overwrite. If we still see our `next`,
    // we won the race. If we see something else, another store overwrote
    // our set after our flush — retry against the fresh value.
    const observed = state.get("rm:count") as number | undefined;
    if (observed === next) {
      return next > MAX_DELETES ? deny(`quota exceeded`) : warning(`rm #${String(next)}`);
    }
    // Else: another store interleaved between our set and re-read. Loop.
  }
  // All retries exhausted: another store is dominating the key. Bail.
  return warning("rm-counter: contention timeout, decision deferred");
});
```

The retry budget is a consumer choice — three attempts is a reasonable default for low-contention single-agent workflows; higher contention warrants a custom store with a real CAS primitive.

For single-process work (e.g., a `MemoryStore` or a `TmpdirStore` honoured per its single-process design), retry is unnecessary — there is no concurrent store to race against. The pattern is required only when the backing storage is genuinely shared.

### Unsafe pattern: bare get + set

The pattern to AVOID — bare `get` then `set` without re-read or retry:

```ts
// UNSAFE under concurrent stores — last write silently wins.
stateful("rm-counter-broken", (event, state) => {
  const prior = (state.get("rm:count") as number | undefined) ?? 0;
  state.set("rm:count", prior + 1);
  return null;
  // Two concurrent stores both read prior=5, both write 6. One increment
  // is lost. The deny-vs-warn decision for the LOST increment never
  // fires. No error surfaces; the count silently undercounts.
});
```

Both stores returned, both wrote, neither failed — the contract does not signal contention. The lost increment is a silent data loss bug; the retry-on-conflict pattern above is the consumer's only defence against it under concurrent stores.

### When retry doesn't suffice — pick the right store

Retry-on-conflict has limits. Under high contention (many concurrent writers, tight retry budget), retries fail more often than they succeed and the consumer is left with a partial answer. If your `stateful()` rules need real cross-key transactions, true compare-and-swap, or guaranteed convergence under contention, a custom `StateStore` backed by a database with the right primitives is the answer — not retry on top of `StateStore`. The 1.0 contract intentionally scopes to the floor every store can honour; everything above the floor is consumer composition.

See [`docs/SPEC.md`](./SPEC.md) § Operational Readiness for the broader 0-silent-fails policy: state-store failures surface as `error` annotations through the engine's fail-open boundary. The contract violation here (lost updates from bare get+set) is NOT detected by hook-kit — it is silent data loss in the consumer's rule logic, and only the consumer can detect or prevent it.

## Per-store guarantees

Each shipped implementation honours different subsets of the contract. The table is the per-store map of contract conformance:

| Store | Atomicity | Flush durability | Concurrent stores | Multi-process | Windows |
|---|---|---|---|---|---|
| `MemoryStore` | Yes | n/a (in-memory only) | n/a (no shared backing storage) | No | Yes (any platform Bun runs on) |
| `TmpdirStore` | Yes | Yes (JSON write on flush) | **No** (single-process by design; warns on violation) | No | Yes (filesystem path semantics work on Windows) |
| `SqliteStateStore` (M2.1) | Planned: yes | Planned: yes (WAL fsync) | Planned: yes (SQLite WAL + busy-timeout) | Planned: yes | Planned per M2.1 |

`MemoryStore` is the test default and the right pick for stateless hooks. `TmpdirStore` is the production default for single-agent runs — file path encodes the session, no cross-process coordination needed. For multi-process work (parallel CI runners against shared state, daemon-style broker accumulating counters across sessions), the intended choice is `SqliteStateStore` (lands in M2.1); until then, consumers needing multi-process semantics must author a custom `StateStore` that satisfies the concurrent-stores guarantee.

### MemoryStore — single-process trivially

Single-process scope makes the contract trivially satisfied. Each instance owns its own `Map<string, unknown>`; there is no shared backing storage to coordinate against. Atomicity holds because `Map.set` and `Map.delete` are single-statement operations; flush durability is moot (no persistence); concurrent stores does not apply (two `MemoryStore`s do not share state). Use it freely in tests and for hooks where persistence across invocations doesn't matter. See class JSDoc in [`src/state/memory-store.ts`](../src/state/memory-store.ts).

### TmpdirStore — single-process by design

`TmpdirStore` loads the JSON file on construction and flushes it on demand. Single-instance use within one process satisfies atomicity and flush durability — the in-memory `Map` is the working set, the file is the persistence. The contract violation arises ONLY when two `TmpdirStore` instances open the same file path concurrently (whether in the same process or across processes): both load the file, both mutate their in-memory `Map`s, both flush — the second flush's `writeFileSync` overwrites the first's. Lost-update, silently.

The implementation emits a `console.warn` once when a second instance opens a path that another `TmpdirStore` instance has already opened in the same process. Same-process detection only — cross-process violation cannot be reliably detected from within a single process and is the contract violation we explicitly call out: if you see the warning, switch to `SqliteStateStore` (when M2.1 ships) or accept last-write-wins semantics. See class JSDoc in [`src/state/tmpdir-store.ts`](../src/state/tmpdir-store.ts) and `docs/decisions/tmpdir-store-decision.md` for the design rationale.

### SqliteStateStore — production multi-process

Planned for M2.1. SQLite's WAL mode + busy-timeout retries serialize concurrent writes; full ACID per the SQLite contract. Will be the recommended default for any consumer scenario requiring concurrent stores. Until it ships, multi-process work needs a custom `StateStore` backed by the consumer's preferred database — the contract is portable; the implementation is the choice.

## Cross-references

- [`src/core/types.ts`](../src/core/types.ts) — the canonical `StateStore` interface declaration with the JSDoc contract summary.
- [`docs/SPEC.md`](./SPEC.md) § State Management — where the engine's flush-on-evaluate behaviour and the `error`-annotation fail-open boundary live.
- [`docs/SPEC.md`](./SPEC.md) § Operational Readiness — the 0-silent-fails policy state-store failures route through.
- [`docs/decisions/tmpdir-store-decision.md`](./decisions/tmpdir-store-decision.md) — the M1.5 design decision recording why `TmpdirStore` stays single-process rather than gaining file-locking.
- [`docs/STABILITY.md`](./STABILITY.md) — `StateStore`, `MemoryStore`, `TmpdirStore` are STABLE; breaking changes follow the deprecation cycle.
