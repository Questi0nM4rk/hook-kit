import { describe, expect, test } from "bun:test";
import { path } from "../../src/builders/path.js";
import type { Annotation, HookEvent, Rule, Terminal } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// Polymorphic event factory: path() tests probe arbitrary tool channels
// (Write/Edit/Read/NotebookEdit/Bash/MysteryTool) and malformed inputs
// (missing/empty file_path, `{}`). The typed SDK factories (writeEvent/editEvent/
// readEvent) deliberately can't express those shapes, so this stays hand-rolled.
function event(toolName: string, toolInput: Record<string, unknown>): HookEvent {
  return {
    eventName: "PreToolUse",
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName,
    toolInput,
    raw: {},
  };
}

async function run(
  toolName: string,
  toolInput: Record<string, unknown>,
  rule: Rule,
): Promise<Terminal | null> {
  const outcome = await evaluate(event(toolName, toolInput), [moduleWith([rule])]);
  return outcome.terminal;
}

async function runAnnotations(
  toolName: string,
  toolInput: Record<string, unknown>,
  rule: Rule,
): Promise<readonly Annotation[]> {
  const outcome = await evaluate(event(toolName, toolInput), [moduleWith([rule])]);
  return outcome.annotations;
}

describe("path() — basic matching", () => {
  test("matches Write when file_path matches the pattern", async () => {
    const d = await run(
      "Write",
      { file_path: "/tmp/foo.generated.cs" },
      path(/\.generated\.cs$/).deny("no edits"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no edits" });
  });

  test("matches Edit when file_path matches the pattern", async () => {
    const d = await run("Edit", { file_path: "/tmp/x.g.cs" }, path(/\.g\.cs$/).deny("blocked"));
    expect(d).toEqual({ kind: "deny", reason: "blocked" });
  });

  test("matches Read when file_path matches the pattern", async () => {
    const d = await run("Read", { file_path: "/etc/passwd" }, path(/\/etc\/passwd/).deny("nope"));
    expect(d).toEqual({ kind: "deny", reason: "nope" });
  });

  test("does not match when file_path does not match the pattern", async () => {
    const d = await run(
      "Write",
      { file_path: "/tmp/safe.txt" },
      path(/\.generated\.cs$/).deny("nope"),
    );
    expect(d).toBeNull();
  });

  test("does not match when file_path is missing", async () => {
    const d = await run("Write", {}, path(/.*/).deny("nope"));
    expect(d).toBeNull();
  });

  test("does not match when file_path is the empty string", async () => {
    const d = await run("Write", { file_path: "" }, path(/.*/).deny("nope"));
    expect(d).toBeNull();
  });
});

describe("path() — onWrite / onRead", () => {
  test("onWrite matches Write events", async () => {
    const d = await run(
      "Write",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onWrite()
        .deny("no"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no" });
  });

  test("onWrite matches Edit events (Edit is Write-adjacent)", async () => {
    const d = await run(
      "Edit",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onWrite()
        .deny("no"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no" });
  });

  test("onWrite does NOT match Read events", async () => {
    const d = await run(
      "Read",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onWrite()
        .deny("no"),
    );
    expect(d).toBeNull();
  });

  test("onRead matches Read events", async () => {
    const d = await run(
      "Read",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onRead()
        .deny("no"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no" });
  });

  test("onRead does NOT match Write events", async () => {
    const d = await run(
      "Write",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onRead()
        .deny("no"),
    );
    expect(d).toBeNull();
  });

  test("onRead does NOT match Edit events", async () => {
    const d = await run(
      "Edit",
      { file_path: "/x.txt" },
      path(/x\.txt/)
        .onRead()
        .deny("no"),
    );
    expect(d).toBeNull();
  });

  test("default (no event filter) matches both Write and Read", async () => {
    const writeD = await run("Write", { file_path: "/x" }, path(/x/).deny("no"));
    const readD = await run("Read", { file_path: "/x" }, path(/x/).deny("no"));
    expect(writeD).toEqual({ kind: "deny", reason: "no" });
    expect(readD).toEqual({ kind: "deny", reason: "no" });
  });
});

describe("path() — non-applicable tools", () => {
  test("does not match Bash events", async () => {
    const d = await run("Bash", { command: "rm /etc/passwd" }, path(/\/etc\/passwd/).deny("no"));
    expect(d).toBeNull();
  });

  test("does not match unknown tool names", async () => {
    const d = await run("MysteryTool", { file_path: "/x" }, path(/x/).deny("no"));
    expect(d).toBeNull();
  });
});

describe("path() — NotebookEdit", () => {
  test("matches NotebookEdit using notebook_path field", async () => {
    const d = await run(
      "NotebookEdit",
      { notebook_path: "/x.ipynb" },
      path(/\.ipynb$/)
        .onWrite()
        .deny("no"),
    );
    expect(d).toEqual({ kind: "deny", reason: "no" });
  });
});

describe("path() — terminal + annotation forms", () => {
  test("warning() returns a warning annotation", async () => {
    const anns = await runAnnotations("Write", { file_path: "/x" }, path(/x/).warning("danger"));
    expect(anns).toEqual([{ kind: "warning", message: "danger" }]);
  });

  test("note() returns a note annotation", async () => {
    const anns = await runAnnotations("Write", { file_path: "/x" }, path(/x/).note("info"));
    expect(anns).toEqual([{ kind: "note", message: "info" }]);
  });

  test("escalate() returns an escalate terminal", async () => {
    const t = await run("Write", { file_path: "/x" }, path(/x/).ask("ask"));
    expect(t).toEqual({ kind: "ask", reason: "ask" });
  });

  test("deny terminal label is preserved", async () => {
    const t = await run("Write", { file_path: "/x" }, path(/x/).deny("blocked", "[security]"));
    expect(t).toEqual({ kind: "deny", reason: "blocked", label: "[security]" });
  });
});
