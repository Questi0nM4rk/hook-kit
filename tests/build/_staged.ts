// Shared staging + spawn helpers for the compiled-binary build tests.
//
// Replaces ~7 near-identical copies of: mkdtemp → (copy example src | write a
// fixture hooks.ts) → symlink hook-kit/shell-ast/zod into node_modules → runBuild
// → spawn-and-capture. Kept under an underscore so bun's `*.test.ts` discovery
// skips it.
//
// Every binary spawn runs with `cwd` inside a throwaway non-git sandbox: `hk` is a
// `bash -c` substitute that EXECUTES any command it does not block, so an allowed
// command (e.g. `git checkout main`) spawned from the repo root would mutate the
// real working tree (the #29 corruption). See tests/build/_sandbox.ts.

import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBuild } from "../../src/build/bundle.js";
import { makeSandbox } from "./_sandbox.js";

/** Repo root, resolved from this file's location (tests/build/). */
export const HOOK_KIT_ROOT = resolve(import.meta.dirname, "..", "..");

export interface HkResult {
  exit: number;
  stdout: string;
  stderr: string;
}

/** Drain a piped subprocess — stdout + stderr (concurrently) + exit code — into
 *  an HkResult. Structural param so both the `runHk` and `runBin` spawns (which
 *  differ only in their stdin handling) reuse it. */
async function capture(proc: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}): Promise<HkResult> {
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}

/**
 * Symlink `@questi0nm4rk/hook-kit` (+ `shell-ast`, `zod`) into
 * `<dir>/node_modules` so a staged entrypoint resolves the package at build time
 * exactly as a downstream consumer would.
 */
export function symlinkDeps(dir: string): void {
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
}

export interface StageOpts {
  /** Copy `<copyExampleSrc>/src` into the staged dir (e.g. examples/ai-guardrails). */
  readonly copyExampleSrc?: string;
  /** OR write this string as the staged `src/hooks.ts`. */
  readonly hooksFixture?: string;
  /** mkdtemp prefix (cosmetic; aids debugging leaked temp dirs). */
  readonly prefix?: string;
}

export interface StagedDir {
  readonly dir: string;
  readonly entry: string;
  cleanup(): void;
}

/** mkdtemp + (copy an example's `src/` | write a fixture `src/hooks.ts`) + symlinkDeps. */
export function stageDir(opts: StageOpts): StagedDir {
  const dir = mkdtempSync(join(tmpdir(), opts.prefix ?? "hook-kit-staged-"));
  if (opts.copyExampleSrc !== undefined) {
    cpSync(join(opts.copyExampleSrc, "src"), join(dir, "src"), { recursive: true });
  } else if (opts.hooksFixture !== undefined) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "hooks.ts"), opts.hooksFixture, "utf8");
  }
  symlinkDeps(dir);
  return {
    dir,
    entry: join(dir, "src", "hooks.ts"),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn `bin -c <command>`, capturing stdout/stderr/exit. `cwd` MUST be a
 * throwaway non-git sandbox (the binary executes what it does not block).
 */
export async function runHk(bin: string, command: string, cwd: string): Promise<HkResult> {
  const proc = Bun.spawn([bin, "-c", command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return capture(proc);
}

/**
 * Spawn `bin` feeding `stdinJson` on stdin (the cc-tools / custom-adapter bins,
 * which read a tool event and emit a decision — they never exec the command).
 * Still sandbox-cwd'd for uniformity.
 */
export async function runBin(
  bin: string,
  stdinJson: string,
  opts: { readonly cwd: string; readonly env?: Record<string, string> },
): Promise<HkResult> {
  const proc = Bun.spawn([bin], {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  // FileSink.write returns number|Promise<number> (sync for small buffers);
  // await covers both and satisfies no-floating-promises without `void` (noVoid).
  await proc.stdin.write(stdinJson);
  await proc.stdin.end();
  return capture(proc);
}

export interface StagedBinary {
  readonly dir: string;
  readonly binPath: string;
  /** Throwaway non-git dir that `run`/`runStdin` spawn the binary in. */
  readonly sandboxDir: string;
  /** `binPath -c <command>` (shell-wrapper mode). */
  run(command: string): Promise<HkResult>;
  /** `binPath` with a tool-event JSON on stdin (cc-tools/custom adapter mode). */
  runStdin(stdinJson: string, env?: Record<string, string>): Promise<HkResult>;
  cleanup(): void;
}

/**
 * Stage a source tree, compile it with `runBuild`, and return a binary whose
 * `run`/`runStdin` are bound to an internal sandbox cwd. The one-stop helper for
 * build tests that compile via the hook-kit CLI (`runBuild`); for the
 * adapter-template (compiled via its own `bun run build.ts`) use `stageDir` +
 * `runBin` directly.
 */
export async function stageBinary(
  opts: StageOpts & { readonly adapter: "shell" | "cc-tools"; readonly binName?: string },
): Promise<StagedBinary> {
  const staged = stageDir(opts);
  const binPath = join(
    staged.dir,
    "dist",
    opts.binName ?? (opts.adapter === "cc-tools" ? "hk-cc-tools" : "hk"),
  );
  mkdirSync(join(staged.dir, "dist"), { recursive: true });
  await runBuild({ entrypoint: staged.entry, out: binPath, adapter: opts.adapter });
  const sandbox = makeSandbox();
  return {
    dir: staged.dir,
    binPath,
    sandboxDir: sandbox.dir,
    run: (command) => runHk(binPath, command, sandbox.dir),
    runStdin: (stdinJson, env) =>
      runBin(binPath, stdinJson, { cwd: sandbox.dir, ...(env ? { env } : {}) }),
    cleanup: () => {
      staged.cleanup();
      sandbox.cleanup();
    },
  };
}
