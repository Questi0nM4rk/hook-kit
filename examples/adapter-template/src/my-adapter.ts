// Custom ProtocolAdapter — fork-and-modify scaffold.
// Spec: docs/ADAPTERS.md (in @questi0nm4rk/hook-kit). Anti-patterns + error
// boundaries live there. The demo modules in `hooks.ts` are stubs; the
// adapter itself is the artifact downstream forks. Replace `MyHarnessInput`
// + `parseInput` to match whatever wire format your harness speaks.

import type { EvaluationOutcome, HookEvent, ProtocolAdapter } from "@questi0nm4rk/hook-kit";

/**
 * Demo harness wire format. Each event is one JSON object on stdin:
 *
 *   {"event":"PreToolUse","session":"s1","cwd":"/x","transcript":"/x/t.jsonl",
 *    "tool":"Bash","input":{"command":"rm -rf /tmp/x"}}
 *
 * A real adapter parses whatever the upstream harness sends (Cursor's RPC,
 * MCP elicitation, a Unix socket, etc.). Define the shape and validate.
 */
interface MyHarnessInput {
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

/** Streams the adapter writes to / reads from. Constructor-injected so tests
 *  can pass mocks; `main.ts` wires the real `process.*` handles. */
export interface AdapterStreams {
  readonly stdin: AsyncIterable<Uint8Array | string>;
  readonly stdout: { write(s: string): void };
  readonly stderr: { write(s: string): void };
  readonly exit: (code: number) => void;
}

/** Factory options. Streams are injected; `label` overrides the default
 *  `[template-demo]` prefix for adapter-emitted lines (decision labels from
 *  rules always win over this default — see docs/ADAPTERS.md § Output
 *  convention's `<prefix>` rules). */
export interface MyAdapterOptions {
  readonly streams: AdapterStreams;
  readonly label?: string;
}

const DEFAULT_LABEL = "[template-demo]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseInput(rawText: string): HookEvent {
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

async function readAllStdin(stdin: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Build the line prefix for an emitted decision/annotation. A rule-supplied
 *  label takes precedence; otherwise the adapter's configured default. */
function prefixFor(defaultLabel: string, decisionLabel: string | undefined): string {
  return decisionLabel ?? defaultLabel;
}

function emitOutcome(
  outcome: EvaluationOutcome,
  streams: AdapterStreams,
  defaultLabel: string,
): number {
  const { terminal, annotations } = outcome;
  // `error` annotations ALWAYS surface — see docs/ADAPTERS.md § Error handling.
  for (const a of annotations) {
    if (a.kind === "error") {
      streams.stderr.write(
        `${prefixFor(defaultLabel, a.label)} error: ${a.errorCode}: ${a.message}\n`,
      );
    }
  }
  if (terminal?.kind === "deny") {
    streams.stderr.write(`${prefixFor(defaultLabel, terminal.label)} denied: ${terminal.reason}\n`);
    return 2;
  }
  if (terminal?.kind === "ask") {
    streams.stdout.write(
      `${prefixFor(defaultLabel, terminal.label)} needs review: ${terminal.reason}\n`,
    );
    return 1;
  }
  for (const a of annotations) {
    if (a.kind === "warning" || a.kind === "note") {
      streams.stdout.write(`${prefixFor(defaultLabel, a.label)} ${a.kind}: ${a.message}\n`);
    }
  }
  return 0;
}

/** Factory returning a `ProtocolAdapter` over the supplied streams. Tests
 *  construct one with mocks; `main.ts` constructs one with `process.*`. */
export function createMyAdapter(opts: MyAdapterOptions): ProtocolAdapter {
  const label = opts.label ?? DEFAULT_LABEL;
  return {
    async readInput(): Promise<HookEvent> {
      const raw = await readAllStdin(opts.streams.stdin);
      return parseInput(raw);
    },
    writeOutput(outcome: EvaluationOutcome, _event: HookEvent): void {
      const code = emitOutcome(outcome, opts.streams, label);
      opts.streams.exit(code);
    },
    handleError(error: unknown): void {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        opts.streams.stderr.write(`${label} fatal: ${msg}\n`);
      } catch {
        // stderr write failed; nothing left to try (the only acceptable swallow,
        // per docs/ADAPTERS.md § Error handling — handleError MUST be total).
      }
      opts.streams.exit(2);
    },
  };
}
