import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichGit, gitEnrichmentEnabled } from "../../src/escalation/enrich-git.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hk-enrich-git-"));
}

function git(cwd: string, args: readonly string[]): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

describe("enrichGit", () => {
  test("returns undefined when cwd is not a git repo", async () => {
    const dir = tmp();
    try {
      const result = await enrichGit(dir);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns sha + branch + clean dirty state for a fresh repo", async () => {
    const dir = tmp();
    try {
      git(dir, ["init", "--initial-branch=main"]);
      git(dir, ["config", "user.email", "t@t"]);
      git(dir, ["config", "user.name", "t"]);
      writeFileSync(join(dir, "f"), "hi", "utf8");
      git(dir, ["add", "f"]);
      git(dir, ["commit", "-m", "c"]);

      const result = await enrichGit(dir);
      expect(result).toBeDefined();
      expect(result?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result?.branch).toBe("main");
      expect(result?.dirty).toBe(false);
      // No origin in this fixture.
      expect(result?.remote).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects dirty state and remote url when present", async () => {
    const dir = tmp();
    try {
      git(dir, ["init", "--initial-branch=main"]);
      git(dir, ["config", "user.email", "t@t"]);
      git(dir, ["config", "user.name", "t"]);
      git(dir, ["remote", "add", "origin", "git@example.com:o/r.git"]);
      writeFileSync(join(dir, "f"), "hi", "utf8");
      git(dir, ["add", "f"]);
      git(dir, ["commit", "-m", "c"]);
      writeFileSync(join(dir, "f"), "changed", "utf8");

      const result = await enrichGit(dir);
      expect(result?.dirty).toBe(true);
      expect(result?.remote).toBe("git@example.com:o/r.git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitEnrichmentEnabled", () => {
  test("true for HOOK_KIT_ENRICH_GIT=1", () => {
    const prev = process.env.HOOK_KIT_ENRICH_GIT;
    process.env.HOOK_KIT_ENRICH_GIT = "1";
    try {
      expect(gitEnrichmentEnabled()).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env.HOOK_KIT_ENRICH_GIT;
      } else {
        process.env.HOOK_KIT_ENRICH_GIT = prev;
      }
    }
  });

  test("false when unset", () => {
    const prev = process.env.HOOK_KIT_ENRICH_GIT;
    delete process.env.HOOK_KIT_ENRICH_GIT;
    try {
      expect(gitEnrichmentEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) {
        process.env.HOOK_KIT_ENRICH_GIT = prev;
      }
    }
  });
});
