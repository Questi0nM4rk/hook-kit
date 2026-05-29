// Unit test for scripts/check-doc-counts.ts.
//
// Strategy: spawn the script with a tweaked CWD that contains a synthetic
// minimal repo layout (src/core/errors.ts + a doc with a count claim +
// package.json with subpath exports). Each test stages a tmpdir with the
// shape under test, runs the script there, asserts on exit code +
// stderr-message keywords. This keeps the script itself a pure CLI
// without requiring an in-process library API.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK_KIT_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(HOOK_KIT_ROOT, "scripts", "check-doc-counts.ts");

interface Spawned {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runScript(cwd: string, extraArgs: readonly string[] = []): Promise<Spawned> {
  const proc = Bun.spawn(["bun", SCRIPT_PATH, ...extraArgs], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, stdout, stderr };
}

interface FixtureOptions {
  /** Source-of-truth: count of `XxxError extends HookKitError` declarations. */
  readonly sourceClassCount: number;
  /** Claim phrasings to seed into a synthetic CLAUDE.md, one per line. */
  readonly claudeClaims: readonly string[];
  /** package.json `exports` field. */
  readonly packageExports: Record<string, unknown>;
  /** Filesystem paths (relative) to create as empty files. */
  readonly existingFiles?: readonly string[];
  /** package.json `version` field. Omit to stage a versionless package.json
   *  (the version-marker audit then has nothing to compare against). */
  readonly packageVersion?: string;
  /** Contents of a synthetic README.md. Omit to stage no README at all
   *  (the version-marker + test-count audits skip an absent README). */
  readonly readme?: string;
  /** Map of relative test-dir → number of trivial passing tests to stage in
   *  it. Used to give the test-count audit a deterministic `Ran N` per suite.
   *  When set, the audit's three target dirs (`tests/`, `tests-isolated/`,
   *  `examples/adapter-template/tests/`) get a `<dir>/gen.test.ts` with that
   *  many `test()` cases. Dirs omitted from the map are left absent (the audit
   *  treats an absent suite as a hard read-failure → exit 2, so callers that
   *  want a clean count stage all three). */
  readonly testSuites?: Readonly<Record<string, number>>;
}

/** Stage a tmpdir with the minimum layout the script needs. */
function stageFixture(opts: FixtureOptions): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "check-doc-counts-test-"));
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  // src/core/errors.ts — base class + N synthetic subclasses.
  const subclasses = Array.from(
    { length: opts.sourceClassCount },
    (_, i) => `export class Test${String(i)}Error extends HookKitError {}`,
  ).join("\n");
  writeFileSync(
    join(dir, "src", "core", "errors.ts"),
    `export abstract class HookKitError extends Error {}\n${subclasses}\n`,
  );

  writeFileSync(join(dir, "CLAUDE.md"), `${opts.claudeClaims.join("\n")}\n`);
  // SPEC.md / ADAPTERS.md present but empty: script tolerates no-claim docs.
  writeFileSync(join(dir, "docs", "SPEC.md"), "# SPEC\n");
  writeFileSync(join(dir, "docs", "ADAPTERS.md"), "# ADAPTERS\n");

  const pkg: Record<string, unknown> = { exports: opts.packageExports };
  if (opts.packageVersion !== undefined) {
    pkg.version = opts.packageVersion;
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));

  if (opts.readme !== undefined) {
    writeFileSync(join(dir, "README.md"), opts.readme);
  }

  if (opts.testSuites !== undefined) {
    for (const [suiteDir, count] of Object.entries(opts.testSuites)) {
      mkdirSync(join(dir, suiteDir), { recursive: true });
      const cases = Array.from(
        { length: count },
        (_, i) => `test("gen ${String(i)}", () => { expect(1).toBe(1); });`,
      ).join("\n");
      writeFileSync(
        join(dir, suiteDir, "gen.test.ts"),
        `import { test, expect } from "bun:test";\n${cases}\n`,
      );
    }
  }

  for (const path of opts.existingFiles ?? []) {
    const abs = join(dir, path);
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    if (parent !== "" && parent !== dir) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(abs, "");
  }

  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("scripts/check-doc-counts.ts", () => {
  let staged: { dir: string; cleanup: () => void } | null = null;

  beforeEach(() => {
    staged = null;
  });

  afterEach(() => {
    if (staged !== null) {
      staged.cleanup();
      staged = null;
    }
  });

  test("exit 0 when HookKitError count matches across docs + all exports exist", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: [
        "Typed errors (10 `HookKitError` subclasses, `error` kind)",
        "0-silent-fails: typed `HookKitError` (10 subclasses in `src/core/errors.ts`)",
      ],
      packageExports: {
        ".": { import: "./src/index.ts" },
      },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("all audits passed");
  });

  test("exit 1 on subclass-count drift (claim 5 vs source 10)", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (5 `HookKitError` subclasses, `error` kind)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("claims 5 HookKitError subclasses");
    expect(r.stderr).toContain("src/core/errors.ts has 10");
  });

  test("exit 1 on missing subpath export target file", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: {
        ".": { import: "./src/index.ts" },
        "./state": { import: "./src/state/types.ts" },
      },
      existingFiles: ["src/index.ts"],
      // src/state/types.ts intentionally NOT created — the L-M1.5-1 scenario.
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("./src/state/types.ts");
    expect(r.stderr).toContain("does not exist");
  });

  test("`types` condition (build artifact) is ignored — only `import` is audited", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: {
        ".": {
          import: "./src/index.ts",
          // Build artifact path — would not exist on a fresh checkout.
          types: "./dist/types/index.d.ts",
        },
      },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).not.toContain("dist/types");
  });

  test("--quiet suppresses success output but still emits failures", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir, ["--quiet"]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("doc without any count claim does NOT trigger drift", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["No count mentioned anywhere here."],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
  });

  test("--help exits 0", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: [],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir, ["--help"]);
    expect(r.exit).toBe(0);
  });

  test("unknown flag exits 2", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: [],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir, ["--bogus"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("unrecognized arg");
  });

  // --- Audit 3: test-count ---
  //
  // The synthetic suites' exact `Ran N` totals depend on bun's path-arg
  // matching across the three staged dirs, which is environment-sensitive, so
  // these tests don't hardcode the total. Instead they derive what the script
  // itself computed (the `total N` it prints on a deliberate mismatch) and
  // then assert the matching/ non-matching behaviour against that value.

  test("exit 0 when README test count matches the summed three-suite total", async () => {
    const fx = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
      testSuites: {
        tests: 5,
        "tests-isolated": 1,
        "examples/adapter-template/tests": 1,
      },
      // Deliberately-wrong claim (0 can never equal the staged total) so the
      // first run reports the computed total in its drift message.
      readme: "# Demo\n\n0 tests across the suite.\n",
    });
    staged = fx;
    const probe = await runScript(fx.dir);
    expect(probe.exit).toBe(1);
    const total = /total (\d+)/.exec(probe.stderr)?.[1];
    expect(total).toBeDefined();
    // Rewrite the README to claim the computed total; now the audit passes.
    writeFileSync(
      join(fx.dir, "README.md"),
      `# Demo\n\n${String(total)} tests across the suite.\n`,
    );
    const r = await runScript(fx.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("all audits passed");
  });

  test("exit 1 on test-count drift (README claims wrong total)", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
      testSuites: {
        tests: 5,
        "tests-isolated": 1,
        "examples/adapter-template/tests": 1,
      },
      // 4242 cannot equal the small staged-suite total → guaranteed drift.
      readme: "# Demo\n\n4242 tests across the suite.\n",
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("claims 4242 tests");
    expect(r.stderr).toContain("test-count");
  });

  test("test-count audit is skipped (exit 0) when no doc carries a count claim", async () => {
    // No README, CLAUDE.md has only a subclass claim (not a test claim), and no
    // test suites are staged. The audit must NOT run `bun test` (nothing to
    // verify) and must NOT error on the absent suites.
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("all audits passed");
  });

  // --- Audit 4: README version marker ---

  test("exit 1 when README has a Current: marker disagreeing with package.json", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
      packageVersion: "0.8.0",
      readme: "# Demo\n\n## Status\n\nCurrent: **`0.7.0`**.\n",
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("readme-version-marker");
    expect(r.stderr).toContain("0.7.0");
    expect(r.stderr).toContain("0.8.0");
  });

  test("exit 0 when README has no version marker (preferred state)", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
      packageVersion: "0.8.0",
      readme: "# Demo\n\nPre-release; see the npm badge for the version.\n",
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("all audits passed");
  });

  test("exit 0 when a Status: marker matches package.json", async () => {
    staged = stageFixture({
      sourceClassCount: 10,
      claudeClaims: ["Typed errors (10 `HookKitError` subclasses)"],
      packageExports: { ".": { import: "./src/index.ts" } },
      existingFiles: ["src/index.ts"],
      packageVersion: "0.8.0",
      readme: "# Demo\n\nStatus: v0.8.0\n",
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
  });
});
