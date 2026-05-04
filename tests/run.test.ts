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
    expect(state.decision).toEqual({ kind: "deny", reason: "no force pushes" });
  });

  test("returns null decision when no rule matches", async () => {
    const { adapter, state } = rawAdapter(bashEvent("git pull"));
    const modules = [
      createModule({ id: "m", name: "force-push", events: ["PreToolUse"], matchers: ["Bash"] }, [
        cmd("git", "push").withFlag("--force").deny("no force"),
      ]),
    ];
    await run(modules, adapter);
    expect(state.decision).toBeNull();
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
    expect(state.decision).toEqual({ kind: "deny", reason: "edit the generator" });
  });
});
