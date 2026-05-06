// Git enrichment for ask envelopes — opt-in via HOOK_KIT_ENRICH_GIT=1 or
// explicit invocation. Cheap shell-outs against `git -C <cwd>`. All failures
// swallow to undefined (Iron Law 3: never break the hook over enrichment).

import type { GitInfo } from "./envelope.js";

async function runGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return undefined;
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Returns git context for `cwd` if it's inside a repo, undefined otherwise.
 * Runs four cheap shell-outs in parallel after the repo check; any individual
 * failure leaves that field unset rather than failing the whole enrichment.
 */
export async function enrichGit(cwd: string): Promise<GitInfo | undefined> {
  const sha = await runGit(cwd, ["rev-parse", "HEAD"]);
  if (sha === undefined) return undefined;

  const [branch, status, remote] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["status", "--porcelain"]),
    runGit(cwd, ["remote", "get-url", "origin"]),
  ]);

  return {
    sha,
    ...(branch !== undefined && branch !== "HEAD" ? { branch } : {}),
    ...(status !== undefined ? { dirty: status.length > 0 } : {}),
    ...(remote !== undefined && remote !== "" ? { remote } : {}),
  };
}

/** True when HOOK_KIT_ENRICH_GIT is set to a truthy value. */
export function gitEnrichmentEnabled(): boolean {
  const v = process.env.HOOK_KIT_ENRICH_GIT;
  return v === "1" || v === "true";
}
