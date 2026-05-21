// Claude Code protocol adapter
// See docs/SPEC.md § Protocol Adapters for the CC mapping table

import { z } from "zod";
import {
  type ErrorAnnotation,
  formatErrorAnnotation,
  formatNonErrorAnnotation,
  type NonErrorAnnotation,
  partitionAnnotations,
} from "../core/annotations.js";
import type { EvaluationOutcome, HookEvent, Terminal } from "../core/types.js";
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
  tool_input: z.record(z.string(), z.unknown()),
});

/** What the adapter would write/exit, separated from the side effects so
 *  tests can assert against a value without mocking process.* .
 *  @stable @since 1.0.0 */
export interface CcOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const EMPTY: CcOutput = { stdout: "", stderr: "", exitCode: 0 };

function joinNonErrorAnnotations(annotations: readonly NonErrorAnnotation[]): string {
  return annotations.map(formatNonErrorAnnotation).join("\n");
}

/** Concatenate error-annotation lines onto an existing CcOutput's stderr.
 *  Error annotations stay OUT of CC's additionalContext / askpass envelope
 *  — they're hook-infra failures, not rule output the agent should see.
 *  They go to stderr so the operator sees them in their terminal. */
function appendErrorsToStderr(out: CcOutput, errors: readonly ErrorAnnotation[]): CcOutput {
  if (errors.length === 0) {
    return out;
  }
  const lines = errors.map((e) => `${formatErrorAnnotation(e)}\n`).join("");
  return { ...out, stderr: out.stderr + lines };
}

function withLabel(message: string, label?: string): string {
  return label === undefined ? message : `${label} ${message}`;
}

/**
 * Sync mapping from outcome → CcOutput for the non-ask paths.
 *
 * - terminal=deny     → CC permissionDecision: "block" (Pre) or stderr+exit2
 * - terminal=null +   → CC additionalContext carrying the joined annotation
 *   warning/note         block (no permission change, harness lets it run)
 * - terminal=ask → caller must use `resolveCcOutput` (async, routes via
 *                       askpass). This sync path returns a deny-shaped error
 *                       so misuse is loud.
 *
 * `error` annotations are routed to stderr regardless of terminal — they
 * never enter additionalContext or the askpass envelope.
 * @stable @since 1.0.0
 */
export function decideCcOutput(outcome: EvaluationOutcome, event: HookEvent): CcOutput {
  const { others, errors } = partitionAnnotations(outcome.annotations);
  const { terminal } = outcome;

  let base: CcOutput;
  if (terminal?.kind === "deny") {
    base = denyOutput(withLabel(terminal.reason, terminal.label), event.eventName);
  } else if (terminal?.kind === "ask") {
    // Sync path: deny with a hint to use the async resolver. Production code
    // (claudeCodeAdapter.writeOutput) ALWAYS goes through resolveCcOutput.
    const reason = withLabel(
      `[hook-kit] ask decision reached the sync path; use resolveCcOutput. Original: ${terminal.reason}`,
      terminal.label,
    );
    base = denyOutput(reason, event.eventName);
  } else if (others.length > 0) {
    base = annotationsOutput(others, event.eventName);
  } else {
    base = EMPTY;
  }

  return appendErrorsToStderr(base, errors);
}

/** @stable @since 1.0.0 */
export interface ResolveCcOutputOptions {
  /** Override the askpass binary path (defaults to env $HOOK_KIT_ASKPASS). */
  readonly askpassPath?: string;
  /** Override the askpass timeout in ms (defaults to 60_000). */
  readonly timeoutMs?: number;
}

/**
 * Full async mapping. Routes ask outcomes through the askpass channel
 * and translates the response back into a CcOutput. Non-ask outcomes
 * delegate to decideCcOutput synchronously.
 *
 * harness-ask responses produce CC's native `permissionDecision: "ask"` for
 * PreToolUse, letting CC's UI block indefinitely. For PostToolUse and other
 * events that don't accept "ask", harness-ask degrades to a context message
 * carrying the original reason (per the spec's Escalation table).
 *
 * When non-error annotations accompany the terminal, they bundle into the
 * JSON output:
 *   - deny      → annotations DROPPED (deny is final, command does not run)
 *   - ask  → annotations included as additionalContext so the user
 *                 reviewing the ask sees them; also included in the askpass
 *                 envelope for broker-mode reviewers.
 *   - null      → annotations alone → additionalContext, exit 0
 *
 * `error` annotations always route to stderr regardless of terminal.
 * @stable @since 1.0.0
 */
