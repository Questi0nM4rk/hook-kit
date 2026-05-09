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
7. **Escalation is async, tree-shaped, out-of-band.** Escalation requests publish to per-session ask channels and propagate up a parent_session_id tree whose root is the harness's native human-UI prompt. Any registered listener (TTY, parent agent, bridge, harness UI) can answer through the same `askpass` contract; listeners that don't want to decide forward up via `escalate-up`. The hook binary blocks waiting for a decision but does not own the decision logic. A `NO PARENT ATTACHED` validator denies escalates immediately when no listener is reachable anywhere in the chain — escalate never silently hangs.

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
│   │   ├── envelope.ts           # JSON Schema for ask requests/decisions
│   │   ├── forward.ts            # escalate-up forwarder (one hop sync)
│   │   └── listeners.ts          # Listener markers + parent-chain walk
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

`escalate` is never written to stdout as-is. The adapter spawns the askpass and waits for a decision (no internal timeout — CC's hook timeout is the ceiling). Empty stdin → `handleError` → exit 0. Malformed JSON → exit 0.

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

The escalation system handles `Decision.kind === "escalate"`. It is the only path where a hook binary blocks waiting for an external decision. Per Iron Law 7, the hook publishes a request and waits; any registered listener up the parent chain can answer through the same askpass contract.

#### Tree Model

Each running hook-kit invocation is a node in a tree. The root is the harness's native human-UI prompt (CC's `permissionDecision: "ask"`). Below the root sits the agent's own session. Below that, any subagent the parent spawned has its own session whose `meta.json.parent_session_id` points up to the parent. Subagents can spawn their own subagents, recursively.

```
[ root: harness UI (CC native ask) ]
            │
[ agent session ]
        ├── [ subagent session A ]
        │       └── [ sub-subagent session ]
        └── [ subagent session B ]
```

When a hook escalates, the request is published at the hook's own session spool. A listener attached to that spool — typically the parent agent watching `--children-of $MY_SESSION_ID` — sees the request and decides. If that listener doesn't want to decide, it forwards (`decide --escalate-up`), which republishes the same envelope at the grandparent's spool. The chain continues up. When the chain exhausts (no parent), the forwarder writes a `harness-ask` decision into the source's spool, which the CC adapter renders as CC's native `ask` UI — the implicit root parent. Decisions cascade back down: each forwarding hop copies the answer from the level above into the level below.

Multiple listeners can attach to any node simultaneously. They all see the same pending request. First-writer-wins on `decided/<id>.json` (atomic `O_EXCL`) gives a free input queue: whoever responds first becomes the canonical answer; late submissions log to `audit.jsonl` and lose silently.

#### Askpass Contract

When the engine returns `escalate`, the adapter:

1. Constructs an envelope (PROTOCOL_VERSION = 2):
   ```
   {
     version, id,
     sessionId, parentSessionId?,
     pid, host, user,                       // autofilled by createAskRequest
     harness: { name, version? },           // supplied by adapter (e.g. claude-code)
     toolName, toolInput,
     reason, label?,
     cwd, transcriptPath,                   // forwarded from HookEvent
     git?: { sha, branch?, dirty?, remote? }, // opt-in via HOOK_KIT_ENRICH_GIT=1
     createdAt, expiresAt
   }
   ```
   The intent is to give a listener enough context — harness identity, project / cwd, branch + dirty state, transcript pointer, originating pid — to decide an ambiguous ask without round-tripping. `cwd`, `transcriptPath`, and `harness` come from the adapter; `pid`/`host`/`user` are autofilled. `git` is populated only when `HOOK_KIT_ENRICH_GIT=1` is set in the binary's environment (cheap shell-outs against `git -C cwd`); failures swallow to undefined per Iron Law 3.
