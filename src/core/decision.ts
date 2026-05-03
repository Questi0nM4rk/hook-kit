import type { Decision } from "./types.js";

type DenyDecision = Extract<Decision, { kind: "deny" }>;
type ContextDecision = Extract<Decision, { kind: "context" }>;
type EscalateDecision = Extract<Decision, { kind: "escalate" }>;

export function deny(reason: string, label?: string): DenyDecision {
  return label === undefined ? { kind: "deny", reason } : { kind: "deny", reason, label };
}

export function context(message: string, label?: string): ContextDecision {
  return label === undefined ? { kind: "context", message } : { kind: "context", message, label };
}

export function escalate(reason: string, label?: string): EscalateDecision {
  return label === undefined ? { kind: "escalate", reason } : { kind: "escalate", reason, label };
}
