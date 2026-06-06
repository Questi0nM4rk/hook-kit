// mockAskpass — synthesize a portable POSIX askpass script for tests.
//
// Real askpass scripts read an AskRequest JSON from stdin and write an
// AskResponse JSON to stdout (see src/escalation/envelope.ts for the
// schema). Tests that exercise the .ask() path need an executable script
// path to set HOOK_KIT_ASKPASS to — this factory generates one.
//
// Implementation notes:
// - The response body is built in TypeScript and JSON.stringify'd, then
//   emitted from the script as a SINGLE-QUOTED shell string so that `$`,
//   backticks and `\` in any field value are inert (no shell expansion, no
//   command substitution). This is the security-relevant choice: response
//   fields are author-controlled, but a `"`, backtick, `$(...)` or newline in
//   `reason`/`by`/`decidedAt` must NOT forge JSON fields or execute a command
//   when the script runs as $HOOK_KIT_ASKPASS. See escapeForSingleQuotes.
// - The request id is substituted for a high-entropy sentinel via POSIX
//   parameter expansion (`${t%%s*}` / `${t#*s}`) + printf, NOT sed — so the
//   id is treated as a literal (no `/ & \` re-interpretation) and no second
//   layer of expansion touches the data.
// - mkdtemp under os.tmpdir() so concurrent test runs don't collide.
// - Cleanup is sync (rmSync) — call from afterEach / using-statement.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** rwxr-xr-x — owner-rwx, group/other-rx; required for the askpass script to execute. */
const EXECUTABLE_MODE = 0o755;

/** Default `by` field when the caller omits one (auditing — who decided). */
const DEFAULT_BY = "mockAskpass";
/** Default `decidedAt` — fixed so test snapshots stay deterministic. */
const DEFAULT_DECIDED_AT = "2026-01-01T00:00:00Z";

/**
 * Make `s` safe to embed inside a single-quoted POSIX shell string. The only
 * byte that cannot appear literally inside `'...'` is `'` itself; the standard
 * trick closes the quote, emits an escaped literal quote, and reopens:
 * `'\''`. Every other byte ($, backtick, backslash, newline, ") is inert
 * inside single quotes, so this single substitution is sufficient.
 */
function escapeForSingleQuotes(s: string): string {
  return s.replaceAll("'", "'\\''");
}

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
  const decidedAt = response.decidedAt ?? DEFAULT_DECIDED_AT;
  const by = response.by ?? DEFAULT_BY;

  // Build the response object in TypeScript and JSON.stringify it so every
  // field value is correctly JSON-escaped (a `"` in reason becomes `\"`, a
  // newline becomes `\n`, etc.) — the emitted body is always valid JSON and
  // the fields round-trip exactly. `id` is a per-call high-entropy sentinel,
  // substituted for the request id by the script (see below). Conditional
  // spread keeps `reason` absent (not `undefined`) when omitted, per
  // exactOptionalPropertyTypes.
  const idSentinel = `__HK_ID_${randomUUID()}__`;
  const responseJson = JSON.stringify({
    id: idSentinel,
    decision: response.decision,
    ...(response.reason === undefined ? {} : { reason: response.reason }),
    by,
    decidedAt,
  });

  // Emit the JSON as a single-quoted shell string: $, backtick, backslash and
  // newline in any field value are inert (no expansion, no command sub). The
  // request id is spliced in via POSIX parameter expansion + printf rather
  // than sed, so the id is treated as a literal. The grep pattern guarantees
  // the extracted id contains no `"`; splitting the template at the unique
  // sentinel and rejoining with printf '%s%s%s' keeps the data un-re-parsed.
  const quotedTemplate = escapeForSingleQuotes(responseJson);
  const scriptBody = `#!/bin/sh
RESPONSE='${quotedTemplate}'
REQ=$(cat)
ID=$(printf %s "$REQ" | grep -oE '"id":"[^"]*"' | head -1 | sed 's/"id":"//; s/"$//')
PRE=\${RESPONSE%%${idSentinel}*}
POST=\${RESPONSE#*${idSentinel}}
printf '%s%s%s\\n' "$PRE" "$ID" "$POST"
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
