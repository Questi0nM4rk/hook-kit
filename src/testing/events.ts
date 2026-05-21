// Event factories — synthesize HookEvent objects for tests. Mirrors the
// shape downstream harnesses produce (Claude Code's hook payloads) so rules
// don't see test events differently from production events. Per-factory
// opts let tests override the synthetic defaults (sessionId, cwd, etc.)
// when a rule reads those fields.

import type { HookEvent } from "../core/types.js";

/** @stable @since 1.0.0 */
export interface EventOpts {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly transcriptPath?: string;
  /** Default `"PreToolUse"`. Set to `"PostToolUse"` to test PostToolUse rules
   *  (notably content() and any rule that fires after the tool ran). */
  readonly eventName?: string;
}

const DEFAULTS = Object.freeze({
  sessionId: "test",
  cwd: "/tmp",
  transcriptPath: "",
  eventName: "PreToolUse" as const,
});

function baseEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  opts: EventOpts,
): HookEvent {
  return {
    eventName: opts.eventName ?? DEFAULTS.eventName,
    sessionId: opts.sessionId ?? DEFAULTS.sessionId,
    cwd: opts.cwd ?? DEFAULTS.cwd,
    transcriptPath: opts.transcriptPath ?? DEFAULTS.transcriptPath,
    toolName,
    toolInput,
    raw: {},
  };
}

/** Synthesize a Bash event for `command`. Mirrors what the shell wrapper
 *  produces.
 *  @stable @since 1.0.0 */
export function bashEvent(command: string, opts: EventOpts = {}): HookEvent {
  return baseEvent("Bash", { command }, opts);
}

/** Synthesize a Write event for `filePath` with optional `content`. Mirrors
 *  the cc-tools adapter's input shape.
 *  @stable @since 1.0.0 */
export function writeEvent(filePath: string, content?: string, opts: EventOpts = {}): HookEvent {
  const toolInput: Record<string, unknown> =
    content !== undefined ? { file_path: filePath, content } : { file_path: filePath };
  return baseEvent("Write", toolInput, opts);
}

/** Synthesize an Edit event. Both `oldStr` and `newStr` are optional so
 *  tests can probe partial-input rule behavior.
 *  @stable @since 1.0.0 */
export function editEvent(
  filePath: string,
  oldStr?: string,
  newStr?: string,
  opts: EventOpts = {},
): HookEvent {
  const toolInput: Record<string, unknown> = { file_path: filePath };
  if (oldStr !== undefined) toolInput.old_string = oldStr;
  if (newStr !== undefined) toolInput.new_string = newStr;
  return baseEvent("Edit", toolInput, opts);
}

/** Synthesize a Read event for `filePath`.
 *  @stable @since 1.0.0 */
export function readEvent(filePath: string, opts: EventOpts = {}): HookEvent {
  return baseEvent("Read", { file_path: filePath }, opts);
}
