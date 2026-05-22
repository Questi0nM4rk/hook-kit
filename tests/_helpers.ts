// Shared test helpers — kept under tests/ with a leading underscore so bun's
// test discovery (which only picks up `*.test.ts` / `*_test.ts`) skips it.
// Replaces three identical copies that were drifting across test files.

import type { HookEvent } from "../src/core/types.js";

/** Build a synthetic PreToolUse Bash event for engine/rule tests. */
export function bashEvent(command: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
  };
}

/** Capture writes to process.stderr until `restore()` is called. */
export function captureStderr(): { restore: () => void; output: () => string } {
  const buf: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return { restore: () => (process.stderr.write = original), output: () => buf.join("") };
}

/**
 * Shape of the CC adapter's stdout JSON, exactly matching the keys produced
 * by `src/adapters/claude-code.ts` (`hookSpecificOutput` envelope). The shape
 * is conservative — every field optional — so this can stand in for both
 * deny/ask paths (with permissionDecision / permissionDecisionReason) and the
 * annotation-only path (additionalContext).
 */
export interface CcStdoutJson {
  readonly hookSpecificOutput: {
    readonly hookEventName?: string;
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
  };
}

/**
 * Type-narrow JSON.parse for CC adapter output. JSON.parse is `any` by design
 * (its return type cannot be derived from the input string); we cast at the
 * test boundary to the well-known CC schema produced by claude-code.ts so
 * test bodies stay type-safe under ESLint's no-unsafe-* rules.
 */
export function parseCcStdout(stdout: string): CcStdoutJson {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse return type is any by design; narrowed to CcStdoutJson at this test-boundary based on the well-known CC adapter output schema.
  const parsed: CcStdoutJson = JSON.parse(stdout);
  return parsed;
}

/** Run `fn` with the env var set to `value` (or unset when `value` is undefined). */
export function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env IS the dynamic-key API; `delete process.env[k]` is the canonical unset and Reflect.deleteProperty wouldn't trigger Node's getenv() invalidation either.
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env IS the dynamic-key API; restoring "unset" requires delete.
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
