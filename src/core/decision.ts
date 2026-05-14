import type { HookKitError } from "./errors.js";
import type { Annotation, Terminal } from "./types.js";

type DenyDecision = Extract<Terminal, { kind: "deny" }>;
type AskDecision = Extract<Terminal, { kind: "ask" }>;
type WarningDecision = Extract<Annotation, { kind: "warning" }>;
type NoteDecision = Extract<Annotation, { kind: "note" }>;
type ErrorAnnotation = Extract<Annotation, { kind: "error" }>;

export function deny(reason: string, label?: string): DenyDecision {
  return label === undefined ? { kind: "deny", reason } : { kind: "deny", reason, label };
}

/** Terminal: surface this command for review before it runs. The engine
 *  routes asks up through the escalation infrastructure (broker → spool
 *  tree → listener / askpass); the rule-level verb is `.ask(...)`. */
export function ask(reason: string, label?: string): AskDecision {
  return label === undefined ? { kind: "ask", reason } : { kind: "ask", reason, label };
}

/** Annotation: prints `[label] warning: <message>` then the command runs;
 *  output appears below a `---` separator. Distinct from `note` so the AI
 *  can tell them apart in the rendered output. */
export function warning(message: string, label?: string): WarningDecision {
  return label === undefined ? { kind: "warning", message } : { kind: "warning", message, label };
}

/** Annotation: same mechanics as `warning` — `[label] note: <message>` line
 *  emitted before `---` and the command output. Use for informational
 *  context (size/age/origin/etc.) where `warning` would overstate severity. */
export function note(message: string, label?: string): NoteDecision {
  return label === undefined ? { kind: "note", message } : { kind: "note", message, label };
}

/**
 * @internal Engine-only. Constructs an `error` annotation from a typed
 * HookKitError caught at the engine boundary. NOT exported from src/index.ts
 * — rules cannot emit error annotations directly. They throw a HookKitError
 * subclass and the engine converts it via this helper.
 */
export function errorAnnotation(err: HookKitError, label?: string): ErrorAnnotation {
  return label === undefined
    ? { kind: "error", message: err.message, errorCode: err.code }
    : { kind: "error", message: err.message, errorCode: err.code, label };
}
