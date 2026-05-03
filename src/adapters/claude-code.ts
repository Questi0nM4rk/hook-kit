// Claude Code protocol adapter
// See docs/SPEC.md § Protocol Adapters for the CC mapping table

import { z } from "zod";
import type { Decision, HookEvent } from "../core/types.js";
import type { ProtocolAdapter } from "./types.js";

const HookInputSchema = z.object({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  hook_event_name: z.string(),
  tool_name: z.string(),
  tool_input: z.record(z.unknown()),
});

/** What the adapter would write/exit, separated from the side effects so
 *  tests can assert against a value without mocking process.* . */
export interface CcOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Pure mapping from a Decision to what the CC harness should observe.
 * Empty stdout/stderr + exit 0 = silent allow.
 *
 * `escalate` decisions are not yet wired to the askpass channel. Until the
 * escalation system lands, an `escalate` is treated as a `deny` with a
 * reason that mentions the missing infrastructure (Iron Law 3 exception:
 * escalate-with-no-responder denies, never silent-allows).
 */
export function decideCcOutput(decision: Decision, event: HookEvent): CcOutput {
  if (decision === null) return { stdout: "", stderr: "", exitCode: 0 };

  if (decision.kind === "context") {
    const message = withLabel(decision.message, decision.label);
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event.eventName,
          additionalContext: message,
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  }

  if (decision.kind === "deny") {
    return denyOutput(withLabel(decision.reason, decision.label), event.eventName);
  }

  // escalate — M1 stub: no askpass yet. Deny with an explicit reason.
  const reason = withLabel(
    `[hook-kit] escalation not yet implemented; original: ${decision.reason}`,
    decision.label,
  );
  return denyOutput(reason, event.eventName);
}

function denyOutput(reason: string, eventName: string): CcOutput {
  if (eventName === "PreToolUse") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "block",
          permissionDecisionReason: reason,
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  }
  // PostToolUse, SessionStart, Stop, etc. — stderr + exit 2 is the only hard-deny path
  return { stdout: "", stderr: `${reason}\n`, exitCode: 2 };
}

function withLabel(message: string, label?: string): string {
  return label !== undefined ? `${label} ${message}` : message;
}

/**
 * Parse a raw stdin string into a HookEvent. Throws on empty or
 * non-conforming input — `claudeCodeAdapter.readInput` catches and
 * delegates to handleError (exit 0).
 *
 * `HookEvent.raw` carries the original parsed JSON (pre-Zod) so custom
 * rules can read extra fields the harness layered on top of the
 * documented schema.
 */
export function parseHookInput(rawText: string): HookEvent {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    throw new Error("[hook-kit] empty stdin");
  }
  const json: unknown = JSON.parse(trimmed);
  const parsed = HookInputSchema.parse(json);
  const original =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Readonly<Record<string, unknown>>)
      : ({} as Readonly<Record<string, unknown>>);
  return {
    eventName: parsed.hook_event_name,
    sessionId: parsed.session_id,
    cwd: parsed.cwd,
    transcriptPath: parsed.transcript_path,
    toolName: parsed.tool_name,
    toolInput: parsed.tool_input,
    raw: original,
  };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const claudeCodeAdapter: ProtocolAdapter = {
  async readInput(): Promise<HookEvent> {
    const raw = await readAllStdin();
    return parseHookInput(raw);
  },
  writeOutput(decision: Decision, event: HookEvent): void {
    const out = decideCcOutput(decision, event);
    if (out.stdout !== "") process.stdout.write(out.stdout);
    if (out.stderr !== "") process.stderr.write(out.stderr);
    process.exit(out.exitCode);
  },
  handleError(_error: unknown): void {
    // Iron Law 3: never crash, never block.
    process.exit(0);
  },
};

export type { ProtocolAdapter } from "./types.js";
