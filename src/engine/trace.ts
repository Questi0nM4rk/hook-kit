// HOOK_KIT_VERBOSE tracing. Single trace line per evaluation: event,
// tool, session, module count, final decision, time. Used by both run()
// (adapter path) and runShell() (shell-wrapper path) so observability is
// uniform across modes.

import type { Decision, HookEvent } from "../core/types.js";

export function isVerbose(): boolean {
  const v = process.env.HOOK_KIT_VERBOSE;
  return v === "1" || v === "true";
}

export function traceLine(
  event: HookEvent,
  decision: Decision,
  modulesConsidered: number,
  durationMs: number,
): string {
  const head = `[hook-kit] event=${event.eventName} tool=${event.toolName} session=${event.sessionId} modules=${modulesConsidered}`;
  if (decision === null) return `${head} → null time=${durationMs}ms\n`;
  const label = decision.label !== undefined ? ` label=${decision.label}` : "";
  const reasonText = decision.kind === "context" ? decision.message : decision.reason;
  const reason = reasonText !== "" ? ` reason=${JSON.stringify(reasonText)}` : "";
  return `${head} → ${decision.kind}${label}${reason} time=${durationMs}ms\n`;
}

/** Emit a verbose trace to stderr if HOOK_KIT_VERBOSE is set. No-op otherwise. */
export function emitVerbose(
  event: HookEvent,
  decision: Decision,
  modulesConsidered: number,
  durationMs: number,
): void {
  if (!isVerbose()) return;
  process.stderr.write(traceLine(event, decision, modulesConsidered, durationMs));
}
