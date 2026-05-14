// Forwarder — implements the synchronous "escalate-up" verb.
// See docs/SPEC.md § Escalation § Tree-shaped escalation.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitErrorLine, JsonParseError } from "../core/errors.js";
import { brokerPaths, ensureSession, type SessionMeta } from "./broker.js";
import {
  type AskResponse,
  createAskResponse,
  parseAskRequest,
  parseAskResponse,
} from "./envelope.js";

export interface ForwardOptions {
  readonly root?: string;
  /** Polling interval while waiting for the parent's decision. */
  readonly pollMs?: number;
  /** Optional bound on how long to wait at the parent. Default: no timeout. */
  readonly timeoutMs?: number;
  /** Identity of this forwarder for the audit trail. */
  readonly by?: string;
}

export interface ForwardResult {
  readonly kind: "forwarded" | "harness-ask" | "missing-pending";
  readonly response?: AskResponse;
  readonly parentSessionId?: string;
}

/**
 * One forwarding hop. Reads pending/<id>.json from the source session,
 * republishes the same envelope at the parent's pending/<id>.json, then
 * polls the parent's decided/<id>.json. When the parent's decision lands,
 * copies it down to the source's decided/<id>.json so the original hook
 * unblocks.
 *
 * If the source has no parent (`meta.json.parentSessionId` undefined), the
 * forwarder terminates the chain at `harness-ask` — the hook adapter's
 * native ask UI takes over (CC's `permissionDecision: "ask"`).
 */
export async function forwardUp(
  sessionId: string,
  requestId: string,
  opts: ForwardOptions = {},
): Promise<ForwardResult> {
  const sourcePaths = brokerPaths(sessionId, opts.root);
  const sourcePending = join(sourcePaths.pendingDir, `${requestId}.json`);
  if (!existsSync(sourcePending)) {
    return { kind: "missing-pending" };
  }
  const envelope = parseAskRequest(readFileSync(sourcePending, "utf8"));

  const parentSessionId = readParentId(sourcePaths.metaPath);
  if (parentSessionId === undefined) {
    const harnessResponse = createAskResponse({
      id: requestId,
      decision: "harness-ask",
      reason: "[hook-kit] forwarded to harness — no parent in chain",
      ...(opts.by !== undefined ? { by: opts.by } : {}),
    });
    const sourceDecided = join(sourcePaths.decidedDir, `${requestId}.json`);
    writeIfAbsent(sourceDecided, JSON.stringify(harnessResponse));
    return { kind: "harness-ask", response: harnessResponse };
  }

  const parentPaths = ensureSession(parentSessionId, {
    ...(opts.root !== undefined ? { root: opts.root } : {}),
  });
  const parentPending = join(parentPaths.pendingDir, `${requestId}.json`);
  const parentDecided = join(parentPaths.decidedDir, `${requestId}.json`);

  const forwardedEnvelope = { ...envelope, forwarded_from: sessionId };
  writeIfAbsent(parentPending, JSON.stringify(forwardedEnvelope));

  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  while (true) {
    if (existsSync(parentDecided)) {
      const raw = readFileSync(parentDecided, "utf8");
      const parsed = parseAskResponse(raw);
      const sourceDecided = join(sourcePaths.decidedDir, `${requestId}.json`);
      writeIfAbsent(sourceDecided, raw);
      return { kind: "forwarded", response: parsed, parentSessionId };
    }
    if (opts.timeoutMs !== undefined && Date.now() - start >= opts.timeoutMs) {
      const timeoutResponse = createAskResponse({
        id: requestId,
        decision: "deny",
        reason: `[hook-kit forward] no parent decision in ${Math.round(opts.timeoutMs / 1000)}s`,
        ...(opts.by !== undefined ? { by: opts.by } : {}),
      });
      const sourceDecided = join(sourcePaths.decidedDir, `${requestId}.json`);
      writeIfAbsent(sourceDecided, JSON.stringify(timeoutResponse));
      return { kind: "forwarded", response: timeoutResponse, parentSessionId };
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

function readParentId(metaPath: string): string | undefined {
  if (!existsSync(metaPath)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    return meta.parentSessionId;
  } catch (cause) {
    emitErrorLine(new JsonParseError(metaPath, cause));
    return undefined;
  }
}

function writeIfAbsent(path: string, data: string): void {
  try {
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (
      err === null ||
      typeof err !== "object" ||
      !("code" in err) ||
      (err as { code?: unknown }).code !== "EEXIST"
    ) {
      throw err;
    }
    // Already exists — fine.
  }
}
