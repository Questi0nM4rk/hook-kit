// Default broker — per-session ask channels backed by a filesystem spool.
// See docs/SPEC.md § Escalation § Default Broker.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AskDecisionKind,
  type AskRequest,
  type AskResponse,
  createAskResponse,
  parseAskRequest,
  parseAskResponse,
} from "./envelope.js";
import { hasParentListener } from "./listeners.js";

const DEFAULT_ROOT = join(homedir(), ".cache", "hook-kit", "sessions");
const DEFAULT_POLL_MS = 100;

export interface BrokerPaths {
  readonly sessionDir: string;
  readonly pendingDir: string;
  readonly decidedDir: string;
  readonly metaPath: string;
  readonly auditPath: string;
}

export interface SessionMeta {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly startedAt: string;
  readonly pid: number;
}

export interface SessionInfo extends SessionMeta {
  readonly pendingCount: number;
}

/** Resolve the on-disk paths for a given session. Does not touch the filesystem. */
export function brokerPaths(sessionId: string, root: string = DEFAULT_ROOT): BrokerPaths {
  const sessionDir = join(root, sessionId);
  return {
    sessionDir,
    pendingDir: join(sessionDir, "pending"),
    decidedDir: join(sessionDir, "decided"),
    metaPath: join(sessionDir, "meta.json"),
    auditPath: join(sessionDir, "audit.jsonl"),
  };
}

/**
 * Ensure the spool tree exists for this session and write meta.json with
 * lineage info if it doesn't already exist. Idempotent.
 */
export function ensureSession(
  sessionId: string,
  opts: { parentSessionId?: string; root?: string } = {},
): BrokerPaths {
  const paths = brokerPaths(sessionId, opts.root ?? DEFAULT_ROOT);
  mkdirSync(paths.pendingDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.decidedDir, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.metaPath)) {
    const meta: SessionMeta = {
      sessionId,
      ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
      startedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(paths.metaPath, JSON.stringify(meta), { mode: 0o600 });
  }
  return paths;
}

