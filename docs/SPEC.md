# hook-kit

Framework for building compiled hook binaries for AI coding agents. One package, one CLI, one library entry point. Targets Claude Code today; harness-agnostic core supports future agents (Cursor, Windsurf, raw API loops) via thin protocol adapters.

## Problem

AI coding agents fire hooks on every tool invocation (Bash, Write, Edit, Read, …). A hook is a short-lived process that decides whether the action proceeds. Without a framework each project reinvents stdin reading, shell-AST parsing, decision serialization, state management, and the per-process startup cost is paid in full per invocation. hook-kit owns the boilerplate so plugins ship rule data and a 50ms compiled binary.

## Iron Laws

1. **Rules are data, not scripts.** Declarative builders (`cmd`, `path`, `content`, `custom`, `stateful`), never raw shell. Testable without stdin mocking, composable across modules, inspectable for reporting.
2. **Parse once, evaluate many.** shell-ast WASM init is expensive (~200ms first call). The AST is parsed once per invocation and reused across all command rules.
3. **Fail open on infrastructure errors.** State store disk full, JSON parse error, rule throws — caught and treated as silent. The framework never blocks a developer because of its own bugs. Exception: an explicit `escalate` decision with no responder denies with a reason; it cannot silently allow.
4. **Blacklist semantics.** There is no `allow` decision. A hook either blocks or stays silent. If 20 rules pass and 1 blocks, it's blocked. Silent exit = nothing was wrong.
5. **Protocol adapter owns serialization.** The core engine returns generic `Decision` values. Adapters map them to harness-specific output. Switching harnesses changes one file.
6. **Each plugin compiles its own binary.** Plugin isolation. One plugin can iterate without affecting the others. Cost: N binary files instead of 1.
7. **Escalation is async and out-of-band.** Escalation requests publish to per-session ask channels; any registered listener (TTY, parent agent, bridge, harness UI) can answer through the same `askpass` contract. The hook binary blocks waiting for a decision but does not own the decision logic.

## Architecture

### Package Layout

```
@questi0nm4rk/hook-kit/
├── src/
│   ├── index.ts                  # Public barrel: types + builders + engine + run()
│   ├── core/
│   │   ├── types.ts              # Decision, HookEvent, HookModule, Rule, EvalContext
│   │   ├── decision.ts           # deny(), context(), escalate()
│   │   ├── event.ts              # toToolEvent() — typed view of HookEvent
│   │   └── module.ts             # createModule() factory
│   ├── rules/
│   │   ├── command.ts            # cmd() — shell-ast based command matching
│   │   ├── path.ts               # path() — file path patterns
│   │   ├── content.ts            # content() — PostToolUse body inspection
│   │   ├── custom.ts             # custom() — arbitrary predicates
│   │   └── state.ts              # stateful() — cross-invocation state
│   ├── engine/
│   │   ├── index.ts              # evaluate() — core loop
│   │   └── helpers.ts            # Flag expansion, redirect/pipe detection
│   ├── adapters/
│   │   ├── types.ts              # ProtocolAdapter interface
│   │   ├── claude-code.ts        # CC stdin/stdout JSON
│   │   └── raw.ts                # Library-mode / testing adapter
│   ├── state/
│   │   ├── types.ts              # StateStore interface
│   │   ├── tmpdir-store.ts       # Default: tmpdir JSON per session
│   │   └── memory-store.ts       # In-memory (testing)
│   ├── escalation/
│   │   ├── askpass.ts            # Spawn HOOK_KIT_ASKPASS, read decision
│   │   ├── broker.ts             # Default broker — per-session ask channels
│   │   └── envelope.ts           # JSON Schema for ask requests/decisions
│   └── build/
│       ├── cli.ts                # `hook-kit` CLI entry
│       └── bundle.ts             # Generates entrypoint, drives bun build --compile
└── tests/
```

### Core Types

