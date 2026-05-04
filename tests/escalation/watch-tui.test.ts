import { describe, expect, test } from "bun:test";
import { createAskRequest } from "../../src/escalation/envelope.js";
import { type PendingRow, renderTui, type TuiState } from "../../src/escalation/watch-tui.js";

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[a-zA-Z]`, "g");
function strip(s: string): string {
  // Strip ANSI escape sequences for stable assertions on visible content.
  return s.replace(ANSI, "");
}

function row(sessionId: string, command: string, observedAt: number): PendingRow {
  const req = createAskRequest({
    sessionId,
    toolName: "Bash",
    toolInput: { command },
    reason: "test",
  });
  return { request: req, observedAt };
}

const NOW = 1_700_000_000_000;

function listState(rows: PendingRow[], selected = 0): TuiState {
  return {
    rows,
    selectedIndex: selected,
    mode: { kind: "list" },
    listenerCount: rows.length > 0 ? 1 : 0,
  };
}

describe("renderTui — list mode", () => {
  test("renders the empty state", () => {
    const out = strip(renderTui(listState([]), 100, NOW));
    expect(out).toContain("hook-kit watch");
    expect(out).toContain("0 pending");
    expect(out).toContain("(no pending requests");
  });

  test("renders a single row with the cursor on it", () => {
    const r = row("abc-123", "git push --force", NOW - 12_000);
    const out = strip(renderTui(listState([r]), 100, NOW));
    expect(out).toContain("abc-123");
    expect(out).toContain("git push --force");
    expect(out).toContain("12s");
    expect(out).toContain("❯ ");
  });

  test("highlights only the selected row across multiple", () => {
    const a = row("s1", "ls -la", NOW - 1_000);
    const b = row("s2", "rm -rf /tmp/x", NOW - 5_000);
    const out = strip(renderTui(listState([a, b], 1), 100, NOW));
    // The selected (second) row should carry the cursor; the first should not.
    const lines = out.split("\n");
    const sel = lines.find((l) => l.startsWith("❯ "));
    expect(sel).toBeDefined();
    expect(sel).toContain("rm -rf");
    const firstLine = lines.find((l) => l.startsWith("  ") && l.includes("ls -la"));
    expect(firstLine).toBeDefined();
  });

  test("truncates long commands to fit terminal width", () => {
    const long = "a".repeat(500);
    const r = row("s1", long, NOW);
    const out = strip(renderTui(listState([r]), 80, NOW));
    expect(out.split("\n").every((l) => l.length <= 80)).toBe(true);
    expect(out).toContain("…");
  });

  test("shows the keyboard help footer", () => {
    const r = row("s1", "ls", NOW);
    const out = strip(renderTui(listState([r]), 100, NOW));
    expect(out).toContain("allow");
    expect(out).toContain("deny");
    expect(out).toContain("escalate-up");
    expect(out).toContain("quit");
  });

  test("shows attached listener count", () => {
    const r = row("s1", "ls", NOW);
    const state = { ...listState([r]), listenerCount: 3 };
    const out = strip(renderTui(state, 100, NOW));
    expect(out).toContain("3 listeners attached");
  });

  test("renders a status message under the help footer", () => {
    const r = row("s1", "ls", NOW);
    const state: TuiState = {
      ...listState([r]),
      statusMessage: { text: "allow abc-123", level: "ok" },
    };
    const out = strip(renderTui(state, 100, NOW));
    expect(out).toContain("allow abc-123");
  });
});

describe("renderTui — prompt mode", () => {
  test("displays the action label and reason buffer", () => {
    const r = row("abc-123", "git push --force", NOW);
    const state: TuiState = {
      rows: [r],
      selectedIndex: 0,
      mode: { kind: "prompt", action: "deny", reasonBuffer: "no force pushes" },
      listenerCount: 1,
    };
    const out = strip(renderTui(state, 100, NOW));
    expect(out).toContain("DENY");
    expect(out).toContain("no force pushes");
    expect(out).toContain("Enter to submit, Esc to cancel");
    expect(out).toContain(r.request.id);
  });

  test("shows empty reason buffer cleanly", () => {
    const r = row("abc-123", "ls", NOW);
    const state: TuiState = {
      rows: [r],
      selectedIndex: 0,
      mode: { kind: "prompt", action: "allow", reasonBuffer: "" },
      listenerCount: 1,
    };
    const out = strip(renderTui(state, 100, NOW));
    expect(out).toContain("ALLOW");
  });

  test("escalate-up label is yellow-coded (visible in stripped output)", () => {
    const r = row("s1", "ls", NOW);
    const state: TuiState = {
      rows: [r],
      selectedIndex: 0,
      mode: { kind: "prompt", action: "escalate-up", reasonBuffer: "" },
      listenerCount: 0,
    };
    const out = strip(renderTui(state, 100, NOW));
    expect(out).toContain("ESCALATE-UP");
  });
});

describe("renderTui — age formatting", () => {
  test("seconds for ages under a minute", () => {
    const r = row("s1", "ls", NOW - 30_000);
    expect(strip(renderTui(listState([r]), 100, NOW))).toContain("30s");
  });

  test("minutes for ages over a minute", () => {
    const r = row("s1", "ls", NOW - 3 * 60_000);
    expect(strip(renderTui(listState([r]), 100, NOW))).toContain("3m");
  });

  test("hours for ages over an hour", () => {
    const r = row("s1", "ls", NOW - 2 * 60 * 60_000);
    expect(strip(renderTui(listState([r]), 100, NOW))).toContain("2h");
  });
});
