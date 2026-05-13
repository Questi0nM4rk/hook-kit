import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBuild } from "../../src/build/bundle.js";

// The whole pipeline is slow: bun build --compile produces a ~50 MB
// bytecode binary. 60s gives generous slack for cold caches.
const BUILD_TIMEOUT_MS = 60_000;

const HOOK_KIT_ROOT = resolve(__dirname, "..", "..");

const FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "fixture", name: "fixture-block", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("rm").withFlag("-r").withFlag("-f").deny("[fixture] no rm -rf")],
  ),
];
`;

/** Stage a temp "user plugin" directory with hook-kit symlinked into its
 *  node_modules so `import "@questi0nm4rk/hook-kit"` resolves at build time. */
function stagePlugin(): { dir: string; entry: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hook-kit-e2e-plugin-"));
  const nm = join(dir, "node_modules", "@questi0nm4rk");
  mkdirSync(nm, { recursive: true });
  symlinkSync(HOOK_KIT_ROOT, join(nm, "hook-kit"), "dir");
  // Also symlink shell-ast since hook-kit's runtime imports it.
  symlinkSync(
    resolve(HOOK_KIT_ROOT, "node_modules", "@questi0nm4rk", "shell-ast"),
    join(nm, "shell-ast"),
    "dir",
  );
  // And zod, used by the CC adapter for stdin validation.
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(
    resolve(HOOK_KIT_ROOT, "node_modules", "zod"),
    join(dir, "node_modules", "zod"),
    "dir",
  );
  const srcDir = join(dir, "src");
  mkdirSync(srcDir, { recursive: true });
  const entry = join(srcDir, "hooks.ts");
  writeFileSync(entry, FIXTURE_HOOKS_TS, "utf8");
  return { dir, entry, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("hook-kit build — end to end", () => {
  test(
    "compiles a fixture plugin and the binary blocks the matched command",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        const result = await runBuild({
          entrypoint: entry,
          out,
          adapter: "cc-tools",
        });
        expect(result.binPath).toBe(out);
        expect(existsSync(out)).toBe(true);

        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        const event = JSON.stringify({
          session_id: "s1",
          transcript_path: "/tmp/t.jsonl",
          cwd: "/tmp",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /tmp/x" },
        });
        proc.stdin.write(event);
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[fixture]");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "compiled binary stays silent (exit 0, no stdout) when no rule matches",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "cc-tools" });
        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(
          JSON.stringify({
            session_id: "s1",
            transcript_path: "/tmp/t.jsonl",
            cwd: "/tmp",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "ls -la" },
          }),
        );
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toBe("");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "compiled binary exits 0 silent on empty stdin (fail-open)",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "cc-tools" });
        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).toBe("");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "user entrypoint can be an async function (BUG-003 — supports async init)",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      // Overwrite the staged entry with one whose default export is an
      // async function. Pre-fix, hook-kit only accepted a static
      // `export default [...]` array, forcing users to refactor any async
      // init (e.g. reading a config file) into a sync helper. Post-fix the
      // generated wrapper calls the function if it's callable and awaits
      // the result, so async init works without TLA in user code.
      writeFileSync(
        entry,
        `
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
`,
        "utf8",
      );
      const out = join(dir, "dist", "hooks-tla");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "cc-tools" });
        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(
          JSON.stringify({
            session_id: "s1",
            transcript_path: "/tmp/t.jsonl",
            cwd: "/tmp",
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command: "rm -rf /tmp/x" },
          }),
        );
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[tla-fixture]");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "--target option produces a host-runnable binary (BUG-002 cross-compile wiring)",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks-host");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        // Build with target=bun-linux-x64 (the host) so the produced binary
        // is runnable in CI. The contract under test is that --target is
        // forwarded to bun build and the build succeeds.
        const result = await runBuild({
          entrypoint: entry,
          out,
          adapter: "cc-tools",
          target: "bun-linux-x64",
        });
        expect(result.binPath).toBe(out);
        expect(existsSync(out)).toBe(true);
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
