// In-process unit tests for the adapter-template's factory shape. Tests
// exercise readInput, writeOutput (deny / ask / annotation / silent),
// handleError without ever spawning the compiled binary — the compiled
// binary lives in `tests/build/adapter-template-e2e.test.ts` (in the
// hook-kit root) and validates the wire-format contract end-to-end.

import { describe, expect, test } from "bun:test";
import type { Annotation, EvaluationOutcome, Terminal } from "@questi0nm4rk/hook-kit";
import { bashEvent } from "@questi0nm4rk/hook-kit/testing";
import { type AdapterStreams, createMyAdapter } from "../src/my-adapter.js";
import { MyAdapterInputError } from "../src/parse-input.js";

interface CapturedStreams extends AdapterStreams {
  readonly stdoutBuf: string[];
  readonly stderrBuf: string[];
  exitCode: number | null;
}

/** Build streams over a fixed string input. */
function captureStreams(input: string): CapturedStreams {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const state = { exitCode: null as number | null };

  async function* stdinIter(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(input);
  }
  return {
    stdin: stdinIter(),
    stdout: {
      write(s: string): void {
        stdoutBuf.push(s);
      },
    },
    stderr: {
      write(s: string): void {
        stderrBuf.push(s);
      },
    },
    exit: (code: number): void => {
      state.exitCode = code;
    },
    stdoutBuf,
    stderrBuf,
    get exitCode(): number | null {
      return state.exitCode;
    },
    set exitCode(v: number | null) {
      state.exitCode = v;
    },
  };
}

function outcome(
  terminal: Terminal | null,
  annotations: readonly Annotation[] = [],
): EvaluationOutcome {
  return { terminal, annotations };
}

describe("createMyAdapter — readInput", () => {
  test("parses a well-formed JSON event into a HookEvent", async () => {
    const json = JSON.stringify({
      event: "PreToolUse",
      session: "s1",
      cwd: "/tmp",
      transcript: "/tmp/t.jsonl",
      tool: "Bash",
      input: { command: "rm -rf /tmp/x" },
    });
    const streams = captureStreams(json);
    const adapter = createMyAdapter({ streams });

    const event = await adapter.readInput();

    expect(event.eventName).toBe("PreToolUse");
    expect(event.sessionId).toBe("s1");
    expect(event.cwd).toBe("/tmp");
    expect(event.transcriptPath).toBe("/tmp/t.jsonl");
    expect(event.toolName).toBe("Bash");
    expect(event.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    // raw carries the original parsed object so consumer rules can read fields
    // the harness layered on top of the documented schema.
    expect(event.raw).toEqual(JSON.parse(json) as Record<string, unknown>);
  });

  test("throws MyAdapterInputError on empty stdin", async () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    try {
      await adapter.readInput();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MyAdapterInputError);
      expect((e as Error).message).toContain("empty stdin");
    }
  });

  test("throws MyAdapterInputError on non-JSON input", async () => {
    const streams = captureStreams("not json {{");
    const adapter = createMyAdapter({ streams });

    try {
      await adapter.readInput();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MyAdapterInputError);
      expect((e as Error).message).toContain("not JSON");
    }
  });

  test("throws MyAdapterInputError on JSON missing required fields", async () => {
    const streams = captureStreams(JSON.stringify({ event: "PreToolUse" }));
    const adapter = createMyAdapter({ streams });

    try {
      await adapter.readInput();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MyAdapterInputError);
      expect((e as Error).message).toContain("missing required fields");
    }
  });
});

