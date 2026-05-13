import { describe, expect, test } from "bun:test";
import { generateEntrypoint, generateHooksJson } from "../../src/build/bundle.js";

// CC reads `${CLAUDE_PLUGIN_ROOT}` literally from hooks.json. We construct it
// as concat to avoid biome's template-placeholder-in-string lint warning.
const PLUGIN_ROOT_PATH = `${"$"}{CLAUDE_PLUGIN_ROOT}/dist/hooks`;

describe("generateEntrypoint", () => {
  test("imports the claude-code adapter and dynamically loads the user's modules", () => {
    const src = generateEntrypoint({
      entrypoint: "/abs/path/to/user/hooks.ts",
      out: "/dist/hooks",
      adapter: "cc-tools",
    });
    expect(src).toContain('from "@questi0nm4rk/hook-kit/adapters/claude-code"');
    expect(src).toContain("claudeCodeAdapter");
    // BUG-003: user module loaded via dynamic import so its TLA can be awaited.
    expect(src).toContain('import("/abs/path/to/user/hooks.ts")');
    expect(src).toContain("run(modules, claudeCodeAdapter)");
  });

  test("escapes the entrypoint path safely (uses JSON.stringify semantics)", () => {
    const src = generateEntrypoint({
      entrypoint: '/path/with spaces/and"quote.ts',
      out: "/dist/hooks",
      adapter: "cc-tools",
    });
    expect(src).toContain('import("/path/with spaces/and\\"quote.ts")');
  });

  test("shell adapter calls runShell after the dynamic import resolves", () => {
    const src = generateEntrypoint({
      entrypoint: "/abs/hooks.ts",
      out: "/dist/hk",
      adapter: "shell",
    });
    expect(src).toContain('from "@questi0nm4rk/hook-kit/wrapper/hk"');
    expect(src).toContain('import("/abs/hooks.ts")');
    expect(src).toContain("runShell(modules);");
  });

  test("emits an error handler that fails closed on entrypoint load failure", () => {
    const src = generateEntrypoint({
      entrypoint: "/abs/hooks.ts",
      out: "/dist/hk",
      adapter: "shell",
    });
    expect(src).toContain("[hook-kit] failed to load entrypoint");
    expect(src).toContain("process.exit(1)");
  });
});

describe("generateHooksJson", () => {
  test("emits a single PreToolUse entry for a simple Bash module", () => {
    const json = generateHooksJson(
      [
        {
          id: "m",
          name: "force-push",
          events: ["PreToolUse"],
          matchers: ["Bash"],
          rules: [],
        },
      ],
      { binaryPath: PLUGIN_ROOT_PATH, timeout: 10 },
    );
    expect(json).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: PLUGIN_ROOT_PATH,
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
  });

  test("groups multiple events from the same module", () => {
    const json = generateHooksJson(
      [
        {
          id: "m",
          name: "everything",
          events: ["PreToolUse", "PostToolUse", "Stop"],
          matchers: ["Bash"],
          rules: [],
        },
      ],
      { binaryPath: "/bin/x", timeout: 5 },
    );
    expect(Object.keys(json.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
    expect(json.hooks.PreToolUse).toHaveLength(1);
    expect(json.hooks.PostToolUse).toHaveLength(1);
    expect(json.hooks.Stop).toHaveLength(1);
  });

  test("merges matchers from different modules sharing an event", () => {
    const json = generateHooksJson(
      [
        {
          id: "a",
          name: "bash-only",
          events: ["PreToolUse"],
          matchers: ["Bash"],
          rules: [],
        },
        {
          id: "b",
          name: "write-only",
          events: ["PreToolUse"],
          matchers: ["Write", "Edit"],
          rules: [],
        },
      ],
      { binaryPath: "/bin/x", timeout: 5 },
    );
    expect(json.hooks.PreToolUse).toHaveLength(2);
    const matchers = json.hooks.PreToolUse?.map((h) => h.matcher).sort();
    expect(matchers).toEqual(["Bash", "Write|Edit"]);
  });

  test("modules without matchers emit an empty matcher (binary handles routing)", () => {
    const json = generateHooksJson([{ id: "m", name: "all", events: ["PreToolUse"], rules: [] }], {
      binaryPath: "/bin/x",
      timeout: 5,
    });
    expect(json.hooks.PreToolUse?.[0]?.matcher).toBe("");
  });

  test("disabled modules are skipped", () => {
    const json = generateHooksJson(
      [
        {
          id: "m",
          name: "skip",
          events: ["PreToolUse"],
          matchers: ["Bash"],
          rules: [],
          enabled: false,
        },
      ],
      { binaryPath: "/bin/x", timeout: 5 },
    );
    expect(json.hooks).toEqual({});
  });
});
