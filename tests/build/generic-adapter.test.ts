import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBuild } from "../../src/build/bundle.js";

const BUILD_TIMEOUT_MS = 60_000;
const HOOK_KIT_ROOT = resolve(__dirname, "..", "..");

const FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "fixture", name: "block-rm-rf", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("rm").withFlag("-r").withFlag("-f").deny("[fixture] no rm -rf")],
  ),
];
`;

function stagePlugin(): { dir: string; entry: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hook-kit-generic-e2e-"));
  const nm = join(dir, "node_modules", "@questi0nm4rk");
  mkdirSync(nm, { recursive: true });
  symlinkSync(HOOK_KIT_ROOT, join(nm, "hook-kit"), "dir");
  symlinkSync(
    resolve(HOOK_KIT_ROOT, "node_modules", "@questi0nm4rk", "shell-ast"),
    join(nm, "shell-ast"),
    "dir",
  );
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

describe("generic adapter — end to end", () => {
  test(
    "deny decision is emitted as Decision JSON to stdout",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "generic" });
        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(
          JSON.stringify({
            sessionId: "s1",
            toolName: "Bash",
            toolInput: { command: "rm -rf /tmp/x" },
          }),
        );
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.kind).toBe("deny");
        expect(parsed.reason).toContain("[fixture]");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "null decision (no rule matched) emits {kind:null}",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "generic" });
        const proc = Bun.spawn([out], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
        proc.stdin.write(
          JSON.stringify({
            sessionId: "s1",
            toolName: "Bash",
            toolInput: { command: "ls -la" },
          }),
        );
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout.trim());
        expect(parsed.kind).toBe(null);
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "empty stdin → silent exit 0 (fail-open)",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "generic" });
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
});
