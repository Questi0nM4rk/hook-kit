// Listener markers — per-session liveness records that the validator uses
// to answer "is anyone watching this ask channel?" before staging pending.
// See docs/SPEC.md § Escalation § Default Broker.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brokerPaths, type SessionMeta } from "./broker.js";

export type ListenerMode = "subscribe" | "watch";

export interface ListenerMarker {
  readonly pid: number;
  readonly mode: ListenerMode;
  readonly sessionId: string;
  readonly startedAt: string;
}

export interface RegisterOptions {
  readonly root?: string;
}

/**
 * Drop a marker file announcing this process as a live listener for the
 * given session. Returns a cleanup function that removes the marker on
 * graceful exit. Stale markers (process gone) are pruned on the next scan.
 */
export function registerListener(
  sessionId: string,
  mode: ListenerMode,
  opts: RegisterOptions = {},
): () => void {
  const paths = brokerPaths(sessionId, opts.root);
  const listenersDir = join(paths.sessionDir, "listeners");
  mkdirSync(listenersDir, { recursive: true, mode: 0o700 });
  const marker: ListenerMarker = {
    pid: process.pid,
    mode,
    sessionId,
    startedAt: new Date().toISOString(),
  };
  const path = join(listenersDir, `${process.pid}.lock`);
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  return () => {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore — best effort
    }
  };
}

/**
 * True if `pid` corresponds to a process that's still alive on this host.
 * Uses kill(pid, 0) which doesn't actually signal — POSIX standard liveness
 * probe.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err) {
      const code = (err as { code?: unknown }).code;
      // EPERM means the process exists but we can't signal it — still alive.
      return code === "EPERM";
    }
    return false;
  }
}

/**
 * Scan the listener markers for a session, return the live ones, and
 * (best-effort) prune any stale markers found.
 */
export function liveListeners(sessionId: string, opts: { root?: string } = {}): ListenerMarker[] {
  const paths = brokerPaths(sessionId, opts.root);
  const dir = join(paths.sessionDir, "listeners");
  if (!existsSync(dir)) return [];
  const live: ListenerMarker[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".lock")) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, "utf8");
      const marker = JSON.parse(raw) as ListenerMarker;
      if (isAlive(marker.pid)) {
        live.push(marker);
      } else {
        try {
          rmSync(path, { force: true });
        } catch {
          // ignore
        }
      }
    } catch {
      // unreadable / malformed — try to remove
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
  }
  return live;
}

/**
 * Walk the parent_session_id chain (starting at sessionId, then up via
 * meta.json) and return true if any session in the chain has at least one
 * live listener. Cycle-safe via a visited set.
 */
export function hasParentListener(sessionId: string, opts: { root?: string } = {}): boolean {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    if (liveListeners(current, opts).length > 0) return true;
    current = readParentId(current, opts);
  }
  return false;
}

function readParentId(sessionId: string, opts: { root?: string } = {}): string | undefined {
  const metaPath = brokerPaths(sessionId, opts.root).metaPath;
  if (!existsSync(metaPath)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
    return meta.parentSessionId;
  } catch {
    return undefined;
  }
}
