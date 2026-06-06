import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCcStdout } from "../_helpers.js";
import { stageBinary } from "../build/_staged.js";

const BUILD_TIMEOUT_MS = 60_000;

const FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "fixture", name: "fixture-escalate", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("rm").ask("review this rm before running")],
  ),
];
`;

function stageAskpass(
  workDir: string,
  decision: "allow" | "deny" | "harness-ask",
  reason?: string,
): string {
  // Heredoc avoids POSIX printf's implementation-defined `\"` handling
  // (dash on Ubuntu CI rejects what bash on developer laptops accepts).
  const reasonField = reason === undefined ? "" : `,"reason":"${reason}"`;
  const body = `#!/bin/sh
REQ=$(cat)
ID=$(printf %s "$REQ" | grep -oE '"id":"[^"]*"' | head -1 | sed 's/"id":"//; s/"$//')
cat <<EOF
{"id":"$ID","decision":"${decision}"${reasonField},"decidedAt":"2026-01-01T00:00:00Z"}
EOF
`;
  const path = join(workDir, "askpass.sh");
  writeFileSync(path, body, "utf8");
  // biome-ignore lint/style/noMagicNumbers: rwxr-xr-x literal file mode for executable askpass-script test fixture.
  chmodSync(path, 0o755);
  return path;
}

const ESCALATE_EVENT = JSON.stringify({
  session_id: "e2e-session",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm /tmp/x" },
});

describe("escalation — compiled binary + askpass", () => {
  test(
    "askpass returns allow → binary stays silent",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-esc-e2e-",
      });
      try {
        const askpass = stageAskpass(staged.dir, "allow");
        const r = await staged.runStdin(ESCALATE_EVENT, { HOOK_KIT_ASKPASS: askpass });
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "askpass returns deny → binary emits CC block JSON",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-esc-e2e-",
      });
      try {
        const askpass = stageAskpass(staged.dir, "deny", "policy violation");
        const r = await staged.runStdin(ESCALATE_EVENT, { HOOK_KIT_ASKPASS: askpass });
        expect(r.exit).toBe(0);
        const parsed = parseCcStdout(r.stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("policy violation");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "askpass returns harness-ask → binary emits CC ask JSON",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-esc-e2e-",
      });
      try {
        const askpass = stageAskpass(staged.dir, "harness-ask");
        const r = await staged.runStdin(ESCALATE_EVENT, { HOOK_KIT_ASKPASS: askpass });
        expect(r.exit).toBe(0);
        const parsed = parseCcStdout(r.stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
          "review this rm before running",
        );
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "no askpass set → binary emits CC ask JSON (delegate to harness UI)",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-esc-e2e-",
      });
      try {
        // Strip HOOK_KIT_ASKPASS so the binary has no broker infra configured
        // and delegates to the harness UI (CC ask JSON). runBin merges the
        // passed env over process.env (`{ ...process.env, ...env }`), so to
        // guarantee the key is neutralized regardless of what another test in
        // this bun process may have leaked into process.env, we override it to
        // "". The binary treats "" identically to unset (callAskpass: `askpass
        // === undefined || askpass === ""`), so this restores the pre-refactor
        // hermeticity (the old code built a filtered full env via
        // Object.fromEntries) without depending on no other test having set it.
        const r = await staged.runStdin(ESCALATE_EVENT, { HOOK_KIT_ASKPASS: "" });
        expect(r.exit).toBe(0);
        const parsed = parseCcStdout(r.stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
          "review this rm before running",
        );
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
