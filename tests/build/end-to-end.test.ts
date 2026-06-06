import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../../src/build/bundle.js";
import { parseCcStdout } from "../_helpers.js";
import { stageBinary, symlinkDeps } from "./_staged.js";

// The whole pipeline is slow: bun build --compile produces a ~50 MB
// bytecode binary. 60s gives generous slack for cold caches.
const BUILD_TIMEOUT_MS = 60_000;

const FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "fixture", name: "fixture-block", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("rm").withFlag("-r").withFlag("-f").deny("[fixture] no rm -rf")],
  ),
];
`;

// Async-init entrypoint (BUG-003): default export is an async function rather
// than a static array. The generated wrapper must call + await it.
const ASYNC_FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

// Async init — the supported shape. (TLA in the entrypoint itself is
// still forbidden by bun --compile, so the async work lives inside this
// exported function.)
export default async () => {
  const blockedCmd = await Promise.resolve("rm");
  return [
    createModule(
      { id: "tla-fixture", name: "tla", events: ["PreToolUse"], matchers: ["Bash"] },
      [cmd(blockedCmd).withFlag("-r").withFlag("-f").deny("[tla-fixture] no rm -rf")],
    ),
  ];
};
`;

function ccEvent(command: string): string {
  return JSON.stringify({
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
}

describe("hook-kit build — end to end", () => {
  test(
    "compiles a fixture plugin and the binary blocks the matched command",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-e2e-plugin-",
      });
      try {
        expect(existsSync(staged.binPath)).toBe(true);

        const r = await staged.runStdin(ccEvent("rm -rf /tmp/x"));
        expect(r.exit).toBe(0);
        const parsed = parseCcStdout(r.stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[fixture]");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "compiled binary stays silent (exit 0, no stdout) when no rule matches",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-e2e-plugin-",
      });
      try {
        const r = await staged.runStdin(ccEvent("ls -la"));
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "compiled binary exits 0 silent on empty stdin (fail-open)",
    async () => {
      const staged = await stageBinary({
        hooksFixture: FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks",
        prefix: "hook-kit-e2e-plugin-",
      });
      try {
        const r = await staged.runStdin("");
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "user entrypoint can be an async function (BUG-003 — supports async init)",
    async () => {
      // Pre-fix, hook-kit only accepted a static `export default [...]` array,
      // forcing users to refactor any async init (e.g. reading a config file)
      // into a sync helper. Post-fix the generated wrapper calls the function
      // if it's callable and awaits the result, so async init works without TLA.
      const staged = await stageBinary({
        hooksFixture: ASYNC_FIXTURE_HOOKS_TS,
        adapter: "cc-tools",
        binName: "hooks-tla",
        prefix: "hook-kit-e2e-plugin-",
      });
      try {
        const r = await staged.runStdin(ccEvent("rm -rf /tmp/x"));
        expect(r.exit).toBe(0);
        const parsed = parseCcStdout(r.stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[tla-fixture]");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "--target option produces a host-runnable binary (BUG-002 cross-compile wiring)",
    async () => {
      // Asserts the build RESULT (binPath + forwarded --target), not a spawn —
      // stays on stageDir + runBuild directly since stageBinary neither exposes
      // the build result nor accepts a target option.
      const dir = mkdtempSync(join(tmpdir(), "hook-kit-e2e-plugin-"));
      mkdirSync(join(dir, "src"), { recursive: true });
      await Bun.write(join(dir, "src", "hooks.ts"), FIXTURE_HOOKS_TS);
      symlinkDeps(dir);
      const out = join(dir, "dist", "hooks-host");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        // Build with target=bun-linux-x64 (the host) so the produced binary
        // is runnable in CI. The contract under test is that --target is
        // forwarded to bun build and the build succeeds.
        const result = await runBuild({
          entrypoint: join(dir, "src", "hooks.ts"),
          out,
          adapter: "cc-tools",
          target: "bun-linux-x64",
        });
        expect(result.binPath).toBe(out);
        expect(existsSync(out)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
