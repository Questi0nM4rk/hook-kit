// Unit test for scripts/check-output-table.ts.
//
// Stages a tmpdir with a CLAUDE.md + docs/ADAPTERS.md pair, varies row
// contents per case, asserts on exit code + stderr-diff summary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK_KIT_ROOT = resolve(import.meta.dirname, "..", "..");
const SCRIPT_PATH = resolve(HOOK_KIT_ROOT, "scripts", "check-output-table.ts");

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

const CANONICAL_TABLE = [
  "| Outcome | Exit | Stream | Content |",
  "|---|---|---|---|",
  "| no terminal, no annotations | 0 | — | silent, then exec the command verbatim |",
  "| `ask` (annotations bundled) | 1 | stdout | `<prefix> needs review: <reason>` |",
  "| `deny` (annotations DROPPED) | 2 | stderr | `<prefix> denied: <reason>` |",
];

function stageFixture(opts: {
  claudeTable: readonly string[];
  adaptersTable: readonly string[];
  claudeHeading?: string;
  adaptersHeading?: string;
}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "check-output-table-test-"));
  mkdirSync(join(dir, "docs"), { recursive: true });

  const claudeHeading = opts.claudeHeading ?? "## Output Convention";
  const adaptersHeading = opts.adaptersHeading ?? "## Output convention";

  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# CLAUDE\n\nIntro prose.\n\n${claudeHeading}\n\n${opts.claudeTable.join("\n")}\n\n## Next section\n\nMore stuff.\n`,
  );
  writeFileSync(
    join(dir, "docs", "ADAPTERS.md"),
    `# ADAPTERS\n\nIntro.\n\n${adaptersHeading}\n\n${opts.adaptersTable.join("\n")}\n\n## After.\n`,
  );
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("scripts/check-output-table.ts", () => {
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

  test("exit 0 when tables match byte-for-byte (heading case difference tolerated)", async () => {
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: CANONICAL_TABLE,
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("matches");
    expect(r.stderr).toContain("5 rows");
  });

  test("exit 1 on single-row content drift", async () => {
    const drifted = [...CANONICAL_TABLE];
    drifted[3] = "| `ask` | 99 | stdout | drifted text |";
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: drifted,
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("row 3");
    expect(r.stderr).toContain("drifted text");
  });

  test("exit 1 on row-count mismatch (one table has extra row)", async () => {
    const extra = [...CANONICAL_TABLE, "| extra | row | here | added |"];
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: extra,
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("row count mismatch");
    expect(r.stderr).toContain("5 rows");
    expect(r.stderr).toContain("6");
  });

  test("exit 2 when heading missing in CLAUDE.md", async () => {
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: CANONICAL_TABLE,
      claudeHeading: "## Unrelated heading",
    });
    const r = await runScript(staged.dir);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("could not find heading");
    expect(r.stderr).toContain("CLAUDE.md");
  });

  test("--quiet suppresses success output", async () => {
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: CANONICAL_TABLE,
    });
    const r = await runScript(staged.dir, ["--quiet"]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("unknown flag exits 2", async () => {
    staged = stageFixture({
      claudeTable: CANONICAL_TABLE,
      adaptersTable: CANONICAL_TABLE,
    });
    const r = await runScript(staged.dir, ["--bogus"]);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("unrecognized arg");
  });
});
