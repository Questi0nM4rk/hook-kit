# TmpdirStore concurrency strategy — design decision

**Status:** Decided (2026-05-22, M1.5).
**Decision:** **Option B — demote.** `TmpdirStore` stays single-process by design; adds a same-process runtime warning when a second instance opens an already-open path; updates documentation to point multi-process work at `SqliteStateStore` (M2.1).

## Context

M1.5's `StateStore` contract (see [`docs/STATE.md`](../STATE.md)) enumerates four guarantees: atomicity, flush durability, concurrent stores, and no multi-key transactions. `TmpdirStore` (the shipped JSON-file-backed store at `src/state/tmpdir-store.ts`) honours atomicity and flush durability per-instance, but does NOT honour concurrent stores: two `TmpdirStore` instances opened against the same file path concurrently silently lose the first's writes when the second flushes.

The decision: either upgrade `TmpdirStore` to honour the concurrent-stores guarantee (via OS-level file locking) OR demote it to single-process-only with explicit runtime + doc signalling.

## Options

### Option A — Upgrade with file locking

Add `flock`-based locking (Linux/macOS) on every `set` / `delete` / `flush` so concurrent instances serialise their writes; the contract's concurrent-stores guarantee is then honoured. Tests would spawn 4 child processes writing distinct keys, then assert no torn reads and final state correctness.

**Costs:**

- Multi-process file locking diverges across OSes. POSIX `flock(2)` (Linux/macOS/BSD) is advisory and process-scoped; Windows has no `flock` and would need `LockFileEx` or a custom lockfile-on-disk shim. Node's `fs.flock` doesn't exist; Bun's filesystem API doesn't expose `flock` either — implementation would shell out to a system `flock(1)` binary or use a native binding.
- Adds an OS dependency (`flock(1)` is present on most Linux/macOS systems but not guaranteed).
- Lock contention under high parallelism would degrade `set`/`delete`/`flush` latency in ways the current single-process design avoids.
- The implementation is a temporary measure: `SqliteStateStore` (M2.1) is the principled multi-process answer, and SQLite's WAL mode handles concurrency far better than any JSON-file + lock construction. Investing in the JSON+flock route means maintaining it forever (cost) for the case where consumers haven't migrated to SQLite (rare; they should migrate).

### Option B — Demote with runtime warning + doc

Keep `TmpdirStore` single-process by design. Add a runtime warning when more than one instance opens the same file path within one process (same-process detection only — cross-process violation isn't reliably detectable without locking, which is exactly what we're declining to do). Document the constraint in class JSDoc, in `docs/STATE.md` § Per-store guarantees, and point readers at `SqliteStateStore` (M2.1) or a custom store for multi-process work.

**Costs:**

- Multi-process work cannot use `TmpdirStore`. Consumers who tried it silently would get last-write-wins; the runtime warning surfaces the misuse same-process, but cross-process misuse stays silent until they read this doc.
- A short window exists between "M1.5 ships" and "M2.1 ships SqliteStateStore" where consumers wanting multi-process work must author a custom store.

## Decision

**Option B (demote).** Rationale:

1. **Multi-process file locking is non-trivial on Windows.** POSIX `flock(2)` doesn't exist there; the implementation would diverge (LockFileEx on Windows, flock on POSIX) or fall back to a custom lockfile-on-disk shim with its own atomicity surface. The complexity is real and the maintenance is forever.
2. **`SqliteStateStore` (M2.1) is the principled answer.** WAL mode + busy-timeout retries solve the concurrent-stores guarantee correctly, with ACID semantics SQLite already proves. Investing in file locking on JSON would be temporary infrastructure shipped to bridge a gap M2.1 closes.
3. **Current `TmpdirStore` usage is single-process by construction.** The file path encodes `namespace + sessionId`; each session has its own file. Multi-process is not a feature anyone is currently relying on — making it an explicit non-feature with a runtime warning costs almost nothing.
4. **Discovery cost: silent corruption vs visible warning.** Today, two `TmpdirStore` instances on the same path lose data silently. After Option B, the same scenario emits a `console.warn` once — a downstream consumer hitting it has a signal pointing them at the right answer. Silent corruption is the alternative the runtime warning prevents.

## Action items

Per Option B:

- **TASK-049 (this batch):** add same-process detection via a module-level `Map<string, Set<TmpdirStore>>` of open paths. Emit a `console.warn` once when a second instance opens an already-open path. Update class JSDoc on `TmpdirStore` to enumerate the contract scope. Update `docs/STATE.md` § Per-store guarantees table — already reflects Option B in the M1.5 commit landing the doc.
- **TASK-048 (skipped):** no file-locking implementation lands.
- **Follow-up (M2.1):** when `SqliteStateStore` ships, link to it from `TmpdirStore`'s warning text + class JSDoc as the recommended migration path.

## Trade-offs accepted

- Cross-process misuse stays silent. Documented in `docs/STATE.md` and in the class JSDoc; not detected at runtime. Acceptable because (a) detection requires locking and (b) the only consumers in a position to hit cross-process misuse are those explicitly running parallel processes against the same path — they should be reading the contract before doing so.
- The runtime warning fires only once per `(path, process)` pair to avoid log spam under tight retry loops. The first sighting is the signal; repeated sightings would be noise.
- The runtime warning uses `console.warn` rather than a typed `HookKitError`. The hook-kit zero-silent-fails policy (`docs/SPEC.md` § Operational Readiness) requires typed errors for INTERNAL FAILURES of hook-kit's own code paths; this warning is a CONSUMER USAGE signal, not an internal failure. `console.warn` is the right channel.
