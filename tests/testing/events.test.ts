import { describe, expect, test } from "bun:test";
import { bashEvent, editEvent, readEvent, writeEvent } from "../../src/testing/events.js";

describe("bashEvent", () => {
  test("defaults: PreToolUse / Bash / command in toolInput", () => {
    const e = bashEvent("rm -rf /tmp/x");
    expect(e.eventName).toBe("PreToolUse");
    expect(e.toolName).toBe("Bash");
    expect(e.toolInput).toEqual({ command: "rm -rf /tmp/x" });
    expect(e.sessionId).toBe("test");
    expect(e.cwd).toBe("/tmp");
    expect(e.transcriptPath).toBe("");
    expect(e.raw).toEqual({});
  });

  test("opts override defaults", () => {
    const e = bashEvent("ls", {
      sessionId: "abc-123",
      cwd: "/work",
      transcriptPath: "/tmp/transcript.jsonl",
      eventName: "PostToolUse",
    });
    expect(e.sessionId).toBe("abc-123");
    expect(e.cwd).toBe("/work");
    expect(e.transcriptPath).toBe("/tmp/transcript.jsonl");
    expect(e.eventName).toBe("PostToolUse");
  });
});

describe("writeEvent", () => {
  test("without content: file_path only", () => {
    const e = writeEvent("/tmp/x.txt");
    expect(e.toolName).toBe("Write");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt" });
  });

  test("with content: includes content", () => {
    const e = writeEvent("/tmp/x.txt", "hello");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt", content: "hello" });
  });

  test("empty string content is still set (not equivalent to undefined)", () => {
    const e = writeEvent("/tmp/x.txt", "");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt", content: "" });
  });
});

describe("editEvent", () => {
  test("all undefined: only file_path", () => {
    const e = editEvent("/tmp/x.txt");
    expect(e.toolName).toBe("Edit");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt" });
  });

  test("oldStr only", () => {
    const e = editEvent("/tmp/x.txt", "old");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt", old_string: "old" });
  });

  test("oldStr + newStr", () => {
    const e = editEvent("/tmp/x.txt", "old", "new");
    expect(e.toolInput).toEqual({
      file_path: "/tmp/x.txt",
      old_string: "old",
      new_string: "new",
    });
  });

  test("newStr only (oldStr undefined)", () => {
    const e = editEvent("/tmp/x.txt", undefined, "new");
    expect(e.toolInput).toEqual({ file_path: "/tmp/x.txt", new_string: "new" });
  });
});

describe("readEvent", () => {
  test("returns Read event for filePath", () => {
    const e = readEvent("/tmp/secret.env");
    expect(e.toolName).toBe("Read");
    expect(e.toolInput).toEqual({ file_path: "/tmp/secret.env" });
  });
});
