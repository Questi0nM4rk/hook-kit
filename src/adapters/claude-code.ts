// Claude Code protocol adapter
// See docs/SPEC.md § Protocol Adapters for the CC mapping table

import { z } from "zod";
import type { Annotation, EvaluationOutcome, HookEvent, Terminal } from "../core/types.js";
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
 *  tests can assert against a value without mocking process.* . */
export interface CcOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const EMPTY: CcOutput = { stdout: "", stderr: "", exitCode: 0 };

/** Render a single annotation to its `[label] warning|note: <message>` line. */
function formatAnnotation(a: Annotation): string {
  const prefix = a.label ?? "[hook-kit]";
  return `${prefix} ${a.kind}: ${a.message}`;
}

/** Join multiple annotations into one block, one line each. */
function joinAnnotations(annotations: readonly Annotation[]): string {
  return annotations.map(formatAnnotation).join("\n");
}

function withLabel(message: string, label?: string): string {
  return label !== undefined ? `${label} ${message}` : message;
}

/**
 * Sync mapping from outcome → CcOutput for the non-escalate paths.
 *
 * - terminal=deny     → CC permissionDecision: "block" (Pre) or stderr+exit2
 * - terminal=null +   → CC additionalContext carrying the joined annotation
 *   annotations          block (no permission change, harness lets it run)
 * - terminal=escalate → caller must use `resolveCcOutput` (async, routes via
 *                       askpass). This sync path returns a deny-shaped error
 *                       so misuse is loud.
 */
export function decideCcOutput(outcome: EvaluationOutcome, event: HookEvent): CcOutput {
  const { terminal, annotations } = outcome;

  if (terminal?.kind === "deny") {
    return denyOutput(withLabel(terminal.reason, terminal.label), event.eventName);
  }

  if (terminal?.kind === "escalate") {
    // Sync path: deny with a hint to use the async resolver. Production code
    // (claudeCodeAdapter.writeOutput) ALWAYS goes through resolveCcOutput.
    const reason = withLabel(
      `[hook-kit] escalate decision reached the sync path; use resolveCcOutput. Original: ${terminal.reason}`,
      terminal.label,
    );
    return denyOutput(reason, event.eventName);
  }

  if (annotations.length > 0) {
    return annotationsOutput(annotations, event.eventName);
  }

  return EMPTY;
}

export interface ResolveCcOutputOptions {
  /** Override the askpass binary path (defaults to env $HOOK_KIT_ASKPASS). */
  readonly askpassPath?: string;
  /** Override the askpass timeout in ms (defaults to 60_000). */
  readonly timeoutMs?: number;
}

/**
 * Full async mapping. Routes escalate outcomes through the askpass channel
 * and translates the response back into a CcOutput. Non-escalate outcomes
 * delegate to decideCcOutput synchronously.
 *
 * harness-ask responses produce CC's native `permissionDecision: "ask"` for
 * PreToolUse, letting CC's UI block indefinitely. For PostToolUse and other
 * events that don't accept "ask", harness-ask degrades to a context message
 * carrying the original reason (per the spec's Escalation table).
 *
 * When annotations accompany the terminal, they bundle into the JSON output:
 *   - deny      → annotations DROPPED (deny is final, command does not run)
 *   - escalate  → annotations included as additionalContext so the user
 *                 reviewing the ask sees them; also included in the askpass
 *                 envelope for broker-mode reviewers.
 *   - null      → annotations alone → additionalContext, exit 0
 */
export async function resolveCcOutput(
  outcome: EvaluationOutcome,
  event: HookEvent,
  opts: ResolveCcOutputOptions = {},
): Promise<CcOutput> {
  if (outcome.terminal?.kind !== "escalate") {
    return decideCcOutput(outcome, event);
  }

  const git = gitEnrichmentEnabled() ? await enrichGit(event.cwd) : undefined;
  const escalate = outcome.terminal;
  const annotationsBlock =
    outcome.annotations.length > 0 ? joinAnnotations(outcome.annotations) : undefined;
  const request = createAskRequest({
    sessionId: event.sessionId,
    toolName: event.toolName,
    toolInput: event.toolInput,
    reason: escalate.reason,
    harness: HARNESS,
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    ...(escalate.label !== undefined ? { label: escalate.label } : {}),
    ...(annotationsBlock !== undefined ? { annotations: annotationsBlock } : {}),
    ...(git !== undefined ? { git } : {}),
  });
  const askOpts: { askpassPath?: string; timeoutMs?: number } = {};
  if (opts.askpassPath !== undefined) askOpts.askpassPath = opts.askpassPath;
  if (opts.timeoutMs !== undefined) askOpts.timeoutMs = opts.timeoutMs;
  const response = await callAskpass({ request, ...askOpts });

  if (response.decision === "allow") {
    // Approved by broker — silent allow, with annotations surfaced to CC
    // so the agent can still see them above its tool output.
    if (annotationsBlock !== undefined) {
      return annotationsOutput(outcome.annotations, event.eventName);
    }
    return EMPTY;
  }

  if (response.decision === "harness-ask") {
    return harnessAskOutput(escalate, outcome.annotations, event);
  }

  // deny — propagate the askpass's reason if it offered one, else fall back.
  const reason = withLabel(
    response.reason ?? `[hook-kit] denied: ${escalate.reason}`,
    escalate.label,
  );
  return denyOutput(reason, event.eventName);
}

function harnessAskOutput(
  escalate: Extract<Terminal, { kind: "escalate" }>,
  annotations: readonly Annotation[],
  event: HookEvent,
): CcOutput {
  const reasonLine = withLabel(escalate.reason, escalate.label);
  const message =
    annotations.length > 0 ? `${reasonLine}\n${joinAnnotations(annotations)}` : reasonLine;

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

function annotationsOutput(annotations: readonly Annotation[], eventName: string): CcOutput {
  return {
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: joinAnnotations(annotations),
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
  async writeOutput(outcome: EvaluationOutcome, event: HookEvent): Promise<void> {
    const out = await resolveCcOutput(outcome, event);
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