/** Append one event to the session's audit log; never throws. */
function audit(paths: BrokerPaths, event: Record<string, unknown>): void {
  try {
    appendFileSync(
      paths.auditPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
  } catch {
    // Iron Law 3: audit failures are not load-bearing.
  }
}

/**
 * Atomic write via O_EXCL. Returns true if this caller created the file,
 * false if a file with the same path already existed (first-writer-wins).
 */
function atomicWriteIfAbsent(path: string, data: string): boolean {
  try {
    writeFileSync(path, data, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "EEXIST"
    ) {
      return false;
    }
    throw err;
  }
}

export interface BrokerAskpassOptions {
  readonly root?: string;
  readonly pollMs?: number;
  /**
   * Optional poll deadline. The broker's default is **no internal timeout** —
   * questions sit in the spool until either a listener responds or the
   * caller process is killed externally (e.g., by CC's hooks.json timeout).
   * Pass a positive number to bound the wait for tests or specialized cases.
   */
  readonly timeoutMs?: number;
  /**
   * Bypass the parent-listener validator. Set to `true` only in tests where
   * you've already verified or staged listeners by hand.
   */
  readonly skipValidator?: boolean;
}

/**
 * Run the broker in askpass mode: read an AskRequest from stdin, validate
 * that a parent listener is reachable, stage on the spool, then poll until
 * a decision lands. Always returns; never throws.
 *
 * Validator: walks the parent_session_id chain and looks for a live listener
 * (a process with a current marker file in `<session>/listeners/`). If none
 * is found anywhere in the chain, the request is denied immediately with
 * "NO PARENT ATTACHED". Non-escalate decisions in the calling adapter are
 * unaffected — the validator only fires when an `escalate` decision drives
 * the broker.
 */
export async function brokerAskpass(
  stdinText: string,
  opts: BrokerAskpassOptions = {},
): Promise<AskResponse> {
  const root = opts.root ?? DEFAULT_ROOT;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs;

  let request: AskRequest;
  try {
    request = parseAskRequest(stdinText);
  } catch (err) {
    // Malformed envelope — synthesize an id-less deny so callAskpass's id-match
    // check fails cleanly with a visible reason, rather than crashing.
    return createAskResponse({
      id: "<malformed>",
      decision: "deny",
      reason: `[hook-kit broker] malformed request envelope: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }

  const paths = ensureSession(request.sessionId, {
    ...(request.parentSessionId !== undefined ? { parentSessionId: request.parentSessionId } : {}),
    root,
  });

  // Validator: at least one live listener must be reachable up the chain.
  if (opts.skipValidator !== true && !hasParentListener(request.sessionId, { root })) {
    audit(paths, { kind: "no-parent-deny", id: request.id });
    return createAskResponse({
      id: request.id,
      decision: "deny",
      reason: `[hook-kit] NO PARENT ATTACHED — no live listener found anywhere in the parent chain. Original: ${request.reason}`,
      by: "broker:validator",
    });
  }

  const pendingPath = join(paths.pendingDir, `${request.id}.json`);
  const decidedPath = join(paths.decidedDir, `${request.id}.json`);

  const wrote = atomicWriteIfAbsent(pendingPath, JSON.stringify(request));
  if (!wrote) {
    // A request with this id was already in flight. Highly unusual (UUID
    // collision). Treat as a duplicate and deny rather than racing.
    return createAskResponse({
      id: request.id,
      decision: "deny",
      reason: "[hook-kit broker] duplicate request id",
    });
  }
  audit(paths, { kind: "pending", id: request.id, toolName: request.toolName });

  // Poll for decided/<id>.json. With no timeout (default), this loops until
  // either a listener writes a decision or the broker process is killed.
  const start = Date.now();
  while (true) {
    if (existsSync(decidedPath)) {
      try {
        const raw = readFileSync(decidedPath, "utf8");
        const response = parseAskResponse(raw);
        try {
          rmSync(pendingPath, { force: true });
          rmSync(decidedPath, { force: true });
        } catch {
          // ignore
        }
        audit(paths, {
          kind: "decided",
          id: request.id,
          decision: response.decision,
          ...(response.by !== undefined ? { by: response.by } : {}),
        });
        return response;
      } catch (err) {
        audit(paths, {
          kind: "decision-malformed",
          id: request.id,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (timeoutMs !== undefined && Date.now() - start >= timeoutMs) break;
    await sleep(pollMs);
  }

  // We only get here on a) malformed decision file or b) opt-in timeout
  // expiry. Write our own deny so any race-late real writer loses cleanly.
  const reason =
    timeoutMs !== undefined
      ? `[hook-kit broker] no decision in ${Math.round(timeoutMs / 1000)}s. Original: ${request.reason}`
      : `[hook-kit broker] decision file was malformed; original: ${request.reason}`;
  const autoDeny = createAskResponse({
    id: request.id,
    decision: "deny",
    reason,
    by: "broker:auto-deny",
  });
  atomicWriteIfAbsent(decidedPath, JSON.stringify(autoDeny));
  try {
    rmSync(pendingPath, { force: true });
    rmSync(decidedPath, { force: true });
  } catch {
    // ignore
  }
  audit(paths, { kind: "auto-deny", id: request.id });
  return autoDeny;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───────────────────── Listener primitives ─────────────────────

export interface ListSessionsOptions {
  /** Restrict to sessions whose meta.parent_session_id matches. */
  readonly childrenOf?: string;
  readonly root?: string;
}

/** Snapshot of all session ask channels currently on disk. */
export function listSessions(opts: ListSessionsOptions = {}): SessionInfo[] {
  const root = opts.root ?? DEFAULT_ROOT;
  if (!existsSync(root)) return [];
  const sessions: SessionInfo[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
      if (opts.childrenOf !== undefined && meta.parentSessionId !== opts.childrenOf) continue;
      const pendingDir = join(dir, "pending");
      const pendingCount = existsSync(pendingDir) ? readdirSync(pendingDir).length : 0;
      sessions.push({ ...meta, pendingCount });
    } catch {
      // skip malformed session dirs
    }
  }
  return sessions;
}

/** Snapshot of pending requests for a session. */
export function listPending(sessionId: string, opts: { root?: string } = {}): AskRequest[] {
  const paths = brokerPaths(sessionId, opts.root ?? DEFAULT_ROOT);
  if (!existsSync(paths.pendingDir)) return [];
  const out: AskRequest[] = [];
  for (const entry of readdirSync(paths.pendingDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(paths.pendingDir, entry), "utf8");
      out.push(parseAskRequest(raw));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface SubmitDecisionOptions {
  readonly root?: string;
  readonly by?: string;
}

/**
 * Atomically submit a decision for a pending request. Returns true if this
 * caller's decision was accepted, false if a decision had already been
 * written (first-writer-wins; the broker's auto-deny also goes through this
 * path so a late real submission loses cleanly).
 */
export function submitDecision(
  sessionId: string,
  requestId: string,
  decision: AskDecisionKind,
  reason?: string,
  opts: SubmitDecisionOptions = {},
): boolean {
  const paths = brokerPaths(sessionId, opts.root ?? DEFAULT_ROOT);
  if (!existsSync(paths.decidedDir)) {
    mkdirSync(paths.decidedDir, { recursive: true, mode: 0o700 });
  }
  const decidedPath = join(paths.decidedDir, `${requestId}.json`);
  const response = createAskResponse({
    id: requestId,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(opts.by !== undefined ? { by: opts.by } : {}),
  });
  return atomicWriteIfAbsent(decidedPath, JSON.stringify(response));
}

export { DEFAULT_ROOT };
