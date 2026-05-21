// mockAskpass — synthesize a portable POSIX askpass script for tests.
//
// Real askpass scripts read an AskRequest JSON from stdin and write an
// AskResponse JSON to stdout (see src/escalation/envelope.ts for the
// schema). Tests that exercise the .ask() path need an executable script
// path to set HOOK_KIT_ASKPASS to — this factory generates one.
//
// Implementation notes:
// - Uses an unquoted heredoc so $ID expands but the response body is
//   otherwise literal. Avoids POSIX printf's implementation-defined
//   handling of \" in single-quoted format strings (dash vs bash diverge).
//   Reference: ~/.claude/projects/.../memory/project/dash-vs-bash-printf-divergence.md
// - mkdtemp under os.tmpdir() so concurrent test runs don't collide.
// - Cleanup is sync (rmSync) — call from afterEach / using-statement.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** rwxr-xr-x — owner-rwx, group/other-rx; required for the askpass script to execute. */
const EXECUTABLE_MODE = 0o755;

/** @stable @since 1.0.0 */
export interface MockAskpassResponse {
  /** What the askpass returns for every request. `"allow"` lets the
   *  command run; `"deny"` blocks it; `"harness-ask"` delegates upstream
   *  (the engine treats this as fall-through to harness UI). */
  readonly decision: "allow" | "deny" | "harness-ask";
  /** Optional reason string; surfaces in the engine's resolved outcome. */
  readonly reason?: string;
  /** Optional `by` field (auditing — who/what made the decision). Default
   *  `"mockAskpass"`. */
  readonly by?: string;
  /** ISO timestamp for `decidedAt`. Default fixed value
   *  `"2026-01-01T00:00:00Z"` so test snapshots stay deterministic. */
  readonly decidedAt?: string;
}

/** @stable @since 1.0.0 */
export interface MockAskpass {
  /** Absolute path to the generated executable script. Set
   *  `HOOK_KIT_ASKPASS` to this value, or spread the `env` field into a
   *  child process. */
  readonly path: string;
  /** Pre-built env mapping `{HOOK_KIT_ASKPASS: path}` for ergonomic spread:
   *  `Bun.spawn(cmd, { env: { ...process.env, ...askpass.env } })`. */
  readonly env: Readonly<Record<string, string>>;
  /** Remove the temp dir and script. Idempotent — safe to call multiple
   *  times. Throws on filesystem errors (deliberate — silent cleanup
   *  failures hide test pollution per 0-silent-fails policy). */
  cleanup(): void;
}

/**
 * Create a one-shot askpass script that always returns `response` regardless
 * of the request body. The script preserves the request's `id` field so the
 * engine's response-validation passes.
 *
 *   const askpass = mockAskpass({ decision: "allow" });
 *   try {
 *     process.env.HOOK_KIT_ASKPASS = askpass.path;
 *     const out = await expectModule(mod).onCommand("...").outcome();
 *   } finally {
 *     askpass.cleanup();
 *   }
 *
 * For repeated per-test cleanup, wire `cleanup()` into `afterEach`. For
 * complex multi-response scenarios (different decisions per request),
 * write a custom script — `mockAskpass` is for the common "always X" case.
 * @stable @since 1.0.0
 */
export function mockAskpass(response: MockAskpassResponse): MockAskpass {
  const decidedAt = response.decidedAt ?? "2026-01-01T00:00:00Z";
  const by = response.by ?? "mockAskpass";
  const reasonField = response.reason === undefined ? "" : `,"reason":"${response.reason}"`;
  const byField = `,"by":"${by}"`;

  const scriptBody = `#!/bin/sh
REQ=$(cat)
ID=$(printf %s "$REQ" | grep -oE '"id":"[^"]*"' | head -1 | sed 's/"id":"//; s/"$//')
cat <<EOF
{"id":"$ID","decision":"${response.decision}"${reasonField}${byField},"decidedAt":"${decidedAt}"}
EOF
`;

  const workDir = mkdtempSync(join(tmpdir(), "hook-kit-mockaskpass-"));
  const path = join(workDir, "mock-askpass.sh");
  writeFileSync(path, scriptBody, "utf8");
  chmodSync(path, EXECUTABLE_MODE);

  return {
    path,
    env: Object.freeze({ HOOK_KIT_ASKPASS: path }),
    cleanup(): void {
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
