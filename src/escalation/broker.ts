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

const DEFAULT_ROOT = join(homedir(), ".cache", "hook-kit", "sessions");
const DEFAULT_POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 60_000;

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
  readonly timeoutMs?: number;
}

/**
 * Run the broker in askpass mode: read an AskRequest from stdin, stage it on
 * the spool, wait for a decision (or auto-deny on timeout), and write the
 * AskResponse to stdout. Always exits 0 — the askpass contract reserves
 * non-zero exits for transport failures, not policy decisions.
 */
export async function brokerAskpass(
  stdinText: string,
  opts: BrokerAskpassOptions = {},
): Promise<AskResponse> {
  const root = opts.root ?? DEFAULT_ROOT;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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

  // Wait for a decided/<id>.json file or timeout.
  const start = Date.now();
  while (true) {
    if (existsSync(decidedPath)) {
      try {
        const raw = readFileSync(decidedPath, "utf8");
        const response = parseAskResponse(raw);
        // Cleanup
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
        // Bad decision file — log and treat as auto-deny.
        audit(paths, {
          kind: "decision-malformed",
          id: request.id,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(pollMs);
  }

  // Timeout or malformed decision: write our own deny so any race-late writer
  // sees the slot already taken.
  const autoDeny = createAskResponse({
    id: request.id,
    decision: "deny",
    reason: `[hook-kit broker] no decision in ${Math.round(timeoutMs / 1000)}s. Original: ${request.reason}`,
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