2. Spawns the binary at `$HOOK_KIT_ASKPASS` with the envelope as JSON on stdin.
3. Waits for the askpass to exit (no internal timeout by default — the harness's hook timeout is the ceiling):
   - Exit 0 + JSON `{decision: "allow", reason?}` on stdout → engine emits silent allow.
   - Exit 0 + JSON `{decision: "deny", reason?}` on stdout → engine emits `deny`.
   - Exit 0 + JSON `{decision: "harness-ask", reason?}` on stdout → adapter delegates to the harness's native human-UI prompt (see User-UI Tier).
   - Exit non-zero or unparseable stdout → treated as deny with a reason.

`expiresAt` is computed from a TTL (default 60s) and stays in the envelope as **metadata only**. Listeners and observability layers may use it (audit logs, "raised X minutes ago" hints, MCP elicitation conformance), but neither the broker nor `callAskpass` enforce it as a deadline by default. Custom askpass binaries that callers don't trust to terminate can opt in by passing `timeoutMs` to `callAskpass`.

**`$HOOK_KIT_ASKPASS` unset** → no broker infrastructure configured; the adapter delegates directly to the harness's UI tier via `harness-ask`. The CC adapter renders this as `permissionDecision: "ask"`. This is not silent-allow — the harness UI is itself a responder. Use this when you don't want the broker tree (e.g. simple "ask the human" hooks).

**`$HOOK_KIT_ASKPASS` set but binary missing / non-executable / exits non-zero / returns malformed output** → emit deny with reason `[hook-kit] askpass …`. This is the Iron Law 3 exception: when broker infra was *expected* but is broken, fail closed — never silent-allow.

The askpass binary is the **public contract**. Any program that reads JSON on stdin, writes a decision to stdout, and exits is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, a desktop notification helper, a phone push relay, the bundled `hook-kit broker`.

#### Default Broker

The bundled `hook-kit broker` is the default askpass implementation. It manages per-session ask channels and exposes a CLI for listeners.

```
~/.cache/hook-kit/sessions/$SESSION_ID/
├── meta.json                   # {parent_session_id?, started_at, pid}
├── pending/$REQUEST_ID.json    # the envelope
├── decided/$REQUEST_ID.json    # the decision (first-writer-wins)
├── listeners/$PID.lock         # liveness markers — one per attached listener
└── audit.jsonl                 # append-only log of all events
```

Discovery: `meta.json`'s `parent_session_id` lets a process enumerate its descendant sessions. Set automatically from `$HOOK_KIT_PARENT_SESSION_ID` (env var) or by walking process lineage. Each session gets its own ask channel — no global mixed queue.

When invoked as askpass (`hook-kit broker --askpass`), it:

1. Reads the envelope from stdin.
2. **Validates: NO PARENT ATTACHED check.** Walks the parent chain via `meta.json` (cycle-safe via a visited set). At each level, scans `<session>/listeners/` for live markers (`kill(pid, 0)` liveness probe, stale markers pruned). If zero live listeners exist anywhere in the chain → returns a deny with reason `[hook-kit] NO PARENT ATTACHED`. The original `escalate` reason is preserved in the deny.
3. Atomically writes `pending/$REQUEST_ID.json` (`O_EXCL`).
4. Polls `decided/$REQUEST_ID.json` (default 100ms). **No internal timeout** — the broker waits until either a decision lands or its process is killed externally (CC's hooks.json timeout being the practical ceiling).
5. On match → reads decision, deletes both files, appends to `audit.jsonl`, writes decision to stdout, exits 0.

Directory permissions: `0700` on the session directory. Owner-only access; no tokens.

The validator only fires for escalate paths (the broker is the askpass for escalate). Non-escalate decisions never reach the broker — `cmd("rm").deny("blocked")` works without any listener attached.

#### Listener CLIs

```
hook-kit list [--children-of $SESSION_ID] [--json]
  # Enumerate active session ask channels (filtered by parent if requested).
  # JSON output: [{session_id, parent_session_id, started_at, pid, pending_count}, ...]

hook-kit watch [--session $SESSION_ID] [--children-of $PARENT_ID] [--poll-ms <n>]
  # TTY listener. Prints pending requests as they arrive. Pair with
  # `hook-kit decide` from another shell to submit answers. Registers a
  # listener marker on attach, removes on SIGINT/SIGTERM.

hook-kit subscribe [--session $SESSION_ID] [--children-of $PARENT_ID]
                   [--poll-ms <n>] --json
  # JSON-lines stream of pending events for programmatic listeners
  # (agents, bridges). Same listener-marker lifecycle as watch.

hook-kit decide $REQUEST_ID --session <id>
                --allow | --deny | --escalate-up
                [--reason "<text>"] [--by <name>]
  # Submit a decision atomically. --escalate-up forwards the request to the
  # parent session's spool and waits there until the parent's listener
  # decides; the answer is copied back down to the source. If no parent
  # exists, the chain terminates at harness-ask.
```

The parent agent supervises subagents by combining `list` + `subscribe`:

```
# In the parent agent's loop:
hook-kit list --children-of $MY_SESSION_ID --json     # discover active subagent channels
hook-kit subscribe --children-of $MY_SESSION_ID --json # stream all subagent escalations
hook-kit decide $REQUEST_ID --session $CHILD_SESSION --allow --reason "in scope"
```

#### Forwarding (`escalate-up`)

A listener that doesn't want to decide a question can punt it up the tree. `hook-kit decide --escalate-up` does one hop synchronously:

1. Reads the source session's `pending/$REQUEST_ID.json`.
2. Looks up `parent_session_id` from `meta.json`.
3. **No parent →** writes a `harness-ask` decision into the source's `decided/$REQUEST_ID.json`. The hook adapter sees harness-ask and emits CC's native ask UI. Chain terminates here.
4. **Parent exists →** atomically writes the envelope (with a `forwarded_from: <source>` field added) to `parent/pending/$REQUEST_ID.json`, then polls `parent/decided/$REQUEST_ID.json`. When the parent's decision lands, copies it down to the source's `decided/$REQUEST_ID.json` so the original hook unblocks.

Multi-hop chains compose by recursion: each level's listener can independently `--escalate-up`. The forwarder is synchronous (no daemon, no event watcher), bounded by the original hook process's lifetime — when CC's hook timeout kills the hook, every blocked forwarder up the chain unblocks too.

There is no per-hop timeout by default. A test or specialized caller can pass `timeoutMs` to the underlying `forwardUp()` function for bounded waits.

#### User-UI Tier (the harness as root)

CC's native ask UI is the implicit root parent. It always exists when the binary runs under CC for PreToolUse events, and it has no timeout — humans can take as long as they need. Two paths reach it:

- **`escalate-up` chain end:** the forwarder writes a harness-ask decision when it walks off the top of the parent chain.
- **A listener explicitly returns `harness-ask`:** for cases where the listener is policy code that knows "this needs a human, kick it to CC."

For non-PreToolUse events (PostToolUse / Stop / SessionStart) where CC has no native ask UI, the adapter degrades harness-ask to an `additionalContext` informational message — the action has already happened, so there's nothing to gate.

#### Multi-Listener Race / Input Queue

Multiple listeners can attach to the same session simultaneously. They all see the same `pending/<id>.json`. When any of them submits a decision via `submitDecision` or `hook-kit decide`, the call uses atomic `O_EXCL` write — first writer succeeds, later writers return `false` and their decisions log to `audit.jsonl` but never reach the requester. This gives a free input queue suitable for the rare case where multiple bridges (Slack + phone + TTY) race; the design isn't optimized for concurrent answers but stays correct if they happen.

#### Hook Timeout (CC-side)

`hook-kit` does not enforce a timeout on its own. The only ceiling is CC's `hooks.json` per-hook timeout. The build CLI **requires** `--hook-timeout <seconds>` when emitting `hooks.json` — there is no default. Pick deliberately:

- Short (e.g., `5`) — plugins without escalate rules.
- Long (e.g., `3600`) — plugins where escalate may need a human to think.

If CC kills the hook process before a decision lands, the adapter returns deny via the killed-process exit. The `pending/<id>.json` and any forwarded copies up the chain remain on disk; a late listener answer is wasted but harmless.

#### MCP Elicitation Compatibility

The envelope JSON Schema is shaped to match Model Context Protocol elicitation requests. A future MCP-aware listener can subscribe and respond using the MCP elicitation contract directly — no translation layer required.

### Build CLI

```
hook-kit build <entrypoint> --out <path> --adapter claude-code
                            [--hooks-json <path>] [--binary-command <s>]
                            [--hook-timeout <seconds>] [--plugins-dir <path>]
hook-kit broker --askpass
hook-kit watch [--session <id>] [--children-of <id>] [--poll-ms <n>]
hook-kit subscribe [--session <id>] [--children-of <id>] [--poll-ms <n>] --json
hook-kit decide <request_id> --session <id>
                --allow | --deny | --escalate-up
                [--reason <text>] [--by <name>]
hook-kit list [--children-of <id>] [--json]
```

`build`:

1. Generates a thin entrypoint wrapping the user's modules + adapter.
2. Runs `bun build <entrypoint> --compile --bytecode --outfile <out>`.
3. Generates `hooks.json` from module metadata (events, matchers) when `--hooks-json <path>` is set. **`--hook-timeout <seconds>` is required** in this mode — no default. Pick short (e.g. `5`) for plugins without escalate rules, or long (e.g. `3600`) when escalate may need a human in the loop. hook-kit doesn't enforce its own timeout on escalate; this CC-side timeout is the only ceiling.

`--plugins-dir`: at runtime the binary scans the directory for `.ts` files exporting a default `HookModule`. Loaded modules append to the compiled set. ~5ms per file (dynamic import).

Generated `hooks.json` (CC) — example with `--hook-timeout 3600` for an escalate-bearing plugin:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hooks","timeout":3600}] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Write|Edit", "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hooks","timeout":3600}] }
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
| Escalation | askpass spawn + stdin/stdout protocol, missing askpass denies, broker spool atomicity, listener marker liveness, NO PARENT ATTACHED validator, listener CLIs, escalate-up forward (single + multi-hop), harness-ask delegation, opt-in timeouts |
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
- Don't expect `expiresAt` to be enforced by anything in hook-kit. It's metadata for audit/observability/MCP conformance only — listeners that want a hard deadline must enforce it themselves.
- Don't ship a plugin with escalate rules without an attached listener somewhere in the chain (or CC's native ask UI as the root). The `NO PARENT ATTACHED` validator will deny every escalate at runtime — the agent will see deny errors instead of seeing the question.

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
| Tree-shaped escalation with `escalate-up` forward | Auto-routing in the broker | Listeners explicitly choose to forward, matching the user's mental model ("agent receives the question, decides whether to handle or punt up"). Synchronous forwarder, no daemon, audit trail per hop. |
| Listener markers (`<session>/listeners/<pid>.lock`) | Implicit liveness via inotify on connections | File-based markers compose with the rest of the spool, survive process restarts of inspectors, and are pid-liveness-checkable from any tool. |
| **NO PARENT ATTACHED validator** denies escalate when no listener anywhere in chain | Silent hang or auto-allow | Hook timeouts can hide misconfigured plugins for minutes. The validator surfaces "you forgot to attach a listener" immediately. Non-escalate decisions are unaffected. |
| No default `--hook-timeout` (required when `--hooks-json` set) | Sensible default like 65s or 3600s | Either default has a wrong tail. Forcing the plugin author to pick makes the trade-off explicit at build time. hook-kit doesn't enforce its own timeout on escalate; this is the only ceiling. |
| `expiresAt` is metadata-only | Enforced deadline | Humans take variable time on hard questions; auto-deny on a fixed timer doesn't match the actual UX. Fields preserved for audit / observability / MCP elicitation conformance. |
| Filesystem spool inside the broker | Socket-only or HTTP | Inspectable, crash-safe, atomic via `rename(2)`, no daemon strictly required. Listeners may also stream over a socket when broker runs as a daemon. |
| Askpass as the public escalation contract | A dedicated socket protocol | Decades of prior art (sudo, ssh, git, gpg). Any binary can be a responder. |
