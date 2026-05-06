// Escalation envelope — the JSON payload published from a hook to the askpass
// channel and back. See docs/SPEC.md § Escalation.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";

const PROTOCOL_VERSION = 2 as const;

const HarnessSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

const GitInfoSchema = z.object({
  sha: z.string().min(1),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  remote: z.string().optional(),
});

const AskRequestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentSessionId: z.string().optional(),
  // Origin process / host context — autofilled by createAskRequest.
  pid: z.number().int().nonnegative(),
  host: z.string().min(1),
  user: z.string().min(1),
  // Which harness produced this ask (e.g. claude-code, cursor).
  harness: HarnessSchema,
  // The ask itself.
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  reason: z.string(),
  label: z.string().optional(),
  // Origin context from the HookEvent.
  cwd: z.string(),
  transcriptPath: z.string(),
  // Optional git context — populated when HOOK_KIT_ENRICH_GIT=1 or the
  // adapter calls enrichGit() explicitly.
  git: GitInfoSchema.optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

const AskResponseSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["allow", "deny", "harness-ask"]),
  reason: z.string().optional(),
  by: z.string().optional(),
  decidedAt: z.string(),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskDecisionKind = "allow" | "deny" | "harness-ask";
export type AskResponse = z.infer<typeof AskResponseSchema>;
export type Harness = z.infer<typeof HarnessSchema>;
export type GitInfo = z.infer<typeof GitInfoSchema>;

export interface CreateAskOptions {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly label?: string;
  /** Defaults to `{ name: "unknown" }` — adapters should always pass their own. */
  readonly harness?: Harness;
  /** Defaults to `process.cwd()`. Adapters should pass `event.cwd`. */
  readonly cwd?: string;
  /** Defaults to `""`. Adapters should pass `event.transcriptPath` when known. */
  readonly transcriptPath?: string;
  /** Optional git context. Caller is responsible for invoking `enrichGit()`. */
  readonly git?: GitInfo;
  /** Override autofilled pid (defaults to `process.pid`). */
  readonly pid?: number;
  /** Override autofilled hostname. */
  readonly host?: string;
  /** Override autofilled user. */
  readonly user?: string;
  /** Wall-clock TTL in milliseconds; default 60_000 (matches the spec's
   *  60s hard cap for non-human responders). */
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

function detectUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? process.env.LOGNAME ?? "unknown";
}

export function createAskRequest(opts: CreateAskOptions): AskRequest {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const created = new Date();
  const expires = new Date(created.getTime() + ttl);
  const base = {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    sessionId: opts.sessionId,
    pid: opts.pid ?? process.pid,
    host: opts.host ?? hostname(),
    user: opts.user ?? detectUser(),
    harness: opts.harness ?? { name: "unknown" },
    toolName: opts.toolName,
    toolInput: opts.toolInput,
    reason: opts.reason,
    cwd: opts.cwd ?? process.cwd(),
    transcriptPath: opts.transcriptPath ?? "",
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
  };
  // Conditionally include optional fields so exactOptionalPropertyTypes is happy.
  return {
    ...base,
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  };
}

export function parseAskRequest(raw: string): AskRequest {
  const json: unknown = JSON.parse(raw);
  return AskRequestSchema.parse(json);
}

export function parseAskResponse(raw: string): AskResponse {
  const json: unknown = JSON.parse(raw);
  return AskResponseSchema.parse(json);
}

export interface CreateResponseOptions {
  readonly id: string;
  readonly decision: AskDecisionKind;
  readonly reason?: string;
  readonly by?: string;
}

export function createAskResponse(opts: CreateResponseOptions): AskResponse {
  return {
    id: opts.id,
    decision: opts.decision,
    decidedAt: new Date().toISOString(),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
  };
}

export { PROTOCOL_VERSION };
