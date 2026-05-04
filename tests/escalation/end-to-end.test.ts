import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBuild } from "../../src/build/bundle.js";

const BUILD_TIMEOUT_MS = 60_000;

const HOOK_KIT_ROOT = resolve(__dirname, "..", "..");

const FIXTURE_HOOKS_TS = `
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "fixture", name: "fixture-escalate", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("rm").escalate("review this rm before running")],
  ),
];
`;

function stagePlugin(): { dir: string; entry: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hook-kit-esc-e2e-"));
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

function stageAskpass(
  workDir: string,
  decision: "allow" | "deny" | "harness-ask",
  reason?: string,
): string {
  const reasonField = reason !== undefined ? `,\\"reason\\":\\"${reason}\\"` : "";
  const body = [
    "#!/bin/sh",
    "REQ=$(cat)",
    'ID=$(printf %s "$REQ" | grep -oE \'"id":"[^"]*"\' | head -1 | sed \'s/"id":"//; s/"$//\')',
    `printf '{"id":"%s","decision":"${decision}"${reasonField},"decidedAt":"2026-01-01T00:00:00Z"}\\n' "$ID"`,
  ].join("\n");
  const path = join(workDir, "askpass.sh");
  writeFileSync(path, `${body}\n`, "utf8");
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
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "claude-code" });
        const askpass = stageAskpass(dir, "allow");
        const proc = Bun.spawn([out], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOOK_KIT_ASKPASS: askpass },
        });
        proc.stdin.write(ESCALATE_EVENT);
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
    "askpass returns deny → binary emits CC block JSON",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "claude-code" });
        const askpass = stageAskpass(dir, "deny", "policy violation");
        const proc = Bun.spawn([out], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOOK_KIT_ASKPASS: askpass },
        });
        proc.stdin.write(ESCALATE_EVENT);
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("policy violation");
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "askpass returns harness-ask → binary emits CC ask JSON",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "claude-code" });
        const askpass = stageAskpass(dir, "harness-ask");
        const proc = Bun.spawn([out], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOOK_KIT_ASKPASS: askpass },
        });
        proc.stdin.write(ESCALATE_EVENT);
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
          "review this rm before running",
        );
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "no askpass set → binary denies with infrastructure-unavailable reason",
    async () => {
      const { dir, entry, cleanup } = stagePlugin();
      const out = join(dir, "dist", "hooks");
      mkdirSync(join(dir, "dist"), { recursive: true });
      try {
        await runBuild({ entrypoint: entry, out, adapter: "claude-code" });
        // Strip HOOK_KIT_ASKPASS from the env so the binary can't escalate.
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "HOOK_KIT_ASKPASS"),
        );
        const proc = Bun.spawn([out], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
        });
        proc.stdin.write(ESCALATE_EVENT);
        proc.stdin.end();
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
          "infrastructure unavailable",
        );
      } finally {
        cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
