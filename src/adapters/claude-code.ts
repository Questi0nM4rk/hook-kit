// Claude Code protocol adapter
// See docs/SPEC.md § Protocol Adapters for the CC mapping table

import { z } from "zod";
import type { Decision, HookEvent } from "../core/types.js";
import { callAskpass } from "../escalation/askpass.js";
import { enrichGit, gitEnrichmentEnabled } from "../escalation/enrich-git.js";
import { createAskRequest } from "../escalation/envelope.js";
import type { ProtocolAdapter } from "./types.js";

const HARNESS = { name: "claude-code" } as const;

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
/**
 * Synchronous mapping for non-escalate decisions. Use `resolveCcOutput` for
 * the full path including escalation; `decideCcOutput` is kept as a pure
 * function so non-escalate tests can assert directly on the output without
 * touching the askpass channel.
 *
 * For an `escalate` decision this returns the same deny shape as before —
 * use `resolveCcOutput` (async) to actually drive the askpass channel.
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

  // Sync path for escalate: deny with a "use resolveCcOutput" hint. Production
  // code should always go through resolveCcOutput, which routes via askpass.
  const reason = withLabel(
    `[hook-kit] escalate decision reached the sync path; use resolveCcOutput. Original: ${decision.reason}`,
    decision.label,
  );
  return denyOutput(reason, event.eventName);
}

export interface ResolveCcOutputOptions {
  /** Override the askpass binary path (defaults to env $HOOK_KIT_ASKPASS). */
  readonly askpassPath?: string;
  /** Override the askpass timeout in ms (defaults to 60_000). */
  readonly timeoutMs?: number;
}

/**
 * Full async mapping. Routes escalate decisions through the askpass channel
 * and translates the response back into a CcOutput. Non-escalate decisions
 * delegate to decideCcOutput synchronously.
 *
 * harness-ask responses produce CC's native `permissionDecision: "ask"` for
 * PreToolUse, letting CC's UI block indefinitely. For PostToolUse and other
 * events that don't accept "ask", harness-ask degrades to a context message
 * carrying the original reason (per the spec's Escalation table).
 */
export async function resolveCcOutput(
  decision: Decision,
  event: HookEvent,
  opts: ResolveCcOutputOptions = {},
): Promise<CcOutput> {
  if (decision === null || decision.kind !== "escalate") {
    return decideCcOutput(decision, event);
  }

  const git = gitEnrichmentEnabled() ? await enrichGit(event.cwd) : undefined;
  const request = createAskRequest({
    sessionId: event.sessionId,
    toolName: event.toolName,
    toolInput: event.toolInput,
    reason: decision.reason,
    harness: HARNESS,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    ...(decision.label !== undefined ? { label: decision.label } : {}),
    ...(git !== undefined ? { git } : {}),
  });
  const askOpts: { askpassPath?: string; timeoutMs?: number } = {};
  if (opts.askpassPath !== undefined) askOpts.askpassPath = opts.askpassPath;
  if (opts.timeoutMs !== undefined) askOpts.timeoutMs = opts.timeoutMs;
  const response = await callAskpass({ request, ...askOpts });

  if (response.decision === "allow") {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  if (response.decision === "harness-ask") {
    return harnessAskOutput(decision, event);
  }

  // deny — propagate the askpass's reason if it offered one, else fall back.
  const reason = withLabel(
    response.reason ?? `[hook-kit] denied: ${decision.reason}`,
    decision.label,
  );
  return denyOutput(reason, event.eventName);
}

function harnessAskOutput(
  decision: Extract<Decision, { kind: "escalate" }>,
  event: HookEvent,
): CcOutput {
  const message = withLabel(decision.reason, decision.label);
  if (event.eventName === "PreToolUse") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: message,
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  }
  // PostToolUse / SessionStart / Stop don't accept "ask" — degrade to context.
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
  async writeOutput(decision: Decision, event: HookEvent): Promise<void> {
    const out = await resolveCcOutput(decision, event);
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
