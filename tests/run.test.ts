import { describe, expect, test } from "bun:test";
import { rawAdapter } from "../src/adapters/raw.js";
import { createModule } from "../src/core/module.js";
import type { HookEvent, ProtocolAdapter } from "../src/index.js";
import { cmd, path, run } from "../src/index.js";

function bashEvent(command: string): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command },
    raw: {},
  };
}

describe("run() — adapter round-trip", () => {
  test("reads, evaluates, writes through the raw adapter", async () => {
    const { adapter, state } = rawAdapter(bashEvent("git push --force"));
    const modules = [
      createModule({ id: "m", name: "force-push", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("git", "push").withFlag("--force").deny("no force pushes"),
      ]),
    ];
    await run(modules, adapter);
    expect(state.outcome.terminal).toEqual({ kind: "deny", reason: "no force pushes" });
  });

  test("returns null decision when no rule matches", async () => {
    const { adapter, state } = rawAdapter(bashEvent("git pull"));
    const modules = [
      createModule({ id: "m", name: "force-push", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("git", "push").withFlag("--force").deny("no force"),
      ]),
    ];
    await run(modules, adapter);
    expect(state.outcome.terminal).toBeNull();
  });

  test("delegates readInput failure to handleError (fail-open)", async () => {
    let captured: unknown;
    const adapter: ProtocolAdapter = {
      readInput: async () => {
        throw new Error("stdin broken");
      },
      writeOutput: () => {
        throw new Error("should not be called");
      },
      handleError: (e: unknown) => {
        captured = e;
      },
    };
    await run([], adapter);
    expect((captured as Error).message).toBe("stdin broken");
  });

  test("captures path() rule decisions through the same flow", async () => {
    const event: HookEvent = {
      eventName: "PreToolUse",
      sessionId: "s1",
      cwd: "/tmp",
      transcriptPath: "/tmp/t.jsonl",
      toolName: "Write",
      toolInput: { file_path: "/tmp/x.g.cs" },
      raw: {},
    };
    const { adapter, state } = rawAdapter(event);
    const modules = [
      createModule(
        { id: "m", name: "no-generated", events: ["PreToolUse"], matchers: ["Write", "Edit"] },
        [
          path(/\.g\.cs$/)
            .onWrite()
            .deny("edit the generator"),
        ],
      ),
    ];
    await run(modules, adapter);
    expect(state.outcome.terminal).toEqual({ kind: "deny", reason: "edit the generator" });
  });
});

describe("run() — HOOK_KIT_VERBOSE tracing", () => {
  function captureStderr(): { restore: () => void; output: () => string } {
    const buf: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      buf.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    return { restore: () => (process.stderr.write = original), output: () => buf.join("") };
  }

  function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    return fn().finally(() => {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    });
  }

  test("emits a single trace line when HOOK_KIT_VERBOSE=1", async () => {
    const cap = captureStderr();
    try {
      await withEnv("HOOK_KIT_VERBOSE", "1", async () => {
        const { adapter } = rawAdapter(bashEvent("git push --force"));
        const modules = [
          createModule(
            { id: "m", name: "force-push", events: ["PreToolUse"], matchers: ["Bash"] },
            [cmd("git", "push").withFlag("--force").deny("no force pushes")],
          ),
        ];
        await run(modules, adapter);
      });
    } finally {
      cap.restore();
    }
    const out = cap.output();
    expect(out).toContain("[hook-kit]");
    // biome-ignore lint/security/noSecrets: literal event-name string for trace-output assertion; not a credential.
    expect(out).toContain("event=PreToolUse");
    expect(out).toContain("tool=Bash");
    expect(out).toContain("session=s1");
    expect(out).toContain("modules=1");
    expect(out).toContain("→ deny");
    expect(out).toMatch(/time=\d+ms/);
    expect(out.split("\n").filter((l) => l !== "").length).toBe(1);
  });

  test("trace line includes label when the rule has one", async () => {
    const cap = captureStderr();
    try {
      await withEnv("HOOK_KIT_VERBOSE", "1", async () => {
        const { adapter } = rawAdapter(bashEvent("rm -rf /tmp/x"));
        const modules = [
          createModule({ id: "m", name: "fs", events: ["PreToolUse"], matchers: ["Bash"] }, [
            cmd("rm").withFlag("-r").withFlag("-f").deny("no rm -rf", "[fs-guard]"),
          ]),
        ];
        await run(modules, adapter);
      });
    } finally {
      cap.restore();
    }
    expect(cap.output()).toContain("label=[fs-guard]");
  });

  test("emits null decision trace when no rule matches", async () => {
    const cap = captureStderr();
    try {
      await withEnv("HOOK_KIT_VERBOSE", "1", async () => {
        const { adapter } = rawAdapter(bashEvent("ls -la"));
        const modules = [
          createModule({ id: "m", name: "fs", events: ["PreToolUse"], matchers: ["Bash"] }, [
            cmd("rm").deny("no rm"),
          ]),
        ];
        await run(modules, adapter);
      });
    } finally {
      cap.restore();
    }
    expect(cap.output()).toContain("→ null");
  });

  test("no trace when HOOK_KIT_VERBOSE is unset", async () => {
    const cap = captureStderr();
    try {
      await withEnv("HOOK_KIT_VERBOSE", undefined, async () => {
        const { adapter } = rawAdapter(bashEvent("git push --force"));
        const modules = [
          createModule(
            { id: "m", name: "force-push", events: ["PreToolUse"], matchers: ["Bash"] },
            [cmd("git", "push").withFlag("--force").deny("no force pushes")],
          ),
        ];
        await run(modules, adapter);
      });
    } finally {
      cap.restore();
    }
    expect(cap.output()).toBe("");
  });
});