export async function resolveCcOutput(
  outcome: EvaluationOutcome,
  event: HookEvent,
  opts: ResolveCcOutputOptions = {},
): Promise<CcOutput> {
  const { others, errors } = partitionAnnotations(outcome.annotations);

  if (outcome.terminal?.kind !== "ask") {
    return decideCcOutput(outcome, event);
  }

  const git = gitEnrichmentEnabled() ? await enrichGit(event.cwd) : undefined;
  const ask = outcome.terminal;
  const annotationsBlock = others.length > 0 ? joinNonErrorAnnotations(others) : undefined;
  const request = createAskRequest({
    sessionId: event.sessionId,
    toolName: event.toolName,
    toolInput: event.toolInput,
    reason: ask.reason,
    harness: HARNESS,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    ...(ask.label === undefined ? {} : { label: ask.label }),
    ...(annotationsBlock === undefined ? {} : { annotations: annotationsBlock }),
    ...(git === undefined ? {} : { git }),
  });
  const askOpts: { askpassPath?: string; timeoutMs?: number } = {};
  if (opts.askpassPath !== undefined) {
    askOpts.askpassPath = opts.askpassPath;
  }
  if (opts.timeoutMs !== undefined) {
    askOpts.timeoutMs = opts.timeoutMs;
  }
  const response = await callAskpass({ request, ...askOpts });

  let base: CcOutput;
  if (response.decision === "allow") {
    // Approved by broker — silent allow, with non-error annotations surfaced
    // to CC so the agent can still see them above its tool output.
    base = annotationsBlock === undefined ? EMPTY : annotationsOutput(others, event.eventName);
  } else if (response.decision === "harness-ask") {
    base = harnessAskOutput(ask, others, event);
  } else {
    // deny — propagate the askpass's reason if it offered one, else fall back.
    const reason = withLabel(response.reason ?? `[hook-kit] denied: ${ask.reason}`, ask.label);
    base = denyOutput(reason, event.eventName);
  }
  return appendErrorsToStderr(base, errors);
}

function harnessAskOutput(
  ask: Extract<Terminal, { kind: "ask" }>,
  annotations: readonly NonErrorAnnotation[],
  event: HookEvent,
): CcOutput {
  const reasonLine = withLabel(ask.reason, ask.label);
  const message =
    annotations.length > 0 ? `${reasonLine}\n${joinNonErrorAnnotations(annotations)}` : reasonLine;

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

function annotationsOutput(
  annotations: readonly NonErrorAnnotation[],
  eventName: string,
): CcOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: joinNonErrorAnnotations(annotations),
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

/**
 * Parse a raw stdin string into a HookEvent. Throws on empty or
 * non-conforming input — `claudeCodeAdapter.readInput` catches and
 * delegates to handleError (exit 0).
 *
 * `HookEvent.raw` carries the original parsed JSON (pre-Zod) so custom
 * rules can read extra fields the harness layered on top of the
 * documented schema.
 * @stable @since 1.0.0
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

/** @stable @since 1.0.0 */
export const claudeCodeAdapter: ProtocolAdapter = {
  async readInput(): Promise<HookEvent> {
    const raw = await readAllStdin();
    return parseHookInput(raw);
  },
  async writeOutput(outcome: EvaluationOutcome, event: HookEvent): Promise<void> {
    const out = await resolveCcOutput(outcome, event);
    if (out.stdout !== "") {
      process.stdout.write(out.stdout);
    }
    if (out.stderr !== "") {
      process.stderr.write(out.stderr);
    }
    process.exit(out.exitCode);
  },
  handleError(_error: unknown): void {
    // Iron Law 4: never crash, never block.
    process.exit(0);
  },
};

export type { ProtocolAdapter } from "./types.js";
