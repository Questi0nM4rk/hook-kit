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
// Unlike that file (one stage + compile per test), this suite hoists the
// expensive compile into beforeAll because all 6 cases assert against the
// same binary — the wire format is deterministic per-input, not stateful.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, type Sandbox } from "./_sandbox.js";
import { HOOK_KIT_ROOT, runBin, type StagedDir, stageDir } from "./_staged.js";

const BUILD_TIMEOUT_MS = 90_000;
const SHA256_HEX_LEN = 64; // 256-bit digest rendered as hex pairs.
const TEMPLATE_ROOT = join(HOOK_KIT_ROOT, "examples", "adapter-template");

interface Staged {
  readonly dir: string;
  readonly binPath: string;
  cleanup(): void;
}

function stageTemplate(): Staged {
  // stageDir copies the template's src/ + builds the symlink farm; the template
  // also ships its own build.ts + package.json (it compiles via `bun run
  // build.ts`, NOT the hook-kit CLI), so copy those two extra files in.
  const staged: StagedDir = stageDir({
    copyExampleSrc: TEMPLATE_ROOT,
    prefix: "hook-kit-adapter-template-",
  });
  cpSync(join(TEMPLATE_ROOT, "build.ts"), join(staged.dir, "build.ts"));
  cpSync(join(TEMPLATE_ROOT, "package.json"), join(staged.dir, "package.json"));
  return {
    dir: staged.dir,
    binPath: join(staged.dir, "dist", "hk-template"),
    // Direct reference — StagedDir.cleanup is an arrow-function closure over its
    // dir (no `this` binding) so no wrapper is needed.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- StagedDir.cleanup is an arrow-function property in _staged.ts (closes over `dir`, never reads `this`); detaching it is safe. The rule cannot distinguish arrow-property from prototype method.
    cleanup: staged.cleanup,
  };
}

async function compile(staged: Staged): Promise<void> {
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
  let staged: Staged;
  // Throwaway non-git cwd for every binary spawn — see tests/build/_sandbox.ts.
  let sandbox: Sandbox;

  beforeAll(async () => {
    staged = stageTemplate();
    await compile(staged);
    sandbox = makeSandbox();
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    staged.cleanup();
    sandbox.cleanup();
  });

  test("DENY: rm -rf /tmp/x -> exit 2, stderr '[template-demo] denied:', stdout empty", async () => {
    const r = await runBin(staged.binPath, eventJson("rm -rf /tmp/x"), { cwd: sandbox.dir });
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("[template-demo] denied: destructive rm -rf");
    expect(r.stdout).toBe("");
  });

  test("ASK: git push --force -> exit 1, stdout '[template-demo] needs review:'", async () => {
    const r = await runBin(staged.binPath, eventJson("git push --force origin main"), {
      cwd: sandbox.dir,
    });
    expect(r.exit).toBe(1);
    expect(r.stdout).toContain("[template-demo] needs review: force-push needs review");
    expect(r.stderr).toBe("");
  });

  test("CLEAN: benign command -> exit 0, no output", async () => {
    const r = await runBin(staged.binPath, eventJson("ls /tmp"), { cwd: sandbox.dir });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  test("ANNOTATION-ONLY: rm /tmp/x (no -rf) -> exit 0, stdout '[template-demo] warning:'", async () => {
    const r = await runBin(staged.binPath, eventJson("rm /tmp/x"), { cwd: sandbox.dir });
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("[template-demo] warning: rm without -rf still deletes files");
    expect(r.stderr).toBe("");
  });

  test("BAD INPUT: malformed JSON on stdin -> non-zero exit, '[template-demo] fatal:' on stderr", async () => {
    const r = await runBin(staged.binPath, "not json {{", { cwd: sandbox.dir });
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("[template-demo] fatal:");
    expect(r.stderr).toContain("not JSON");
  });

  test("OBSERVER: TEMPLATE_OBSERVER_LOG receives one JSONL DecisionEventRecord on deny", async () => {
    // Per-test log path so concurrent / re-run tests don't see each other's
    // records. afterEach-style cleanup folded into a try/finally here so the
    // assertion lifetime owns the file.
    const logPath = join(staged.dir, "observer-deny.jsonl");
    try {
      const r = await runBin(staged.binPath, eventJson("rm -rf /tmp/x"), {
        cwd: sandbox.dir,
        env: { TEMPLATE_OBSERVER_LOG: logPath },
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
      try {
        unlinkSync(logPath);
      } catch {
        // file may not exist if the binary never reached observer wiring; safe to ignore.
      }
    }
  });
});
