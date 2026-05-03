import { describe, expect, test } from "bun:test";
import { decideCcOutput, parseHookInput } from "../../src/adapters/claude-code.js";
import type { HookEvent } from "../../src/core/types.js";

function event(eventName: string): HookEvent {
  return {
    eventName,
    sessionId: "s1",
    cwd: "/tmp",
    transcriptPath: "/tmp/t.jsonl",
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    raw: {},
  };
}

describe("decideCcOutput — null (silent)", () => {
  test("PreToolUse null = exit 0, no output", () => {
    expect(decideCcOutput(null, event("PreToolUse"))).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  test("PostToolUse null = exit 0, no output", () => {
    expect(decideCcOutput(null, event("PostToolUse"))).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("decideCcOutput — deny", () => {
  test("PreToolUse deny = JSON block decision, exit 0", () => {
    const out = decideCcOutput({ kind: "deny", reason: "no force pushes" }, event("PreToolUse"));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const parsed = JSON.parse(out.stdout);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "block",
        permissionDecisionReason: "no force pushes",
      },
    });
  });

  test("PostToolUse deny = stderr + exit 2", () => {
    const out = decideCcOutput({ kind: "deny", reason: "broken file" }, event("PostToolUse"));
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("broken file\n");
  });

  test("SessionStart deny = stderr + exit 2", () => {
    const out = decideCcOutput({ kind: "deny", reason: "no session" }, event("SessionStart"));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("no session\n");
  });

  test("Stop deny = stderr + exit 2", () => {
    const out = decideCcOutput({ kind: "deny", reason: "missing decisions" }, event("Stop"));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("missing decisions\n");
  });

  test("label is prepended on PreToolUse deny", () => {
    const out = decideCcOutput(
      { kind: "deny", reason: "blocked", label: "[security]" },
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("[security] blocked");
  });

  test("label is prepended on PostToolUse deny", () => {
    const out = decideCcOutput(
      { kind: "deny", reason: "blocked", label: "[security]" },
      event("PostToolUse"),
    );
    expect(out.stderr).toBe("[security] blocked\n");
  });
});

describe("decideCcOutput — context", () => {
  test("context emits additionalContext, exit 0", () => {
    const out = decideCcOutput({ kind: "context", message: "FYI" }, event("PreToolUse"));
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const parsed = JSON.parse(out.stdout);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "FYI",
      },
    });
  });

  test("context on PostToolUse emits additionalContext", () => {
    const out = decideCcOutput({ kind: "context", message: "info" }, event("PostToolUse"));
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("info");
  });

  test("context preserves label", () => {
    const out = decideCcOutput(
      { kind: "context", message: "warn", label: "[note]" },
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[note] warn");
  });
});

describe("decideCcOutput — escalate (M1 stub)", () => {
  test("PreToolUse escalate degrades to deny with explanatory reason", () => {
    const out = decideCcOutput({ kind: "escalate", reason: "needs human" }, event("PreToolUse"));
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "escalation not yet implemented",
    );
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("needs human");
  });

  test("PostToolUse escalate degrades to stderr + exit 2", () => {
    const out = decideCcOutput({ kind: "escalate", reason: "needs human" }, event("PostToolUse"));
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("escalation not yet implemented");
    expect(out.stderr).toContain("needs human");
  });
});

describe("parseHookInput", () => {
  test("parses a valid CC HookInput payload", () => {
    const raw = JSON.stringify({
      session_id: "abc",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/home/me",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    const ev = parseHookInput(raw);
    expect(ev.eventName).toBe("PreToolUse");
    expect(ev.sessionId).toBe("abc");
    expect(ev.toolName).toBe("Bash");
    expect(ev.toolInput).toEqual({ command: "ls -la" });
  });

  test("preserves harness-added extra fields on event.raw", () => {
    const raw = JSON.stringify({
      session_id: "abc",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/home/me",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      // Extra field that's not in the documented schema — custom rules may need it.
      stop_hook_active: true,
    });
    const ev = parseHookInput(raw);
    expect(ev.raw.stop_hook_active).toBe(true);
  });

  test("throws on empty input", () => {
    expect(() => parseHookInput("")).toThrow();
  });

  test("throws on whitespace-only input", () => {
    expect(() => parseHookInput("   \n  ")).toThrow();
  });

  test("throws on malformed JSON", () => {
    expect(() => parseHookInput("{ not json")).toThrow();
  });

  test("throws on missing required fields", () => {
    expect(() => parseHookInput(JSON.stringify({ session_id: "x" }))).toThrow();
  });
});
