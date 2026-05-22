/* eslint-disable @typescript-eslint/no-floating-promises -- file drives the spawned binary through proc.stdin.write / .end whose Bun FileSink return type is `number | Promise<number>` (sync for small buffers, async for large); the meaningful success signal is the awaited proc.exited race below each write. Awaiting the FileSink calls individually adds no signal and would serialize the writes-then-await pattern that the kernel pipe already handles. */
// Compiled-binary e2e test for examples/adapter-template/.
//
// Stages the template into a tmpdir with symlinks to hook-kit + shell-ast +
// zod, runs the template's own build script (which calls `bun build
// --compile --bytecode` on `src/main.ts` — not the hook-kit CLI, since the
// template ships a CUSTOM adapter), then spawns the binary and validates
// the wire-format contract from docs/ADAPTERS.md § Output convention
// end-to-end. Covers M1.3's adapter template + M1.2's contract + M1.1's
// DecisionObserver wiring in one shot.
//
// Mirrors the staging shape of tests/build/example-ai-guardrails.test.ts.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUILD_TIMEOUT_MS = 90_000;
const SHA256_HEX_LEN = 64; // 256-bit digest rendered as hex pairs.
const HOOK_KIT_ROOT = resolve(import.meta.dirname, "..", "..");
const TEMPLATE_ROOT = resolve(HOOK_KIT_ROOT, "examples", "adapter-template");

interface Staged {
  readonly dir: string;
  readonly binPath: string;
  cleanup(): void;
}

function stageTemplate(): Staged {
  const dir = mkdtempSync(join(tmpdir(), "hook-kit-adapter-template-"));
  cpSync(join(TEMPLATE_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(TEMPLATE_ROOT, "build.ts"), join(dir, "build.ts"));
  cpSync(join(TEMPLATE_ROOT, "package.json"), join(dir, "package.json"));

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
  return {
    dir,
    binPath: join(dir, "dist", "hk-template"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function compile(staged: Staged): Promise<void> {
  mkdirSync(join(staged.dir, "dist"), { recursive: true });
  const proc = Bun.spawn(["bun", "run", "build.ts"], {
    cwd: staged.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(
      `template build.ts failed: exit=${String(exit)}\nstdout=${stdout}\nstderr=${stderr}`,
    );
  }
}

interface SpawnResult {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBin(
  binPath: string,
  stdinJson: string,
  env: Record<string, string> = {},
): Promise<SpawnResult> {
  const proc = Bun.spawn([binPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  // Write the stdin synchronously then close.
  proc.stdin.write(stdinJson);
  await proc.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}

const baseEvent = {
  event: "PreToolUse",
  session: "s1",
  cwd: "/tmp",
  transcript: "/tmp/t.jsonl",
  tool: "Bash",
};

function eventJson(command: string): string {
  return JSON.stringify({ ...baseEvent, input: { command } });
}

describe("examples/adapter-template — compiled-binary wire format", () => {
  test(
    "DENY: rm -rf /tmp/x -> exit 2, stderr '[template-demo] denied:', stdout empty",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const r = await runBin(staged.binPath, eventJson("rm -rf /tmp/x"));
        expect(r.exit).toBe(2);
        expect(r.stderr).toContain("[template-demo] denied: destructive rm -rf");
        expect(r.stdout).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "ASK: git push --force -> exit 1, stdout '[template-demo] needs review:'",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const r = await runBin(staged.binPath, eventJson("git push --force origin main"));
        expect(r.exit).toBe(1);
        expect(r.stdout).toContain("[template-demo] needs review: force-push needs review");
        expect(r.stderr).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "CLEAN: benign command -> exit 0, no output",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const r = await runBin(staged.binPath, eventJson("ls /tmp"));
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "ANNOTATION-ONLY: rm /tmp/x (no -rf) -> exit 0, stdout '[template-demo] warning:'",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const r = await runBin(staged.binPath, eventJson("rm /tmp/x"));
        expect(r.exit).toBe(0);
        expect(r.stdout).toContain("[template-demo] warning: rm without -rf still deletes files");
        expect(r.stderr).toBe("");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "BAD INPUT: malformed JSON on stdin -> non-zero exit, '[template-demo] fatal:' on stderr",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const r = await runBin(staged.binPath, "not json {{");
        expect(r.exit).not.toBe(0);
        expect(r.stderr).toContain("[template-demo] fatal:");
        expect(r.stderr).toContain("not JSON");
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "OBSERVER: TEMPLATE_OBSERVER_LOG receives one JSONL DecisionEventRecord on deny",
    async () => {
      const staged = stageTemplate();
      try {
        await compile(staged);
        const logPath = join(staged.dir, "observer.jsonl");
        const r = await runBin(staged.binPath, eventJson("rm -rf /tmp/x"), {
          TEMPLATE_OBSERVER_LOG: logPath,
        });
        expect(r.exit).toBe(2);

        const log = readFileSync(logPath, "utf8").trim();
        // Exactly one record for the deny terminal.
        const lines = log.split("\n").filter((l) => l !== "");
        expect(lines.length).toBe(1);
        const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
        expect(record.decision).toBe("deny");
        expect(record.ruleId).toBe("demo-destructive-rm:command:0");
        expect(record.ruleKind).toBe("command");
        expect(record.reason).toBe("destructive rm -rf");
        expect(record.label).toBe("[template-demo]");
        const event = record.event as Record<string, unknown>;
        expect(event.eventName).toBe("PreToolUse");
        expect(event.toolName).toBe("Bash");
        // toolInputHash is sha256 hex = 64 chars.
        expect(typeof event.toolInputHash).toBe("string");
        expect((event.toolInputHash as string).length).toBe(SHA256_HEX_LEN);
      } finally {
        staged.cleanup();
      }
    },
    BUILD_TIMEOUT_MS,
  );
});
