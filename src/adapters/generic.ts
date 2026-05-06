// Generic adapter — minimal JSON-in / JSON-out wire contract.
// See docs/SPEC.md § Protocol Adapters.
//
// Input envelope (stdin, single JSON object):
//   {
//     sessionId:      string,
//     toolName:       string,
//     toolInput:      Record<string, unknown>,
//     cwd?:           string,           // defaults to ""
//     transcriptPath?: string,          // defaults to ""
//     eventName?:     string,           // defaults to "PreToolUse"
//     parentSessionId?: string,         // exposed via process.env on the broker side
//   }
//
// Output (stdout, single JSON object, exit 0):
//   - null decision      → { kind: null }
//   - non-null decision  → the Decision verbatim
//
// On any read/parse failure → exit 0 silent (Iron Law 3 fail-open).
// This adapter is the contract any custom harness can wrap with shell glue
// (transform native input → generic envelope → exec binary → translate output).

import { z } from "zod";
import type { Decision, HookEvent } from "../core/types.js";
import type { ProtocolAdapter } from "./types.js";

const GenericInputSchema = z.object({
  sessionId: z.string().min(1),
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  cwd: z.string().optional(),
  transcriptPath: z.string().optional(),
  eventName: z.string().optional(),
  parentSessionId: z.string().optional(),
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const genericAdapter: ProtocolAdapter = {
  async readInput(): Promise<HookEvent> {
    const raw = await readStdin();
    if (raw.trim() === "") {
      throw new Error("[hook-kit/generic] empty stdin");
    }
    const json: unknown = JSON.parse(raw);
    const parsed = GenericInputSchema.parse(json);
    return {
      eventName: parsed.eventName ?? "PreToolUse",
      sessionId: parsed.sessionId,
      cwd: parsed.cwd ?? "",
      transcriptPath: parsed.transcriptPath ?? "",
      toolName: parsed.toolName,
      toolInput: parsed.toolInput,
      raw: parsed as Readonly<Record<string, unknown>>,
    };
  },

  writeOutput(decision: Decision): void {
    if (decision === null) {
      process.stdout.write(`${JSON.stringify({ kind: null })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(decision)}\n`);
    }
    process.exit(0);
  },

  handleError(_error: unknown): void {
    // Iron Law 3 — fail open silent.
    process.exit(0);
  },
};
