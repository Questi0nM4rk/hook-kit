/** @internal — no stability promise, may move/rename in any release.
 *  Reference TUI listener used by `hook-kit watch`. */
// Minimal interactive TUI for `hook-kit watch`.
// Two modes:
//   - "list": shows pending requests with ↑/↓/j/k navigation and a/d/e/q
//     keystrokes to act on the highlighted row.
//   - "prompt": one-line reason prompt activated when the user picks an
//     action; Enter commits, Esc cancels back to list.
//
// Render is a pure function over state for testability. The IO loop
// (process.stdin raw mode + setInterval poll) lives in `runWatchTui`.

import { listPending, listSessions, submitDecision } from "./broker.js";
import type { AskRequest } from "./envelope.js";
import { forwardUp } from "./forward.js";
import { registerListener } from "./listeners.js";

// ─────────────────────── ANSI escape helpers ────────────────────────

const ESC = "\x1b";
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const CLEAR_LINE = `${ESC}[K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ALT_BUFFER_ON = `${ESC}[?1049h`;
const ALT_BUFFER_OFF = `${ESC}[?1049l`;

const fg = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  reverse: `${ESC}[7m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
};

// ─────────────────────────── State ──────────────────────────────────

export type DecideAction = "allow" | "deny" | "escalate-up";

export interface PendingRow {
  readonly request: AskRequest;
  readonly observedAt: number;
}

export type TuiMode =
  | { kind: "list" }
  | { kind: "prompt"; action: DecideAction; reasonBuffer: string };

export interface TuiState {
  readonly rows: readonly PendingRow[];
  readonly selectedIndex: number;
  readonly mode: TuiMode;
  readonly listenerCount: number;
  readonly statusMessage?: { text: string; level: "info" | "ok" | "warn" | "error" };
}

// ─────────────────────────── Render ─────────────────────────────────

const COL_SESSION = 18;
const COL_REQID = 10;
const COL_AGE = 6;
const COL_TOOL = 8;

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

function fmtDetails(req: AskRequest): string {
  const input = req.toolInput as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : undefined;
  if (command !== undefined) return command;
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : typeof input.path === "string"
          ? input.path
          : undefined;
  if (filePath !== undefined) return filePath;
  return JSON.stringify(req.toolInput);
}

function fmtGit(g: NonNullable<AskRequest["git"]>): string {
  const parts: string[] = [];
  if (g.branch !== undefined) parts.push(g.branch);
  if (g.dirty === true) parts.push("(dirty)");
  parts.push(`@ ${g.sha.slice(0, 7)}`);
  if (g.remote !== undefined) parts.push(`origin: ${g.remote}`);
  return parts.join(" ");
}

function fmtExpires(iso: string, now: number): string {
  const expires = Date.parse(iso);
  if (Number.isNaN(expires)) return iso;
  const ms = expires - now;
  if (ms <= 0) return "expired";
  return `in ${fmtAge(ms)}`;
}

function fmtHarness(h: AskRequest["harness"]): string {
  return h.version !== undefined ? `${h.name} ${h.version}` : h.name;
}

/** Render a multi-line detail pane for the selected request. Empty list when
 *  no row is selected. Each line is width-truncated. */
function renderDetail(req: AskRequest, w: number, now: number): string[] {
  const lines: string[] = [];
  const title = `┌─ details: ${req.id} `;
  lines.push(`${fg.gray}${title}${"─".repeat(Math.max(0, w - title.length))}${fg.reset}`);

  const fields: Array<[string, string | undefined]> = [
    ["harness", fmtHarness(req.harness)],
    ["project", req.cwd !== "" ? req.cwd : undefined],
    ["git", req.git !== undefined ? fmtGit(req.git) : undefined],
    ["transcript", req.transcriptPath !== "" ? req.transcriptPath : undefined],
    ["origin", `pid ${req.pid} @ ${req.host} (${req.user})`],
    ["expires", fmtExpires(req.expiresAt, now)],
    ["label", req.label],
    ["reason", req.reason !== "" ? req.reason : undefined],
    ["command", fmtDetails(req)],
  ];

  const labelWidth = 11;
  const valueBudget = Math.max(8, w - 4 - labelWidth);
  for (const [name, value] of fields) {
    if (value === undefined) continue;
    const label = `${name}:`.padEnd(labelWidth);
    lines.push(
      `${fg.gray}│${fg.reset} ${fg.dim}${label}${fg.reset} ${truncate(value, valueBudget)}`,
    );
  }

  // Annotations carry their own per-line `[label] warning|note: msg` format,
  // so render one row per line with the label only on the first entry. Keeps
  // the human reviewer in sync with the context the AI would have seen.
  if (req.annotations !== undefined && req.annotations !== "") {
    const annLines = req.annotations.split("\n").filter((l) => l !== "");
    annLines.forEach((line, idx) => {
      const label = (idx === 0 ? "annotations:" : "").padEnd(labelWidth);
      lines.push(
        `${fg.gray}│${fg.reset} ${fg.dim}${label}${fg.reset} ${truncate(line, valueBudget)}`,
      );
    });
  }

  lines.push(`${fg.gray}└${"─".repeat(Math.max(0, w - 1))}${fg.reset}`);
  return lines;
}

function statusColor(level: NonNullable<TuiState["statusMessage"]>["level"]): string {
  switch (level) {
    case "ok":
      return fg.green;
    case "warn":
      return fg.yellow;
    case "error":
      return fg.red;
    default:
      return fg.cyan;
  }
}

export function renderTui(state: TuiState, terminalWidth: number, now: number): string {
  const lines: string[] = [];
  const w = Math.max(60, terminalWidth);
  const selected = state.rows[state.selectedIndex];

  // ─ Header
  const title = `${fg.bold}hook-kit watch${fg.reset}`;
  const counts = `${state.rows.length} pending  ·  ${state.listenerCount} listener${state.listenerCount === 1 ? "" : "s"} attached`;
  lines.push(
    `${title}${" ".repeat(Math.max(1, w - "hook-kit watch".length - counts.length))}${fg.dim}${counts}${fg.reset}`,
  );
  lines.push("");

  // ─ Column header
  const header = [
    "SESSION".padEnd(COL_SESSION),
    "REQ-ID".padEnd(COL_REQID),
    "AGE".padEnd(COL_AGE),
    "TOOL".padEnd(COL_TOOL),
    "DETAILS",
  ].join("  ");
  lines.push(`  ${fg.gray}${header}${fg.reset}`);

  // ─ Rows
  if (state.rows.length === 0) {
    lines.push(`  ${fg.dim}(no pending requests — waiting…)${fg.reset}`);
  } else {
    for (let i = 0; i < state.rows.length; i++) {
      const row = state.rows[i];
      if (row === undefined) continue;
      const age = fmtAge(now - row.observedAt);
      const detailsBudget = Math.max(8, w - (COL_SESSION + COL_REQID + COL_AGE + COL_TOOL + 2 + 8));
      const cells = [
        truncate(row.request.sessionId, COL_SESSION).padEnd(COL_SESSION),
        truncate(row.request.id, COL_REQID).padEnd(COL_REQID),
        age.padEnd(COL_AGE),
        truncate(row.request.toolName, COL_TOOL).padEnd(COL_TOOL),
        truncate(fmtDetails(row.request), detailsBudget),
      ].join("  ");
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? `${fg.cyan}❯${fg.reset} ` : "  ";
      const body = isSelected ? `${fg.bold}${cells}${fg.reset}` : cells;
      lines.push(`${prefix}${body}`);
    }
  }

  // ─ Detail pane for the selected row
  if (selected !== undefined) {
    lines.push("");
    lines.push(...renderDetail(selected.request, w, now));
  }

  // ─ Padding so the prompt area is anchored
  while (lines.length < 30) lines.push("");

  // ─ Footer / prompt
  if (state.mode.kind === "prompt") {
    const action = state.mode.action.toUpperCase();
    const color =
      state.mode.action === "allow" ? fg.green : state.mode.action === "deny" ? fg.red : fg.yellow;
    const target =
      selected !== undefined
        ? `${selected.request.id} (${selected.request.toolName})`
        : "<no selection>";
    lines.push(
      `${color}${fg.bold}${action}${fg.reset}  reason for ${target} — Enter to submit, Esc to cancel`,
    );
    lines.push(`${fg.bold}>${fg.reset} ${state.mode.reasonBuffer}${fg.dim}_${fg.reset}`);
  } else {
    const help = [
      `${fg.cyan}↑↓${fg.reset}/${fg.cyan}jk${fg.reset} select`,
      `${fg.green}a${fg.reset}llow`,
      `${fg.red}d${fg.reset}eny`,
      `${fg.yellow}e${fg.reset}scalate-up`,
      `${fg.cyan}q${fg.reset}uit`,
    ].join("  ·  ");
    lines.push(help);
    if (state.statusMessage !== undefined) {
      lines.push(`${statusColor(state.statusMessage.level)}${state.statusMessage.text}${fg.reset}`);
    } else {
      lines.push("");
    }
  }

  return lines.map((l) => `${l}${CLEAR_LINE}`).join("\n");
}

// ─────────────────────────── IO loop ────────────────────────────────

export interface RunWatchTuiOptions {
  readonly sessionFilter?: string;
  readonly childrenOf?: string;
  readonly pollMs?: number;
  /**
   * Override the listener-marker root. Used by tests; production reads the
   * default ~/.cache/hook-kit/sessions.
   */
  readonly root?: string;
}

interface MutableState {
  rows: PendingRow[];
  selectedIndex: number;
  mode: TuiMode;
  listenerCount: number;
  statusMessage: { text: string; level: "info" | "ok" | "warn" | "error" } | undefined;
  attachedSessions: Map<string, () => void>;
}

function refreshRows(state: MutableState, opts: RunWatchTuiOptions): void {
  const filter = opts.sessionFilter;
  const sessions =
    filter !== undefined
      ? [{ sessionId: filter }]
      : listSessions(opts.childrenOf !== undefined ? { childrenOf: opts.childrenOf } : {});
  const seenRowIds = new Set<string>();
  const newRows: PendingRow[] = [];
  for (const s of sessions) {
    const sid = (s as { sessionId: string }).sessionId;
    // Re-attach a listener marker on each freshly observed session.
    if (!state.attachedSessions.has(sid)) {
      state.attachedSessions.set(sid, registerListener(sid, "watch"));
    }
    const pending = listPending(sid);
    for (const req of pending) {
      const existing = state.rows.find((r) => r.request.id === req.id);
      newRows.push({
        request: req,
        observedAt: existing?.observedAt ?? Date.now(),
      });
      seenRowIds.add(req.id);
    }
  }
  state.rows = newRows.sort((a, b) => a.observedAt - b.observedAt);
  state.listenerCount = state.attachedSessions.size;
  if (state.selectedIndex >= state.rows.length) {
    state.selectedIndex = Math.max(0, state.rows.length - 1);
  }
}

function commit(state: MutableState, action: DecideAction, reason: string): void {
  const row = state.rows[state.selectedIndex];
  if (row === undefined) return;
  if (action === "escalate-up") {
    void forwardUp(row.request.sessionId, row.request.id).then((result) => {
      state.statusMessage = {
        text: `escalate-up ${row.request.id} → ${result.kind}${result.parentSessionId !== undefined ? ` (parent ${result.parentSessionId})` : ""}`,
        level: result.kind === "missing-pending" ? "error" : "ok",
      };
    });
    state.statusMessage = {
      text: `escalate-up ${row.request.id} forwarding…`,
      level: "info",
    };
    return;
  }
  const ok = submitDecision(
    row.request.sessionId,
    row.request.id,
    action,
    reason !== "" ? reason : undefined,
    {
      by: `tui:pid${process.pid}`,
    },
  );
  state.statusMessage = ok
    ? { text: `${action} ${row.request.id}`, level: "ok" }
    : { text: `${row.request.id} already decided (first-writer-wins)`, level: "warn" };
}

export async function runWatchTui(opts: RunWatchTuiOptions = {}): Promise<void> {
  const state: MutableState = {
    rows: [],
    selectedIndex: 0,
    mode: { kind: "list" },
    listenerCount: 0,
    statusMessage: undefined,
    attachedSessions: new Map(),
  };

  if (opts.sessionFilter !== undefined) {
    state.attachedSessions.set(opts.sessionFilter, registerListener(opts.sessionFilter, "watch"));
  }

  const stdout = process.stdout;
  const stdin = process.stdin;

  const cleanup = (): void => {
    for (const fn of state.attachedSessions.values()) fn();
    state.attachedSessions.clear();
    stdout.write(`${SHOW_CURSOR}${ALT_BUFFER_OFF}`);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.removeListener("data", onData);
  };

  const render = (): void => {
    refreshRows(state, opts);
    const width = stdout.columns ?? 100;
    const frame = renderTui(toReadonly(state), width, Date.now());
    stdout.write(`${CLEAR_SCREEN}${frame}`);
  };

  const onData = (buf: Buffer): void => {
    const data = buf.toString("utf8");
    if (state.mode.kind === "list") {
      handleListKey(state, data);
    } else {
      handlePromptKey(state, data);
    }
    render();
    if (state.mode.kind === "list" && state.statusMessage?.level === "ok") {
      // Auto-clear the status after the next render so it acts like a flash.
      setTimeout(() => {
        if (state.mode.kind === "list") {
          state.statusMessage = undefined;
          render();
        }
      }, 1500);
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  stdout.write(`${ALT_BUFFER_ON}${HIDE_CURSOR}`);

  const pollMs = opts.pollMs ?? 250;
  const interval = setInterval(render, pollMs);
  render();
  // Run forever — exit via SIGINT/SIGTERM/cleanup above.
  await new Promise(() => {});
  clearInterval(interval);
}

function toReadonly(s: MutableState): TuiState {
  const base = {
    rows: s.rows,
    selectedIndex: s.selectedIndex,
    mode: s.mode,
    listenerCount: s.listenerCount,
  };
  return s.statusMessage !== undefined ? { ...base, statusMessage: s.statusMessage } : base;
}

function handleListKey(state: MutableState, data: string): void {
  // Quit
  if (data === "q" || data === "\x03") {
    process.kill(process.pid, "SIGINT");
    return;
  }
  // Navigation
  if (data === "j" || data === "\x1b[B") {
    state.selectedIndex = Math.min(state.rows.length - 1, state.selectedIndex + 1);
    return;
  }
  if (data === "k" || data === "\x1b[A") {
    state.selectedIndex = Math.max(0, state.selectedIndex - 1);
    return;
  }
  // Decision modes
  if (state.rows.length === 0) return;
  if (data === "a") {
    state.mode = { kind: "prompt", action: "allow", reasonBuffer: "" };
    state.statusMessage = undefined;
    return;
  }
  if (data === "d") {
    state.mode = { kind: "prompt", action: "deny", reasonBuffer: "" };
    state.statusMessage = undefined;
    return;
  }
  if (data === "e") {
    state.mode = { kind: "prompt", action: "escalate-up", reasonBuffer: "" };
    state.statusMessage = undefined;
    return;
  }
}

function handlePromptKey(state: MutableState, data: string): void {
  if (state.mode.kind !== "prompt") return;
  // Esc → cancel
  if (data === "\x1b") {
    state.mode = { kind: "list" };
    return;
  }
  // Enter → submit
  if (data === "\r" || data === "\n") {
    const action = state.mode.action;
    const reason = state.mode.reasonBuffer;
    state.mode = { kind: "list" };
    commit(state, action, reason);
    return;
  }
  // Backspace
  if (data === "\x7f" || data === "\b") {
    state.mode = {
      kind: "prompt",
      action: state.mode.action,
      reasonBuffer: state.mode.reasonBuffer.slice(0, -1),
    };
    return;
  }
  // Ignore other control sequences
  if (data.charCodeAt(0) < 0x20) return;
  state.mode = {
    kind: "prompt",
    action: state.mode.action,
    reasonBuffer: state.mode.reasonBuffer + data,
  };
}
