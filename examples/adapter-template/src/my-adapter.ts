// Custom ProtocolAdapter — fork-and-modify scaffold.
// Spec: docs/ADAPTERS.md (in @questi0nm4rk/hook-kit). Anti-patterns + error
// boundaries live there. The demo modules in `hooks.ts` are stubs; the
// adapter itself is the artifact downstream forks. Wire-format-specific
// parsing lives in `./parse-input.ts` — that's the file README step 1
// tells consumers to edit first.

import {
  type EvaluationOutcome,
  formatErrorAnnotation,
  formatNonErrorAnnotation,
  type HookEvent,
  type ProtocolAdapter,
} from "@questi0nm4rk/hook-kit";
import { parseInput } from "./parse-input.js";

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

async function readAllStdin(stdin: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    // Buffer.isBuffer fast-path avoids re-allocating when the iterator
    // already yields Buffer (Bun's `process.stdin`). For everything else
    // (Uint8Array from tests' TextEncoder, or string), `Buffer.from(chunk)`
    // handles both shapes — DO NOT `Buffer.from(String(chunk))` because
    // String(Uint8Array) returns the comma-joined bytes, not text.
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  // Reuse hook-kit's formatter so the line shape (`<prefix> error: <code>: <msg>`)
  // stays in sync with the wrapper + CC adapter.
  for (const a of annotations) {
    if (a.kind === "error") {
      streams.stderr.write(`${formatErrorAnnotation(a, defaultLabel)}\n`);
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
      streams.stdout.write(`${formatNonErrorAnnotation(a, defaultLabel)}\n`);
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