describe("createMyAdapter — writeOutput", () => {
  test("deny: stderr line + exit 2 + no stdout", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(
      outcome({ kind: "deny", reason: "destructive rm -rf", label: "[template-demo]" }),
      bashEvent("echo hi"),
    );

    expect(streams.exitCode).toBe(2);
    expect(streams.stdoutBuf.join("")).toBe("");
    expect(streams.stderrBuf.join("")).toBe("[template-demo] denied: destructive rm -rf\n");
  });

  test("ask: stdout line + exit 1 + no stderr", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(
      outcome({ kind: "ask", reason: "force-push needs review", label: "[template-demo]" }),
      bashEvent("echo hi"),
    );

    expect(streams.exitCode).toBe(1);
    expect(streams.stdoutBuf.join("")).toBe(
      "[template-demo] needs review: force-push needs review\n",
    );
    expect(streams.stderrBuf.join("")).toBe("");
  });

  test("annotation-only (warning): stdout line + exit 0 + no terminal", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(
      outcome(null, [
        {
          kind: "warning",
          message: "rm without -rf still deletes files",
          label: "[template-demo]",
        },
      ]),
      bashEvent("echo hi"),
    );

    expect(streams.exitCode).toBe(0);
    expect(streams.stdoutBuf.join("")).toBe(
      "[template-demo] warning: rm without -rf still deletes files\n",
    );
    expect(streams.stderrBuf.join("")).toBe("");
  });

  test("silent: no annotations, no terminal -> exit 0 + no output", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(outcome(null), bashEvent("echo hi"));

    expect(streams.exitCode).toBe(0);
    expect(streams.stdoutBuf.join("")).toBe("");
    expect(streams.stderrBuf.join("")).toBe("");
  });

  test("error annotation surfaces to stderr even with no terminal", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(
      outcome(null, [
        {
          kind: "error",
          message: "shell-ast WASM failed",
          errorCode: "ShellAstParseError",
          label: "[template-demo]",
        },
      ]),
      bashEvent("echo hi"),
    );

    expect(streams.exitCode).toBe(0);
    expect(streams.stderrBuf.join("")).toContain(
      "[template-demo] error: ShellAstParseError: shell-ast WASM failed",
    );
  });

  test("error annotation survives alongside a deny", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.writeOutput(
      outcome({ kind: "deny", reason: "blocked", label: "[template-demo]" }, [
        {
          kind: "error",
          message: "state-flush failed",
          errorCode: "StateStoreError",
          label: "[template-demo]",
        },
      ]),
      bashEvent("echo hi"),
    );

    expect(streams.exitCode).toBe(2);
    const stderr = streams.stderrBuf.join("");
    expect(stderr).toContain("[template-demo] error: StateStoreError: state-flush failed");
    expect(stderr).toContain("[template-demo] denied: blocked");
  });

  test("decision label overrides the adapter's default label", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams, label: "[my-default]" });

    adapter.writeOutput(
      outcome({ kind: "ask", reason: "needs review", label: "[rule-specific]" }),
      bashEvent("echo hi"),
    );

    expect(streams.stdoutBuf.join("")).toBe("[rule-specific] needs review: needs review\n");
  });

  test("uses default label when terminal carries no label", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams, label: "[my-default]" });

    adapter.writeOutput(outcome({ kind: "deny", reason: "no label here" }), bashEvent("echo hi"));

    expect(streams.stderrBuf.join("")).toBe("[my-default] denied: no label here\n");
  });
});

describe("createMyAdapter — handleError", () => {
  test("writes fatal line to stderr and exits 2", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.handleError(new Error("kaboom"));

    expect(streams.exitCode).toBe(2);
    expect(streams.stderrBuf.join("")).toBe("[template-demo] fatal: kaboom\n");
  });

  test("stringifies non-Error throws", () => {
    const streams = captureStreams("");
    const adapter = createMyAdapter({ streams });

    adapter.handleError("not an Error");

    expect(streams.exitCode).toBe(2);
    expect(streams.stderrBuf.join("")).toBe("[template-demo] fatal: not an Error\n");
  });

  test("does not throw even when stderr write fails", () => {
    const stderrThatThrows = {
      write(): never {
        throw new Error("stderr is dead");
      },
    };
    const streams: AdapterStreams = {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional empty AsyncIterator/no-op writer/no-op exit for the stderr-throw test fixture.
      stdin: (async function* () {})(),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: stdout shouldn't be written to in this test path, no-op writer suffices.
      stdout: { write(): void {} },
      stderr: stderrThatThrows,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: exit is invoked but its side effect is not asserted in this fixture; no-op suffices.
      exit: () => {},
    };
    const adapter = createMyAdapter({ streams });

    // The contract: handleError MUST be total. A throw here would mean the
    // adapter just crashed the process in its top-level error handler.
    expect(() => adapter.handleError(new Error("kaboom"))).not.toThrow();
  });
});
