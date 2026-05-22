# hook-kit adapter template

A minimal, fork-and-modify scaffold for authoring a custom `ProtocolAdapter`. This is **not** a real adapter. It is the skeleton you copy when bridging a new harness (Cursor, Cline, MCP, your own daemon, a future agent runtime) into hook-kit's engine.

The full contract for what an adapter must do is in [`docs/ADAPTERS.md`](../../docs/ADAPTERS.md) at the repository root. Read it first. This template demonstrates a working implementation of that contract; the contract itself is the canonical reference.

## What this template demonstrates

- A custom `ProtocolAdapter` factory (`createMyAdapter`) — three methods, ~150 lines, dependency-injected `stdin` / `stdout` / `stderr` / `exit` so the adapter is testable without spawning a process.
- A binary entry (`src/main.ts`) wiring `process.*` into the factory and dispatching through `run(modules, adapter, opts)` — the canonical engine entry point. The named export `hooks` from `./hooks.ts` carries the module array (per the project's biome `noDefaultExport` rule).
- An optional `DecisionObserver` wired from an environment variable (`TEMPLATE_OBSERVER_LOG`) so the binary appends one JSONL record per decision to a file. Consumers swap the appender for syslog / OTLP / HEC / custom transport.
- A build script (`build.ts`) invoking `bun build --compile --bytecode` directly — **not** `hook-kit build`, which only knows the canonical `shell` and `cc-tools` adapter modes. A custom adapter is by definition outside that table; the template ships its own build invocation.
- In-process unit tests (`tests/my-adapter.test.ts`) using the injected-streams factory shape.
- A compiled-binary e2e suite (in the repo root at `tests/build/adapter-template-e2e.test.ts`) that validates the wire-format contract end-to-end against the produced binary.

The demo rules in `src/hooks.ts` are **stubs**, clearly labeled. They exist so the e2e test can exercise each row of the output-convention table (deny / ask / clean / annotation-only). Replace them with your own composition of `cmd()` / `path()` / `pipe()` / `redirect()` / `content()` / `custom()` / `stateful()` primitives — see `examples/ai-guardrails/` for a real rule set.

## Fork this

```bash
cp -r examples/adapter-template/ examples/my-custom-adapter/
cd examples/my-custom-adapter/
# Then edit per "What to change" below.
```

The template lives under `examples/` in the hook-kit repo so the existing root `tsconfig.json` / `bun.lock` / test infrastructure cover it during dev. When forking into a separate repository, you also need to:

- Switch the `"@questi0nm4rk/hook-kit": "*"` dependency to a real published version.
- Install with `bun install` to populate `node_modules/`.
- Ship a `tsconfig.json` if you do not have one (use the root `tsconfig.json` as a starting point; the `strict` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` flags catch real bugs and are worth keeping).

## What to change

When bridging a new harness, modify these files in order:

1. **`src/parse-input.ts`** — change `MyHarnessInput` and `parseInput` to match your harness's wire format. The output of `parseInput` is a `HookEvent` with seven required fields (see `docs/ADAPTERS.md` § Contract); the input shape on the wire is whatever your harness speaks. If your harness pipes JSON over stdin, the shape of `parseInput` is close to what you need — change the field names. If your harness speaks over a Unix socket / TCP / MCP RPC, you may also need to swap `readAllStdin` in `src/my-adapter.ts` for the appropriate read primitive. The file is intentionally narrow — wire-format logic lives here, adapter glue lives in `my-adapter.ts`.
2. **`src/my-adapter.ts`** — adjust `emitOutcome` if your harness expects a different wire format on the output side. The template renders the shell-wrapper convention from `docs/ADAPTERS.md` § Output convention (deny=stderr+exit2, ask=stdout+exit1, annotation-only=stdout+exit0, clean=silent+exit0). A different harness might want a structured JSON response on stdout instead — change the writes. The merge policy is already applied by the engine; do not re-implement it.
3. **`src/hooks.ts`** — replace the stub demo rules with your real rule set. The template ships three rules (destructive-rm deny, force-push ask, no-rf warning) that exist purely so the e2e test can exercise all four wire-format cases.
4. **`src/main.ts`** — if you do not want an observer wired, delete `buildObserverFromEnv()` and remove the `observers` option from the `run()` call. If you want a different observability transport, replace the `appendFileSync` body with your sink (syslog, an HTTP endpoint, an OpenTelemetry exporter, etc.). The observer interface is `DecisionObserver.onDecision(record: DecisionEventRecord): void` — sync, never throws (the engine catches and surfaces as `error` annotations).
5. **`tests/my-adapter.test.ts`** — adjust the input fixtures to match your new `MyHarnessInput` shape. Keep the test cases (readInput happy path + failure modes, writeOutput per-outcome, handleError totality) — these are the right cases for any adapter.
6. **`build.ts`** — likely no changes needed; the script invokes `bun build --compile --bytecode` on `src/main.ts`. If you renamed `main.ts`, update the path.
7. **`package.json`** — change `name`, `description`, and any scripts you need.

## Testing

```bash
# In-process unit tests (fast — no binary compile).
bun test tests/

# Build the binary.
bun run build

# Manual smoke test against the built binary.
echo '{"event":"PreToolUse","session":"s1","cwd":"/tmp","transcript":"/tmp/t.jsonl","tool":"Bash","input":{"command":"rm -rf /tmp/x"}}' | dist/hk-template
# -> "[template-demo] denied: destructive rm -rf" on stderr, exit 2.

# Compiled-binary e2e tests live in the repo root, not in this directory.
# They validate the full wire-format contract end-to-end.
bun test tests/build/adapter-template-e2e.test.ts
```

When forking into a separate repository, replicate the compiled-binary e2e tests in your own `tests/` directory. They are the only mechanism that exercises your adapter through `bun build --compile --bytecode` — unit tests catch logic bugs in the factory; only the e2e catches binary-mode regressions (bundling, import resolution, top-level-await rejection, etc.).

## Wiring into harness X

`run(modules, adapter, opts)` is the canonical adapter entry point. It calls `adapter.readInput()` → `evaluate(event, modules, opts)` → `adapter.writeOutput(outcome, event)` on the happy path, or `adapter.handleError(error)` if any of those three steps throws. The adapter does not need to coordinate the flow; it just owns the three methods.

Per `docs/ADAPTERS.md` § Anti-patterns:

- **Do not mutate the `EvaluationOutcome`.** The engine has already committed the decision and applied the merge policy.
- **Do not catch and swallow errors.** Every adapter failure must surface. The only acceptable swallow is inside `handleError` when a stderr write fails (nothing left to try).
- **Do not parse adapter stdout to re-extract decision data.** Use the `DecisionObserver` API instead — that is what it is for.
- **Do not maintain state across `readInput → writeOutput` cycles.** One adapter instance per process; cross-process state belongs in the engine's `StateStore`.
- **Do not assume `event.toolName === "Bash"`.** Non-Bash events flow through the same interface.

### Observer contract

The optional `TEMPLATE_OBSERVER_LOG` environment variable demonstrates the canonical observability hook. When set, `main.ts` constructs a `DecisionObserver` that appends one JSONL `DecisionEventRecord` per decision (terminal `deny`/`ask` + annotation `warning`/`note`/`error`) to the file. The record shape is documented in `docs/SPEC.md` § Observability; `toolInput` itself is NOT logged (only its sha256 hash), so secrets in command lines do not leak into observability sinks by default.

When forking, replace the environment-variable contract with whatever your operator-config story is. The `buildObserverFromEnv()` function is the seam — return `undefined` to keep the zero-overhead default path, or any `DecisionObserver` instance to wire your sink.

### Wire format

The template renders the shell-wrapper convention. The full table is in `docs/ADAPTERS.md` § Output convention, but the four rows are:

- **deny** → exit 2, `<prefix> denied: <reason>` on stderr, stdout empty.
- **ask** → exit 1, `<prefix> needs review: <reason>` on stdout, stderr empty.
- **annotation-only** → exit 0, `<prefix> warning: <msg>` / `<prefix> note: <msg>` on stdout per annotation.
- **clean** (no terminal, no annotations) → exit 0, no output.

`<prefix>` is the decision's `label` if the rule set one (e.g. `[my-plugin]` from `cmd("rm").deny("reason", "[my-plugin]")`), or the adapter's `MyAdapterOptions.label` default (`[template-demo]` here) otherwise.

`error` annotations always surface to stderr regardless of terminal — they describe hook-infra failures (rule throws, observer throws, shell-ast WASM failures), not rule output. The engine appends them to `outcome.annotations` even when a deny otherwise drops `warning`/`note` annotations.

## See also

- [`docs/ADAPTERS.md`](../../docs/ADAPTERS.md) — the canonical contract for `ProtocolAdapter`.
- [`docs/SPEC.md`](../../docs/SPEC.md) § Observability — the `DecisionObserver` contract.
- [`src/adapters/raw.ts`](../../src/adapters/raw.ts) — minimal library-mode reference.
- [`src/adapters/claude-code.ts`](../../src/adapters/claude-code.ts) — production-grade reference for the Claude Code harness.
- [`examples/ai-guardrails/`](../ai-guardrails/) — full rule-set example (uses the canonical `shell` and `cc-tools` adapters, not a custom one).
