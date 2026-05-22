# Adapters — protocol contract for hook-kit

An adapter bridges a harness's event stream into hook-kit's engine. The harness (Claude Code, Cursor, Cline, an MCP server, a future agent runtime, your own daemon) speaks whatever wire format it speaks; the engine speaks `HookEvent` in and `EvaluationOutcome` out. The adapter is the 3-method translation layer between them.

This document is the source of truth for that translation. Read it before authoring a new adapter (Cursor / Cline / MCP / custom); read it before changing the existing adapters (`src/adapters/claude-code.ts`, `src/adapters/raw.ts`). It complements `docs/SPEC.md` § Adapter Bins, which describes WHAT adapters ship; this file describes HOW one is correctly written.

The contract is `@stable @since 1.0.0` per [`docs/STABILITY.md`](./STABILITY.md). Breaking changes go through the deprecation cycle.

## Contract

`ProtocolAdapter` is the three-method interface in [`src/adapters/types.ts`](../src/adapters/types.ts):

```ts
export interface ProtocolAdapter {
  readInput(): Promise<HookEvent>;
  writeOutput(outcome: EvaluationOutcome, event: HookEvent): Promise<void> | void;
  handleError(error: unknown): Promise<void> | void;
}
```

Reference implementations:

- [`src/adapters/claude-code.ts`](../src/adapters/claude-code.ts) — production, exits the process from `writeOutput` / `handleError`.
- [`src/adapters/raw.ts`](../src/adapters/raw.ts) — library / test mode, captures the outcome on an in-memory `state` object instead of exiting.

The engine entrypoint `run(modules, adapter, opts?)` wires the three calls together: `readInput` → `evaluate(event, modules, opts)` → `writeOutput(outcome, event)` on the happy path, or `handleError(err)` on any throw.

### `readInput(): Promise<HookEvent>`

Read one event from the harness's input channel, parse it, and return a `HookEvent`.

**When invoked.** Once per process, at the start of `run()`. The engine does not loop or re-invoke; one adapter instance handles one event then exits.

**Input contract.** Whatever the harness provides. The CC adapter reads all of stdin (a single JSON object) and parses it through a Zod schema. A Cursor adapter might read from a Unix socket; an MCP adapter might `await message.params`. The shape of the wire input is harness-specific; the shape of the parsed return is fixed.

**Output contract.** A `HookEvent` (defined in [`src/core/types.ts`](../src/core/types.ts)):

```ts
interface HookEvent {
  readonly eventName: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}
```

All seven fields are required. `eventName` is the harness's lifecycle name (`"PreToolUse"`, `"PostToolUse"`, `"SessionStart"`, …). `toolName` is the tool channel (`"Bash"`, `"Edit"`, `"Write"`, `"Read"`, …). `toolInput` carries the tool-specific payload (e.g. `{ command: "..." }` for Bash, `{ file_path: "...", content: "..." }` for Write). `raw` is the original parsed input object so consumer rules can read extra fields the harness layered on top of the documented schema.

**Error handling.** Throw on malformed input. The engine catches the throw and routes to `handleError`. Do NOT return a synthetic / empty `HookEvent` to signal "bad input" — that hides the failure from observability and violates the zero-silent-fails contract. See § Error handling below.

**Worked example.** A minimal raw-stdio adapter for a harness that pipes one line of NDJSON per event:

```ts
async function readInput(): Promise<HookEvent> {
  const line = await readOneLine(process.stdin);
  if (line.trim() === "") {
    throw new Error("[my-adapter] empty stdin");
  }
  const parsed = z
    .object({
      event: z.string(),
      session: z.string(),
      cwd: z.string(),
      transcript: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(line));
  return {
    eventName: parsed.event,
    sessionId: parsed.session,
    cwd: parsed.cwd,
    transcriptPath: parsed.transcript,
    toolName: parsed.tool,
    toolInput: parsed.input,
    raw: JSON.parse(line) as Readonly<Record<string, unknown>>,
  };
}
```

### `writeOutput(outcome: EvaluationOutcome, event: HookEvent): Promise<void> | void`