```typescript
type Decision =
  | { kind: "deny"; reason: string; label?: string }
  | { kind: "context"; message: string; label?: string }
  | { kind: "escalate"; reason: string; label?: string }
  | null;  // silent — didn't block

interface HookEvent {
  eventName: string;             // PreToolUse, PostToolUse, SessionStart, Stop, …
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  toolName: string;
  toolInput: Readonly<Record<string, unknown>>;
  raw: Readonly<Record<string, unknown>>;
}

type ToolEvent =
  | { type: "bash"; command: string }
  | { type: "write"; path: string; content?: string }
  | { type: "read"; path: string }
  | { type: "edit"; path: string; oldStr?: string; newStr?: string }
  | { type: "other"; toolName: string; toolInput: Readonly<Record<string, unknown>> };

interface Rule {
  readonly kind: string;
  evaluate(event: HookEvent, ctx: EvalContext): Decision | Promise<Decision>;
}

interface EvalContext {
  readonly state: StateStore;
  readonly modules: readonly HookModule[];
}

interface HookModule {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];     // hook events this module handles
  readonly matchers?: readonly string[];  // tool name filters; "Bash", "Edit|Write"
  readonly rules: readonly Rule[];
  readonly enabled?: boolean;             // default true
}
```

`null` = silent pass-through (blacklist semantics: didn't block). Any non-null decision is an action.

| Kind | Effect |
|------|--------|
| `null` | Silent pass-through |
| `deny` | Hard block with reason |
| `context` | Inject message, no block |
| `escalate` | Ask for a decision via the askpass channel — see Escalation |

### Rule Builders

```typescript
// cmd(command, ...subcommands) — variadic, args[0..N] match subcommands by position
cmd("gh", "pr", "comment").deny("Use pr-review reply instead");
cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease")
  .deny("Use --force-with-lease, not raw --force");
cmd("gh", "api").argMatches(/\/pulls\/\d+\/reviews(?!\/)/)
  .deny("Use pr-review status");
```

Semantics:

- Variadic sub matching checks args by position. CLI convention: subcommands precede flags, so position is reliable.
- `.withFlag("--force")` — required (presence). Flags are expanded via aliases (`-f` → `--force`, `-r` → `--recursive`/`-R`).
- `.withoutFlag("--force-with-lease")` — forbidden (must be absent).
- `.argMatches(/regex/)` — at least one resolved arg matches the pattern. Resolved args include flag values when literal; quoted strings (`"…"`, `'…'`) become `<dynamic>` and never match literal patterns. Use this for unquoted patterns like `event=COMMENT` in `--field event=COMMENT`.
- `.argIncludes("literal")` — exact-string membership in resolved args.
- `.deny(reason)` / `.context(msg)` / `.escalate(reason)` — terminal; returns a `Rule`.

```typescript
// path(pattern) — regex on file_path
path(/\.generated\.cs$/).onWrite().deny("Edit the generator, not the output");
path(/\.env(\.|$)/).onRead().deny("Don't read environment files");
```

Defaults to both write+read. `.onWrite()` matches Write|Edit (Edit is Write-adjacent — file mutation is what matters). `.onRead()` matches Read.

```typescript
// content() — PostToolUse body inspection from disk
content().matchPath(/design\/.*\.md$/).validate((filePath, body) => {
  const missing = REQUIRED_SECTIONS.filter((s) => !s.test(body));
  if (missing.length > 0) return context(`Missing sections: ${missing.join(", ")}`);
  return null;
});
```

PostToolUse only — file is on disk after the tool ran. Edit's pre/post strings aren't needed; the disk has the final content.

```typescript
// stateful(id, fn) — cross-invocation state via StateStore
stateful("repetition", (event, state) => {
  const hash = sha256(event.toolName + JSON.stringify(event.toolInput));
  const count = (state.get(hash) as number ?? 0) + 1;
  state.set(hash, count);
  if (count > 3) return context(`This command has run ${count}× — break the loop`);
  return null;
});

// custom(id, fn) — escape hatch
custom("session-summary", async (event) => {
  // arbitrary logic; throw → caught → silent (Iron Law 3)
  return null;
});
```

### Engine

```typescript
async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts?: { state?: StateStore; shortCircuit?: boolean },
): Promise<Decision>;
```

Flow:

1. Filter modules by `events` (must include `event.eventName`).
2. Filter modules by `matchers` (if present, at least one matches `event.toolName`; `|` is OR within a string).
3. For each remaining module, evaluate rules sequentially in array order. State mutations within a rule are visible to the next rule.
4. **Short-circuit (default true):** first `deny` or `escalate` wins immediately, skips the rest.
5. **Context accumulation:** all `context` messages collected, joined with `\n\n`.
6. State is flushed after evaluation (even on short-circuit).
7. If no rule returned a non-null decision → `null`.

Module/rule ordering is array order — deterministic API contract.

shell-ast caching: `parse()` is called once per invocation for Bash events; all command rules share the AST. Per-invocation only, in memory.

Rule errors: `rule.evaluate()` throwing is caught and treated as `null`. Logged to stderr. Iron Law 3.

### Protocol Adapters

```typescript
interface ProtocolAdapter {
  readInput(): Promise<HookEvent>;
  writeOutput(decision: Decision, event: HookEvent): never;
  handleError(error: unknown): never;  // exit 0, never crash
}
```

The compiled binary's entry point is `run(modules, adapter, opts)`. The build CLI generates this for binary mode; library consumers can call it directly.

```typescript
// Generated entrypoint:
import { run } from "@questi0nm4rk/hook-kit";
import { claudeCodeAdapter } from "@questi0nm4rk/hook-kit/adapters/claude-code";
import modules from "./hooks";
run(modules, claudeCodeAdapter);
```

**Claude Code adapter mapping:**

| Decision | PreToolUse | PostToolUse | SessionStart / Stop |
|----------|-----------|-------------|---------------------|
| `null` | exit 0, no stdout | exit 0, no stdout | exit 0, no stdout |
| `deny` | `{hookSpecificOutput:{permissionDecision:"block",permissionDecisionReason}}` | stderr + exit 2 | stderr + exit 2 |
| `context` | `{hookSpecificOutput:{additionalContext}}` | `{hookSpecificOutput:{additionalContext}}` | `{hookSpecificOutput:{additionalContext}}` |
| `escalate` | Resolved via askpass → maps to allow (silent) or deny | Resolved via askpass → maps to allow (silent) or deny | Resolved via askpass → maps to allow (silent) or deny |

`escalate` is never written to stdout as-is. The adapter spawns the askpass, waits for a decision (or timeout), then writes the resolved allow/deny per the table. Empty stdin → `handleError` → exit 0. Malformed JSON → exit 0. Never hang.

### State Management

```typescript
interface StateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  flush(): void | Promise<void>;
}
```

**tmpdir-store** (default): `join(tmpdir(), "hook-kit-{namespace}-{sessionId}.json")`. Loaded on construction; flushed automatically after `evaluate()`. No locking — assumes sequential single-agent invocations. Disk full → `flush` throws → caught → silent (state lost, hook doesn't block).

**memory-store**: in-memory `Map`, no persistence. For tests and stateless hooks.

Custom stores implement `StateStore` (e.g., SQLite for shared cross-session state).

### Escalation

The escalation system handles `Decision.kind === "escalate"`. It is the only path where a hook binary blocks waiting for an external decision. Per Iron Law 7, the hook publishes a request and waits; any registered listener can answer.

#### Askpass Contract

When the engine returns `escalate`, the adapter:

1. Constructs an envelope: `{id, sessionId, parentSessionId?, toolName, toolInput, reason, label, createdAt, expiresAt}`.
2. Spawns the binary at `$HOOK_KIT_ASKPASS` with the envelope as JSON on stdin.
3. Waits for the askpass to exit:
   - Exit 0 + JSON `{decision: "allow", reason?}` on stdout → engine emits silent allow.
   - Exit 0 + JSON `{decision: "deny", reason?}` on stdout → engine emits `deny`.
   - Exit 0 + JSON `{decision: "harness-ask", reason?}` on stdout → adapter delegates to the harness's native human-UI prompt (see User-UI Tier).
   - Exit non-zero or unparseable stdout → treated as deny with a reason.
   - Wallclock 60s expires → kill the askpass child, emit deny with reason `[hook-kit] no decision in 60s`.

If `$HOOK_KIT_ASKPASS` is unset or points to a missing/non-executable file → emit deny with reason `[hook-kit] escalation infrastructure unavailable`. This is the explicit exception to fail-open: an `escalate` decision with no responder cannot silently allow.

The askpass binary is the **public contract**. Any program that reads JSON on stdin, writes a decision to stdout, and exits within 60s is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, a desktop notification helper, a phone push relay.

#### Default Broker

The bundled `hook-kit broker` is the default askpass implementation. It manages per-session ask channels and exposes a CLI for listeners.

```
~/.cache/hook-kit/sessions/$SESSION_ID/
├── meta.json                   # {parent_session_id?, started_at, pid}
├── pending/$REQUEST_ID.json    # the envelope
├── decided/$REQUEST_ID.json    # the decision
└── audit.jsonl                 # append-only log of all events
```

Discovery: `meta.json`'s `parent_session_id` lets a process enumerate its descendant sessions. Set automatically from `$HOOK_KIT_PARENT_SESSION_ID` (env var) or by walking process lineage. Each session/subagent gets its own ask channel — no global mixed queue.

When invoked as askpass (`hook-kit broker --askpass`), it:

1. Reads the envelope from stdin.
2. Atomically writes `pending/$REQUEST_ID.json` (`O_EXCL`).
3. Waits via inotify on `decided/$REQUEST_ID.json` (poll fallback at 100ms on systems without inotify).
4. On match → reads decision, deletes both files, appends to `audit.jsonl`, writes decision to stdout, exits 0.
5. On 60s timeout → atomically writes `decided/$REQUEST_ID.json` itself with deny payload, then proceeds as in step 4.

Directory permissions: `0700` on the session directory. Owner-only access; no tokens.

#### Listener CLIs

```
hook-kit list [--children-of $SESSION_ID]
  # Enumerate active session ask channels (filtered by parent if requested).
  # JSON output: [{session_id, parent_session_id, started_at, pid, pending_count}, ...]

hook-kit watch [--session $SESSION_ID]
  # TTY interactive listener. Prints pending requests, prompts y/n + reason.
  # Without --session, watches all owned sessions.

hook-kit subscribe [--session $SESSION_ID] [--children-of $PARENT_ID] --json
  # JSON-lines stream of pending events. For programmatic listeners (agents, bridges).

hook-kit decide $REQUEST_ID --allow|--deny [--reason "<text>"]
  # Submit a decision. Atomic — first writer wins, late submissions logged but unused.
```

The parent agent supervises subagents by combining `list` + `subscribe`:

```
# In the parent agent's loop:
hook-kit list --children-of $MY_SESSION_ID --json     # discover active subagent channels
hook-kit subscribe --children-of $MY_SESSION_ID --json # stream all subagent escalations
hook-kit decide $REQUEST_ID --allow --reason "in scope"
```

#### User-UI Tier and Indefinite Wait

The 60s timeout governs the askpass→broker tier (machine responders, agent listeners). Once a request reaches a human-UI listener, the timeout is removed:

- **Native harness ask:** when no machine responder claims a request and a human-UI tier is configured, the askpass exits with `{decision: "harness-ask"}`. The CC adapter then writes `permissionDecision: "ask"` to CC's stdout and exits — letting CC's native ask UI block indefinitely. Human response unblocks the whole chain.
- **TTY watcher (`hook-kit watch`):** blocks at the prompt forever; no timer.
- **Desktop / phone bridges:** implementation-defined; the broker doesn't enforce a timeout once the request is handed off to a human UI.

The build CLI bumps the hook timeout in generated `hooks.json` to 65s for any hook whose modules contain `escalate` rules (60s askpass deadline + 5s slack). For `harness-ask`, CC's native timeout governs; hook-kit no longer holds the connection.

#### Multi-Listener Race

Multiple listeners can subscribe to the same session simultaneously. First decision wins (atomic file rename guarantees this). Late decisions are dropped silently — `audit.jsonl` records they were submitted but unused.

#### Recursion Safety

When the parent agent is the listener and its own decision-time tool calls trigger more `escalate` rules, naive routing would deadlock (parent waiting on a decision it can only make by triggering itself). The broker tags each subscriber connection and records `originated_by: <subscriber_id>` on requests it routes to that subscriber. When a request would route back to its originator, the broker skips that subscriber and falls through to the next listener (typically the user-UI tier).

#### MCP Elicitation Compatibility

The envelope JSON Schema is shaped to match Model Context Protocol elicitation requests. A future MCP-aware listener can subscribe and respond using the MCP elicitation contract directly — no translation layer required.

### Build CLI

```
hook-kit build <entrypoint> --out <path> --adapter claude-code [--plugins-dir <path>]
hook-kit broker [--askpass]
hook-kit watch [--session <id>]
hook-kit subscribe [--session <id>] [--children-of <id>] --json
hook-kit decide <request_id> --allow|--deny [--reason <text>]
hook-kit list [--children-of <id>] [--json]
```

`build`:

1. Generates a thin entrypoint wrapping the user's modules + adapter.
2. Runs `bun build <entrypoint> --compile --bytecode --outfile <out>`.
3. Generates `hooks.json` from module metadata (events, matchers). Hook timeouts are bumped to 65s for hooks containing `escalate` rules; default 5s otherwise.

`--plugins-dir`: at runtime the binary scans the directory for `.ts` files exporting a default `HookModule`. Loaded modules append to the compiled set. ~5ms per file (dynamic import).

Generated `hooks.json` (CC):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hooks","timeout":65}] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Write|Edit", "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hooks","timeout":65}] }
    ]
  }
}
```

## Consumption Modes

### Binary Mode

Each plugin compiles its own binary:

```
my-plugin/
├── src/hooks.ts              # createModule() + rules
├── dist/hooks                # compiled binary (committed)
├── hooks/hooks.json          # CC adapter config (generated)
└── package.json              # depends on @questi0nm4rk/hook-kit
```

Build: `hook-kit build src/hooks.ts --out dist/hooks --adapter claude-code`

```typescript
// src/hooks.ts
import { createModule, cmd, path } from "@questi0nm4rk/hook-kit";

