import type { Annotation, Terminal } from "./types.js";

type DenyDecision = Extract<Terminal, { kind: "deny" }>;
type EscalateDecision = Extract<Terminal, { kind: "escalate" }>;
type WarningDecision = Extract<Annotation, { kind: "warning" }>;
type NoteDecision = Extract<Annotation, { kind: "note" }>;

export function deny(reason: string, label?: string): DenyDecision {
  return label === undefined ? { kind: "deny", reason } : { kind: "deny", reason, label };
}

export function escalate(reason: string, label?: string): EscalateDecision {
  return label === undefined ? { kind: "escalate", reason } : { kind: "escalate", reason, label };
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