Serialize an `EvaluationOutcome` to whatever output channel the harness expects.

**When invoked.** Once per process, after `evaluate()` returns with no engine throw. Always called with the engine's committed decision — the adapter does not re-run the engine.

**Input contract.** Two values:

- `outcome: EvaluationOutcome` — `{ terminal: Terminal | null, annotations: readonly Annotation[] }`. `terminal` is either a `deny` / `ask` decision or `null` (no terminal opinion). `annotations` is an in-order list of `warning` / `note` / `error` annotations the engine accumulated; the merge policy has already been applied.
- `event: HookEvent` — the same event `readInput` returned. The engine threads it through so the adapter can route on `eventName` / `toolName` (the CC adapter uses `eventName` to choose between `permissionDecision: "block"` JSON and the stderr-exit-2 fallback for non-PreToolUse events).

**Output contract.** Translate the outcome to the harness's wire format and emit it. For the shell-wrapper default, the wire format is the stdout/stderr/exit-code table in § Output convention below. For the CC adapter, the wire format is CC's `hookSpecificOutput` JSON. For your adapter, document what you emit and stick to it.

The return type is `Promise<void> | void`. The CC adapter `process.exit`s after writing, so its return is "never" at runtime — the type still permits a normal return so library / test adapters (like `raw`) can record the outcome and let the caller proceed.

**Error handling.** A throw from `writeOutput` is a security-boundary failure (the adapter cannot deliver the decision to the harness). Surface to stderr and exit non-zero. Do not swallow. See § Error handling.

**Worked example.** Continuing the raw-stdio example, writing the shell-wrapper convention to stdout/stderr:

```ts
async function writeOutput(outcome: EvaluationOutcome, _event: HookEvent): Promise<void> {
  const { terminal, annotations } = outcome;
  const errors = annotations.filter((a) => a.kind === "error");
  for (const e of errors) {
    process.stderr.write(`[my-adapter] error: ${e.errorCode}: ${e.message}\n`);
  }
  if (terminal?.kind === "deny") {
    process.stderr.write(`[my-adapter] denied: ${terminal.reason}\n`);
    process.exit(2);
  }
  if (terminal?.kind === "ask") {
    process.stdout.write(`[my-adapter] needs review: ${terminal.reason}\n`);
    process.exit(1);
  }
  for (const a of annotations) {
    if (a.kind === "warning" || a.kind === "note") {
      process.stdout.write(`[my-adapter] ${a.kind}: ${a.message}\n`);
    }
  }
  process.exit(0);
}
```

### `handleError(error: unknown): Promise<void> | void`

Top-level error handler. Invoked when `readInput`, `evaluate`, or `writeOutput` throws something the engine did not catch and convert to an `error` annotation.

**When invoked.** Once, replacing the normal `readInput → evaluate → writeOutput` flow. The engine never invokes both `writeOutput` and `handleError` for the same event — they are alternative terminal paths.

**Input contract.** A single `unknown` — typically an `Error` (or a `HookKitError` subclass), but the type is `unknown` because user code in the engine's call graph can throw anything.

**Output contract.** Emit something useful to the operator and exit. The CC adapter follows Iron Law 4 ("never crash, never block") and `process.exit(0)` silently — a hook that crashes should not also block the user's command. A different harness might prefer to surface the failure (stderr + exit non-zero) so its CI catches it. Document the choice in your adapter's header comment.

**Error handling.** `handleError` itself MUST NOT throw. If it does, the engine has no further recovery path and the harness sees an uncontrolled crash. Wrap any I/O inside the handler in a `try { ... } catch { ... }` that at worst writes nothing and exits.

**Worked example.**

