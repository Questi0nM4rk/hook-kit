/** @internal — no stability promise, may move/rename in any release.
 *  HOOK_KIT_VERBOSE tracing. Single trace line per evaluation: event,
 *  tool, session, module count, final outcome, time. Used by both run()
 *  (adapter path) and runShell() (shell-wrapper path) so observability is
 *  uniform across modes. The `HOOK_KIT_VERBOSE=1` env var IS a STABLE
 *  public contract; the trace-line format is best-effort and may change. */

import type { EvaluationOutcome, HookEvent } from "../core/types.js";

export function isVerbose(): boolean {
  const v = process.env.HOOK_KIT_VERBOSE;
  return v === "1" || v === "true";
}

export function traceLine(
  event: HookEvent,
  outcome: EvaluationOutcome,
  modulesConsidered: number,
  durationMs: number,
): string {
  const head = `[hook-kit] event=${event.eventName} tool=${event.toolName} session=${event.sessionId} modules=${modulesConsidered}`;
  const { terminal, annotations } = outcome;

  // No terminal, no annotations → null outcome (silent pass-through).
  if (terminal === null && annotations.length === 0) {
    return `${head} → null time=${durationMs}ms\n`;
  }

  // Render the terminal (if any) with its label + reason.
  let body: string;
  if (terminal !== null) {
    const label = terminal.label !== undefined ? ` label=${terminal.label}` : "";
    const reason = terminal.reason !== "" ? ` reason=${JSON.stringify(terminal.reason)}` : "";
    body = `${terminal.kind}${label}${reason}`;
  } else {
    // Annotation-only outcome — pick a synthetic kind so operators can grep.
    body = "annotate";
  }

  if (annotations.length > 0) {
    body += ` annotations=${annotations.length}`;
  }

  return `${head} → ${body} time=${durationMs}ms\n`;
}

/** Emit a verbose trace to stderr if HOOK_KIT_VERBOSE is set. No-op otherwise. */
export function emitVerbose(
  event: HookEvent,
  outcome: EvaluationOutcome,
  modulesConsidered: number,
  durationMs: number,
): void {
  if (!isVerbose()) return;
  process.stderr.write(traceLine(event, outcome, modulesConsidered, durationMs));
}