export default [
  createModule({
    id: "block-raw-review-api",
    name: "Block raw review API",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  }, [
    cmd("gh", "pr", "comment").deny("Use pr-review reply instead"),
    cmd("gh", "api", "graphql").withFlag("--field")
      .deny("Use pr-review threads/resolve/reply/dismiss"),
    cmd("gh", "api").argMatches(/\/pulls\/\d+\/reviews(?!\/)/)
      .deny("Use pr-review status"),
  ]),
  createModule({
    id: "protect-generated",
    name: "Protect generated files",
    events: ["PreToolUse"],
    matchers: ["Edit", "Write"],
  }, [
    path(/\.g\.cs$/).onWrite().deny("Edit the generator, not the output"),
    path(/[/\\](obj|bin)[/\\]/).onWrite().deny("Build artifact, not source"),
  ]),
];
```

### Library Mode

Import the engine and builders directly. Skip the build CLI; bring your own adapter and config layer:

```typescript
import { evaluate, createModule, cmd } from "@questi0nm4rk/hook-kit";

const modules = buildModulesFromConfig(myConfig);
const decision = await evaluate(hookEvent, modules);
// Map decision to your own output format.
```

## Tool Plugin Pattern

A tool plugin (e.g., `qsm-github`, `qsm-spec`) consumes hook-kit to ship a single binary that enforces all of that tool's rules. One binary per tool, not one per rule — startup cost amortizes across rules.

```
tools/qsm-github/
├── src/main.ts            # createModule() + rules
├── rules/
│   ├── enforce-review-format.ts
│   └── block-raw-graphql.ts
├── bin/qsm-github         # compiled binary
├── hooks/hooks.json       # CC adapter
└── package.json
```

The binary is the stable contract. `hooks.json` is harness-specific glue; future harnesses replace `hooks.json` with their own adapter without touching the binary.

Empty `matcher` in `hooks.json` is allowed — the binary handles its own routing internally based on `event.toolName`. Keeps the harness adapter minimal (one entry).

## Testing

| Surface | Test approach |
|---------|--------------|
| Builders | Unit per builder × edge cases (flag matching, regex, empty args, unknown commands → silent) |
| Engine | Short-circuit, context accumulation, module filtering, ordering, error handling |
| Adapters | CC JSON shape per decision per event; empty/malformed stdin |
| State stores | get/set/has/delete/flush, missing file, disk full, corruption |
| Escalation | askpass spawn, stdin/stdout protocol, 60s timeout, missing askpass denies, broker spool atomicity, listener CLIs, recursion safety, harness-ask delegation |
| Integration | Pipe JSON → compiled binary → validate stdout |
| Performance | Compiled binary cold start < 50ms via `time echo '{}' \| ./dist/hooks` |

## Operational Readiness

- **Observability:** `--verbose` flag on the compiled binary logs to stderr — modules evaluated, rules matched, final decision, timing. Each decision can carry a `label` for source attribution. State and ask channels are inspectable: `cat ~/.cache/hook-kit/sessions/$SESSION_ID/audit.jsonl`.
- **Failure modes:**
  - shell-ast WASM fails to load → all command rules return `null` (silent), stderr warning.
  - tmpdir/cache write fails → state lost, hook returns `null` (silent).
  - Rule throws → caught, treated as `null` (silent), logged.
  - Stdin empty/malformed → adapter exits 0 (silent).
  - Escalation infrastructure broken → deny with reason (explicit exception to Iron Law 3).
- **Deployment:** Compiled binary committed under the plugin (e.g., `dist/hooks`). `hooks.json` points to `${CLAUDE_PLUGIN_ROOT}/dist/hooks`. CI rebuilds on push. Plugin pins to `^major.minor` of hook-kit.
- **Rollback:** Delete the compiled binary; restore the previous version from git. Per-plugin binaries mean one broken plugin doesn't affect others.

## DON'Ts

- Don't put domain knowledge in tool binaries. Tools enforce, knowledge belongs elsewhere.
- Don't add rules that depend on which other plugins are active. Tool rules are unconditional.
- Don't output `allow` decisions. Silent exit = allowed. Only `deny`/`context`/`escalate` produce output.
- Don't catch errors and deny. Catch errors and stay silent (fail open) — except for `escalate` infrastructure failures, which deny explicitly.
- Don't put multiple tools in one binary. One binary per tool keeps release cycles independent.
- Don't write tool-call results to stdout from your hook. stdout is the decision channel; use stderr for diagnostics.
- Don't bypass the askpass contract. If you need synchronous human-in-the-loop, write an askpass binary; don't reach into the broker spool directly.

## Key Trade-offs

| Chose | Over | Because |
|-------|------|---------|
| Per-plugin binaries | One monolithic binary | Plugin isolation; independent release cycles. |
| Variadic `cmd(command, ...sub)` | Named or array sub | Most natural TypeScript API; covers single-level and multi-level subcommands. |
| tmpdir/cache JSON state | SQLite or memory-only | Simplest persistence that survives within a session. |
| Fail open on infra errors | Fail closed | Hook framework bugs must not block developers. Security-critical rules belong in the harness's own deny list. |
| Harness-agnostic core | CC-only | Adapter layer is ~50 lines; rewriting rules per harness is expensive. |
| Rules as objects with `evaluate()` | Plain data | Supports custom/stateful/content uniformly through one interface. |
| Direct shell-ast dep | Peer dep | WASM bundling is reliable; consumers don't see the dep. |
| Edit treated as Write for path rules | Separate `.onEdit()` | Edit is Write-adjacent — file mutation is what matters. |
| Sequential rule evaluation | Parallel | State mutations visible to next rule; no race conditions. |
| Blacklist semantics | Whitelist | Matches harness behavior. One block wins regardless of others. |
| `escalate` resolved via askpass + broker | Pass-through to harness `ask` | Multi-listener support (machine responders, bridges, parent agent) without per-harness UI dependency. Falls back to harness `ask` for the human-UI tier. |
| Per-session ask channels | One global queue | Avoids cross-session noise when multiple sessions × subagents are active. Discovery via `meta.json` parent links. |
| 60s machine timeout, indefinite human timeout | Single timeout | Machine responders should be deterministic; humans need slack. |
| Filesystem spool inside the broker | Socket-only or HTTP | Inspectable, crash-safe, atomic via `rename(2)`, no daemon strictly required. Listeners may also stream over a socket when broker runs as a daemon. |
| Askpass as the public escalation contract | A dedicated socket protocol | Decades of prior art (sudo, ssh, git, gpg). Any binary can be a responder. |