```ts
function handleError(error: unknown): void {
  const msg = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[my-adapter] fatal: ${msg}\n`);
  } catch {
    // stderr write failed; nothing left to try.
  }
  process.exit(2);
}
```

## Output convention

The shell-wrapper convention is the contract every adapter that targets a wrapper-shaped channel (one stdin, one stdout, one stderr, one exit code) reproduces. Non-wrapper-shaped harnesses (CC's JSON channel, MCP elicitation, etc.) translate from this same `EvaluationOutcome` to their own wire format — but the same merge-policy rules apply.

| Outcome | Exit | Stream | Content |
|---|---|---|---|
| no terminal, no annotations | 0 | — | silent, then exec the command verbatim |
| no terminal, annotations only | exec's exit | stdout | `<prefix> warning: <msg>` / `<prefix> note: <msg>` per annotation, then `---` separator, then exec output below |
| `ask` (annotations bundled) | 1 | stdout | `<prefix> needs review: <reason>` + each accumulated annotation line |
| `deny` (annotations DROPPED) | 2 | stderr | `<prefix> denied: <reason>` |

`<prefix>` is the decision's label when set (e.g. `[my-plugin]` from `cmd("rm").deny("reason", { label: "[my-plugin]" })`), `[hook-kit]` otherwise. Adapters MUST preserve the label end-to-end; it is the consumer's source-attribution signal.

**Merge policy summary** (engine-side, before `writeOutput` sees the outcome):

- `deny` short-circuits the merge loop and DROPS accumulated `warning` / `note` annotations. `error` annotations always survive — they describe hook-infra failures, not rule output, and stay visible regardless of terminal.
- `ask` keeps the loop running so annotations continue to accumulate. The first `ask` wins terminal; later `ask` decisions are dropped (they still fire observers — see SPEC § Observability — but do not change the outcome).
- `warning` / `note` always stack, in the order rules emit them.

This matches the policy documented in `src/core/types.ts` comments and `docs/SPEC.md` § Engine. The adapter does not re-implement merge; it consumes the already-merged `EvaluationOutcome`.

## Error handling

hook-kit's [zero-silent-fails policy](./SPEC.md#operational-readiness) requires every internal failure path to surface a typed error. Adapters participate by NOT swallowing exceptions and by routing engine-emitted `error` annotations to a visible channel (stderr).

### Typed errors

The 10 `HookKitError` subclasses live in [`src/core/errors.ts`](../src/core/errors.ts). Each carries a stable `code` field (`HookKitErrorCode`) that observers and adapter-side log shippers can route on without doing `instanceof` checks. An adapter generally does not construct these directly — the engine and its primitives raise them. An adapter encounters them when an `error` annotation arrives on `outcome.annotations`, and surfaces them via stderr or its observability channel.

- `FileReadError` — filesystem read failed. Engine boundary, fail-open: rule contributes no decision, error annotation surfaces.
- `FileWriteError` — filesystem write / remove failed. Includes state-store persistence failures; the in-process value is set, only persistence is lost.
- `JsonParseError` — `JSON.parse` failed on a file hook-kit controls (state store, listener metadata, audit log).
- `EnvelopeValidationError` — Zod schema validation failed on a broker / askpass IPC envelope. Security boundary, fail-CLOSED: synthesizes a deny alongside the error annotation.
- `ProtocolVersionError` — broker / askpass envelope arrived with an unrecognized `version` literal (does not match `PROTOCOL_VERSION`). More specific than `EnvelopeValidationError` — lets observability layers route version skew separately from generic shape errors. Security boundary, fail-CLOSED.
- `ShellAstParseError` — shell-ast parser / WASM runtime failure on a command input. Malformed user input is NOT wrapped — that stays silent (bash will reject it).
- `ProcessSpawnError` — `Bun.spawn` or process-control failure (askpass invocation, git enrichment).
- `RuleEvaluationError` — a rule's `evaluate()` threw something other than a `HookKitError`. The rule has a bug; the engine catches and surfaces.
- `StateStoreError` — state-store `get` / `set` / `flush` / `delete` failed on backing storage.
- `ObserverError` — a `DecisionObserver.onDecision` callback threw. Observer boundary, fail-open: engine catches, surfaces as `error` annotation, decision and subsequent observers proceed.

Adapter responsibility: when an `error` annotation appears in `outcome.annotations`, surface it. Do not filter or hide. The CC adapter routes them to stderr (out of CC's `additionalContext` / askpass envelope) because they are hook-infra failures, not rule output the agent should see.

### Fail-open vs fail-closed

Two boundaries, two policies:

- **Engine boundary** (rule throws, observer throws, `state.flush()` fails, shell-ast WASM fails to parse) — **fail-open.** The engine catches the throw, appends an `error` annotation to `outcome.annotations`, and proceeds. The decision the engine had already accumulated is preserved; no terminal is synthesized. Rationale: a buggy rule should not block the user's command.
- **Security boundary** (askpass IPC envelope fails Zod validation, broker reply is unparseable, askpass binary exits non-zero) — **fail-closed.** The engine synthesizes a `deny` with an error reason alongside the `error` annotation. Rationale: an `ask` decision exists precisely because the rule wanted human review; if the review channel is broken, denying is the safe default.

The adapter does NOT decide which boundary applies — the engine and the escalation infrastructure do. The adapter's job is to faithfully render whatever `EvaluationOutcome` arrives, including any synthesized deny.

### What the adapter MUST do

- **Surface every error.** `error` annotations go to stderr (or the harness's structured-error channel). Do not drop them.
- **Throw on bad input.** If `readInput` cannot parse the harness's payload, throw. The engine routes the throw to `handleError`. Do not return a synthetic event.
- **Exit non-zero on `writeOutput` failure.** If the output channel breaks (stdout pipe closed, JSON encoding throws), write a stderr error line and `process.exit` with non-zero. The harness's CI / logs see the failure.
- **Make `handleError` total.** It must not throw. Wrap I/O inside it; a stderr write failure is the only acceptable swallow.

### What the adapter MUST NOT do

See § Anti-patterns below.

## Anti-patterns

### DON'T mutate the `EvaluationOutcome`

The outcome is the engine's committed decision. Adapter-side mutation (`outcome.terminal = null` to "soften" a deny, `outcome.annotations.push(...)` to inject your own) hides the engine's actual verdict from observability and breaks the merge contract. If you need to add context, do it at the wire-format stage (e.g. concatenate to the stderr line you emit) without changing the outcome object.

### DON'T catch and swallow errors

Every adapter failure must surface. `try { ... } catch { }` and `?? undefined` patterns hide failures from the harness's logs and CI. The only acceptable swallow is inside `handleError` itself, and only when a stderr write fails (nothing left to try). See [`docs/SPEC.md`](./SPEC.md) § Operational Readiness for the zero-silent-fails policy this enforces.

### DON'T parse adapter stdout to re-extract decision data

If your code needs the engine's decision programmatically (audit log, metrics sink, structured replay), use the `DecisionObserver` API documented in [`docs/SPEC.md`](./SPEC.md) § Observability. Wrapper stdout / harness JSON is for HUMANS (and the harness UI that renders it); the observer is the supported programmatic channel.

### DON'T maintain state across `readInput → writeOutput` cycles

An adapter handles one event per process; instance fields that try to remember "the previous decision" are pointless at best and a leak vector at worst. State that should persist between invocations belongs in the engine's `StateStore` (tmpdir-store for cross-process persistence, custom stores for shared backends).

### DON'T assume `event.toolName === "Bash"`

The contract supports arbitrary tool channels. Non-Bash events (`Edit`, `Write`, `NotebookEdit`, `Read`, or future tool names from any harness) flow through the same interface. Branching on `toolName` is fine; failing on anything-but-Bash is not. The CC adapter's `denyOutput` branches on `eventName` (PreToolUse vs everything else) but never gates on `toolName` — match that shape.

### DON'T mix adapter responsibilities with rule logic

Adapters translate between wire formats and the engine's `HookEvent` / `EvaluationOutcome` shapes. They do not inspect command content, evaluate policy, or short-circuit decisions. If you find yourself reading `event.toolInput.command` inside an adapter, you are writing a rule — move it to a `HookModule` and let the engine evaluate it.

### DON'T `process.exit` from `readInput`

`readInput` returns through `Promise<HookEvent>`. Exiting from inside `readInput` denies the engine the chance to route the failure to `handleError`. Throw instead; the engine will dispatch correctly.
