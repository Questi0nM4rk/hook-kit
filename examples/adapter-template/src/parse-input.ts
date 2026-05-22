// Harness wire-format parser — the fork-first file in this template.
// README step 1 says "edit this file to match your harness's wire format."
// The parseInput export is everything that's wire-format-specific; the
// adapter in `my-adapter.ts` is wire-format-agnostic and consumes a
// HookEvent regardless of how it was constructed.

import type { HookEvent } from "@questi0nm4rk/hook-kit";

/**
 * Demo harness wire format. Each event is one JSON object on stdin:
 *
 *   {"event":"PreToolUse","session":"s1","cwd":"/x","transcript":"/x/t.jsonl",
 *    "tool":"Bash","input":{"command":"rm -rf /tmp/x"}}
 *
 * A real adapter parses whatever the upstream harness sends (Cursor's RPC,
 * MCP elicitation, a Unix socket, etc.). Define the shape and validate.
 */
export interface MyHarnessInput {
  readonly event: string;
  readonly session: string;
  readonly cwd: string;
  readonly transcript: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/** Thrown by `readInput` when stdin is empty / unparseable. The engine routes
 *  this to `handleError`. Zero-silent-fails: never return a synthetic event.
 *  Downstream consumers can subclass hook-kit's `HookKitError` here if they
 *  want their typed errors threaded into the engine's error annotations —
 *  for read-input failures the engine calls handleError directly so a plain
 *  Error works just as well. */
export class MyAdapterInputError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MyAdapterInputError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the wire payload and project it onto hook-kit's HookEvent shape.
 *  Throws MyAdapterInputError on any malformation. */
export function parseInput(rawText: string): HookEvent {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    throw new MyAdapterInputError("empty stdin");
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    throw new MyAdapterInputError("stdin is not JSON", cause);
  }
  if (!isPlainObject(json)) {
    throw new MyAdapterInputError("stdin JSON is not an object");
  }
  const o = json as Partial<MyHarnessInput>;
  if (
    typeof o.event !== "string" ||
    typeof o.session !== "string" ||
    typeof o.cwd !== "string" ||
    typeof o.transcript !== "string" ||
    typeof o.tool !== "string" ||
    !isPlainObject(o.input)
  ) {
    throw new MyAdapterInputError("stdin JSON missing required fields");
  }
  return {
    eventName: o.event,
    sessionId: o.session,
    cwd: o.cwd,
    transcriptPath: o.transcript,
    toolName: o.tool,
    toolInput: o.input,
    raw: json as Readonly<Record<string, unknown>>,
  };
}
