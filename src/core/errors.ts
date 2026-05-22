/**
 * Typed errors for hook-kit. Every internal failure path constructs one of
 * these so it can be caught at the engine boundary, surfaced as an `error`
 * annotation in the EvaluationOutcome, and rendered to stderr by the wrapper.
 *
 * Per-site policy:
 *   - Engine boundary (rule eval, content read, state read, AST parse) →
 *     fail OPEN: append error annotation, preserve prior decision state.
 *   - Security boundary (broker envelope, askpass IPC) → fail CLOSED:
 *     synthesize deny + emit error annotation. The deny is the safe default
 *     when a trusted channel produces an untrusted payload.
 *
 * Rules do NOT emit error annotations directly. They `throw new <FooError>(...)`
 * and the engine converts the throw into an annotation. This keeps the
 * Rule.evaluate() contract returning user-meaningful decisions (deny / ask /
 * warning / note / null) and reserves the error channel for hook-infra failures.
 */

/** Stable string identifier for each typed-error class. Used as the
 *  `errorCode` field on `error` annotations so consumers (UI, log shipping,
 *  test assertions) can route by class without doing instanceof checks.
 *  @stable @since 1.0.0 */
export type HookKitErrorCode =
  | "FileReadError"
  | "FileWriteError"
  | "JsonParseError"
  | "EnvelopeValidationError"
  | "ProtocolVersionError"
  | "ShellAstParseError"
  | "ProcessSpawnError"
  | "RuleEvaluationError"
  | "StateStoreError"
  | "ObserverError";

/** @stable @since 1.0.0 */
export abstract class HookKitError extends Error {
  abstract readonly code: HookKitErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown> = {}, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.context = Object.freeze({ ...context });
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/** Filesystem read failure (readFileSync, access checks). Fail-open at the
 *  rule level — the rule contributes no decision, error annotation surfaces.
 *  @stable @since 1.0.0 */
export class FileReadError extends HookKitError {
  readonly code = "FileReadError";
  constructor(path: string, cause: unknown) {
    super(`failed to read file: ${path} (${describeCause(cause)})`, { path }, cause);
  }
}

/** Filesystem write/remove failure (writeFileSync, rmSync). State persistence
 *  failures fall here; the in-process value is still set, only persistence lost.
 *  @stable @since 1.0.0 */
export class FileWriteError extends HookKitError {
  readonly code = "FileWriteError";
  constructor(path: string, cause: unknown) {
    super(`failed to write file: ${path} (${describeCause(cause)})`, { path }, cause);
  }
}

/** JSON.parse failure on a file we control (state store, listener metadata,
 *  audit log). Distinct from EnvelopeValidationError which covers Zod
 *  validation of structured IPC payloads.
 *  @stable @since 1.0.0 */
export class JsonParseError extends HookKitError {
  readonly code = "JsonParseError";
  constructor(path: string, cause: unknown) {
    super(`failed to parse JSON at ${path} (${describeCause(cause)})`, { path }, cause);
  }
}

/** Zod schema validation failure on a broker / askpass IPC envelope. Triggers
 *  fail-CLOSED at security boundaries — caller synthesizes a deny alongside
 *  the error annotation.
 *  @stable @since 1.0.0 */
export class EnvelopeValidationError extends HookKitError {
  readonly code = "EnvelopeValidationError";
  constructor(source: string, cause: unknown) {
    super(
      `envelope failed schema validation: ${source} (${describeCause(cause)})`,
      { source },
      cause,
    );
  }
}

/** Protocol-version mismatch on a broker / askpass IPC envelope. More specific
 *  than EnvelopeValidationError — the message parses but its `version` literal
 *  doesn't match PROTOCOL_VERSION. Fail-CLOSED at security boundaries.
 *  @stable @since 1.0.0 */
export class ProtocolVersionError extends HookKitError {
  readonly code = "ProtocolVersionError";
  constructor(source: string, expected: number, actual: unknown) {
    super(
      `envelope protocol version mismatch at ${source}: expected ${String(expected)}, got ${String(actual)}`,
      { source, expected, actual },
    );
  }
}

/** shell-ast parse / WASM-runtime error on a command input. ParseSyntaxError
 *  for malformed user input is NOT wrapped — that's expected and stays silent
 *  (the user typed garbage; let bash reject it). This class is for unexpected
 *  parser failures: WASM load, runtime panics, etc.
 *  @stable @since 1.0.0 */
export class ShellAstParseError extends HookKitError {
  readonly code = "ShellAstParseError";
  constructor(input: string, cause: unknown) {
    super(
      `shell-ast failed to parse input (${describeCause(cause)})`,
      { input: input.slice(0, INPUT_PREVIEW_MAX_CHARS) },
      cause,
    );
  }
}

/** Cap on the input preview stored on ShellAstParseError.context.input — long
 * payloads bloat error annotations and serialized logs. */
const INPUT_PREVIEW_MAX_CHARS = 200;

/** Bun.spawn or process control failure (askpass invocation, git enrichment).
 *  @stable @since 1.0.0 */
export class ProcessSpawnError extends HookKitError {
  readonly code = "ProcessSpawnError";
  constructor(command: string, cause: unknown) {
    super(`failed to spawn process: ${command} (${describeCause(cause)})`, { command }, cause);
  }
}

/** A rule's evaluate() threw something that wasn't a HookKitError — the rule
 *  itself has a bug (TypeError, ReferenceError, etc.). HookKitErrors thrown
 *  from rules are passed through unwrapped so the specific class shows up
 *  in the annotation.
 *  @stable @since 1.0.0 */
export class RuleEvaluationError extends HookKitError {
  readonly code = "RuleEvaluationError";
  constructor(ruleKind: string, cause: unknown) {
    super(
      `rule "${ruleKind}" threw during evaluation (${describeCause(cause)})`,
      { ruleKind },
      cause,
    );
  }
}

/** State store operation failure (get / set / flush on backing storage).
 *  @stable @since 1.0.0 */
export class StateStoreError extends HookKitError {
  readonly code = "StateStoreError";
  constructor(operation: string, key: string | undefined, cause: unknown) {
    const where = key === undefined ? "" : ` for key "${key}"`;
    super(
      `state store ${operation} failed${where} (${describeCause(cause)})`,
      { operation, key },
      cause,
    );
  }
}

/** A `DecisionObserver.onDecision` callback threw. Observer failures are
 *  fail-open at the observer boundary — the engine catches, surfaces this as
 *  an `error` annotation, and proceeds with the decision (and subsequent
 *  observers in the same array).
 *  @stable @since 1.0.0 */
export class ObserverError extends HookKitError {
  readonly code = "ObserverError";
  constructor(observerIndex: number, cause: unknown) {
    super(
      `observer at index ${String(observerIndex)} threw during onDecision (${describeCause(cause)})`,
      { observerIndex },
      cause,
    );
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}

/**
 * Render a typed error to the canonical stderr line format used everywhere
 * in hook-kit: `[label] error: <Code>: <message>\n`. The same format the
 * wrapper emits for `error` annotations, so internal-flow errors (broker,
 * askpass, listeners, store load) that don't pass through an EvaluationOutcome
 * stay consistent with the annotation channel.
 */
export function formatErrorLine(err: HookKitError, label?: string): string {
  const prefix = label ?? "[hook-kit]";
  return `${prefix} error: ${err.code}: ${err.message}\n`;
}

/** Emit a typed error to stderr using the canonical format. Convenience for
 *  the many internal sites that need this. */
export function emitErrorLine(err: HookKitError, label?: string): void {
  process.stderr.write(formatErrorLine(err, label));
}
