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

/** Run `fn` with the env var set to `value` (or unset when `value` is undefined). */
export function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}
