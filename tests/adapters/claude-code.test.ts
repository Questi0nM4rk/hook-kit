import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideCcOutput, parseHookInput, resolveCcOutput } from "../../src/adapters/claude-code.js";
import type { Annotation, EvaluationOutcome, HookEvent, Terminal } from "../../src/core/types.js";

let askDir: string;

beforeEach(() => {
  askDir = mkdtempSync(join(tmpdir(), "hook-kit-cc-resolve-"));
});
afterEach(() => {
  rmSync(askDir, { recursive: true, force: true });
});

function stageAskpass(
  decision: "allow" | "deny" | "harness-ask",
  reason?: string,
  name = "ask.sh",
): string {
  // Heredoc avoids POSIX printf's implementation-defined `\"` handling
  // (dash on Ubuntu CI rejects what bash on developer laptops accepts).
  const reasonField = reason !== undefined ? `,"reason":"${reason}"` : "";
  const body = `#!/bin/sh
REQ=$(cat)
ID=$(printf %s "$REQ" | grep -oE '"id":"[^"]*"' | head -1 | sed 's/"id":"//; s/"$//')
cat <<EOF
{"id":"$ID","decision":"${decision}"${reasonField},"decidedAt":"2026-01-01T00:00:00Z"}
EOF
`;
  const path = join(askDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

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

/** Pure outcome with no terminal and no annotations — engine "null" path. */
const SILENT: EvaluationOutcome = { terminal: null, annotations: [] };

function outcome(
  terminal: Terminal | null,
  annotations: readonly Annotation[] = [],
): EvaluationOutcome {
  return { terminal, annotations };
}

describe("decideCcOutput — null outcome (silent)", () => {
  test("PreToolUse silent outcome → exit 0, no output", () => {
    expect(decideCcOutput(SILENT, event("PreToolUse"))).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  test("PostToolUse silent outcome → exit 0, no output", () => {
    expect(decideCcOutput(SILENT, event("PostToolUse"))).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });
});

describe("decideCcOutput — deny", () => {
  test("PreToolUse deny → JSON block decision, exit 0", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "no force pushes" }),
      event("PreToolUse"),
    );
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

  test("PostToolUse deny → stderr + exit 2", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "broken file" }),
      event("PostToolUse"),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("broken file\n");
  });

  test("SessionStart deny → stderr + exit 2", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "no session" }),
      event("SessionStart"),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("no session\n");
  });

  test("Stop deny → stderr + exit 2", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "missing decisions" }),
      event("Stop"),
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("missing decisions\n");
  });

  test("label is prepended on PreToolUse deny", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "blocked", label: "[security]" }),
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("[security] blocked");
  });

  test("label is prepended on PostToolUse deny", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "blocked", label: "[security]" }),
      event("PostToolUse"),
    );
    expect(out.stderr).toBe("[security] blocked\n");
  });

  test("deny DROPS accumulated annotations (deny is final)", () => {
    const out = decideCcOutput(
      outcome({ kind: "deny", reason: "blocked" }, [
        { kind: "warning", message: "dropped", label: "[w]" },
      ]),
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
    // The annotation must not appear in deny output — command never runs, so
    // surfacing warnings about a command that won't execute is noise.
    expect(out.stdout).not.toContain("dropped");
  });
});

describe("decideCcOutput — annotations only (no terminal)", () => {
  test("single warning emits additionalContext with prefixed label", () => {
    const out = decideCcOutput(
      outcome(null, [{ kind: "warning", message: "FYI", label: "[hint]" }]),
      event("PreToolUse"),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[hint] warning: FYI");
  });

  test("single note emits additionalContext with prefixed label", () => {
    const out = decideCcOutput(
      outcome(null, [{ kind: "note", message: "size 2KB", label: "[size]" }]),
      event("PostToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[size] note: size 2KB");
  });

  test("multiple annotations stack one per line", () => {
    const out = decideCcOutput(
      outcome(null, [
        { kind: "warning", message: "a", label: "[one]" },
        { kind: "note", message: "b", label: "[two]" },
      ]),
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[one] warning: a\n[two] note: b");
  });

  test("annotation with no label falls back to [hook-kit]", () => {
    const out = decideCcOutput(
      outcome(null, [{ kind: "warning", message: "no label" }]),
      event("PreToolUse"),
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[hook-kit] warning: no label");
  });
});

describe("decideCcOutput — escalate sync path (use resolveCcOutput in production)", () => {
  test("escalate on the sync path denies with a 'use resolveCcOutput' hint", () => {
    const out = decideCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }),
      event("PreToolUse"),
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("sync path");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("needs human");
  });
});

describe("resolveCcOutput — escalate via askpass", () => {
  test("askpass returns allow → silent (exit 0, no stdout) when no annotations", async () => {
    const askpass = stageAskpass("allow");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }),
      event("PreToolUse"),
      { askpassPath: askpass },
    );
    expect(out).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("askpass returns allow → annotations surfaced as additionalContext", async () => {
    const askpass = stageAskpass("allow");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }, [
        { kind: "warning", message: "after approval", label: "[w]" },
      ]),
      event("PreToolUse"),
      { askpassPath: askpass },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toBe("[w] warning: after approval");
  });

  test("askpass returns deny on PreToolUse → CC block JSON", async () => {
    const askpass = stageAskpass("deny", "policy violation");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }),
      event("PreToolUse"),
      { askpassPath: askpass },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("policy violation");
  });

  test("askpass returns deny on PostToolUse → stderr + exit 2", async () => {
    const askpass = stageAskpass("deny", "policy violation");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }),
      event("PostToolUse"),
      { askpassPath: askpass },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("policy violation");
  });

  test("askpass returns harness-ask on PreToolUse → CC permissionDecision: ask", async () => {
    const askpass = stageAskpass("harness-ask");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "review this" }),
      event("PreToolUse"),
      { askpassPath: askpass },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("review this");
  });

  test("harness-ask includes accumulated annotations in the reason text", async () => {
    const askpass = stageAskpass("harness-ask");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "review this" }, [
        { kind: "warning", message: "also danger", label: "[x]" },
        { kind: "note", message: "context info", label: "[y]" },
      ]),
      event("PreToolUse"),
      { askpassPath: askpass },
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("review this");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      "[x] warning: also danger",
    );
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("[y] note: context info");
  });

  test("askpass returns harness-ask on PostToolUse → degrades to additionalContext", async () => {
    const askpass = stageAskpass("harness-ask");
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "review this" }),
      event("PostToolUse"),
      { askpassPath: askpass },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("review this");
  });

  test("HOOK_KIT_ASKPASS unset → CC ask JSON (delegate to harness UI)", async () => {
    const out = await resolveCcOutput(
      outcome({ kind: "escalate", reason: "needs human" }),
      event("PreToolUse"),
      // Pass an empty path explicitly; do not let process.env leak in.
      { askpassPath: "" },
    );
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("needs human");
  });

  test("non-escalate outcomes delegate to the sync path unchanged", async () => {
    const allow = await resolveCcOutput(SILENT, event("PreToolUse"));
    expect(allow).toEqual({ stdout: "", stderr: "", exitCode: 0 });

    const deny = await resolveCcOutput(
      outcome({ kind: "deny", reason: "blocked" }),
      event("PreToolUse"),
    );
    const parsed = JSON.parse(deny.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("block");
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
