// Escalation envelope — the JSON payload published from a hook to the askpass
// channel and back. See docs/SPEC.md § Escalation.

import { randomUUID } from "node:crypto";
import { z } from "zod";

const PROTOCOL_VERSION = 1 as const;

const AskRequestSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentSessionId: z.string().optional(),
  toolName: z.string(),
  toolInput: z.record(z.unknown()),
  reason: z.string(),
  label: z.string().optional(),
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

export interface CreateAskOptions {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly label?: string;
  /** Wall-clock TTL in milliseconds; default 60_000 (matches the spec's
   *  60s hard cap for non-human responders). */
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createAskRequest(opts: CreateAskOptions): AskRequest {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const created = new Date();
  const expires = new Date(created.getTime() + ttl);
  const base = {
    version: PROTOCOL_VERSION,
    id: randomUUID(),
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    toolInput: opts.toolInput,
    reason: opts.reason,
    createdAt: created.toISOString(),
    expiresAt: expires.toISOString(),
  };
  // Conditionally include optional fields so exactOptionalPropertyTypes is happy.
  if (opts.parentSessionId !== undefined && opts.label !== undefined) {
    return { ...base, parentSessionId: opts.parentSessionId, label: opts.label };
  }
  if (opts.parentSessionId !== undefined) {
    return { ...base, parentSessionId: opts.parentSessionId };
  }
  if (opts.label !== undefined) {
    return { ...base, label: opts.label };
  }
  return base;
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
  const base = {
    id: opts.id,
    decision: opts.decision,
    decidedAt: new Date().toISOString(),
  };
  if (opts.reason !== undefined && opts.by !== undefined) {
    return { ...base, reason: opts.reason, by: opts.by };
  }
  if (opts.reason !== undefined) return { ...base, reason: opts.reason };
  if (opts.by !== undefined) return { ...base, by: opts.by };
  return base;
}

export { PROTOCOL_VERSION };
