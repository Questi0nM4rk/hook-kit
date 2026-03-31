import type { Decision } from "./types.js";

export function deny(reason: string, label?: string): Decision {
  return { kind: "deny", reason, label };
}

export function context(message: string, label?: string): Decision {
  return { kind: "context", message, label };
}

export function escalate(reason: string, label?: string): Decision {
  return { kind: "escalate", reason, label };
}
