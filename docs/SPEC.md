# hook-kit

Build agent-agnostic shell-wrapper hook binaries. Real shell-AST parsing, output via stdout/stderr/exit-code, no JSON wire protocol with the caller, no harness coupling. Optional adapter bins extend coverage to harness tool-call channels (Claude Code's `Edit` / `Write` / `Read`, etc.) for the cases that bypass the shell.

## Problem

Some commands shouldn't run. `rm -rf /`, `git push --force`, `curl … | bash`, edits to `.env`, hooks bypassed via `git commit -n` — every team has its own list. Today the gating logic gets duplicated everywhere it's needed: agent-side hooks (CC's `hooks.json`), shell aliases, `.bashrc` traps, CI lint scripts, pre-commit hooks. Each layer reinvents shell-AST parsing, decision serialization, and an output convention.

hook-kit ships one primitive: a shell wrapper that parses commands with shell-AST, runs declarative rules against them, and surfaces a decision through normal shell I/O. **The caller doesn't have to know it exists.** Agent, human, CI, cron — they all see the same thing: the command's own output if approved, a `[hook-kit]` marker on stdout/stderr if not.

## Ideology

1. **Agent-agnostic by default.** hook-kit doesn't know or care who is running the shell. No hook-system integration, no harness JSON protocol, no per-harness adapter. Just shell in, shell out.
2. **The shell is the contract.** Decisions surface through stdout / stderr / exit code — the same channel the caller already reads for everything else. No JSON, no env vars, no special parsing required to consume a decision.
3. **shell-AST is the parser.** Real parsing, not regex. `bash -c "rm -rf /"` recurses; `cmd1 | cmd2` is a BinaryCmd node, not a substring; `> /etc/passwd` is a Stmt redir, not a `>` pattern.
4. **Adapter bins are extensions, not the default.** A harness with non-shell tool channels (CC's `Edit`/`Write`/`NotebookEdit`/`Read`) can build a separate companion binary that handles those events. The shell wrapper stays the primary gate; the adapter is opt-in additional coverage.
5. **Fail open on infra errors, fail closed on broken ask.** Framework bugs must not block users. Exception: if a rule explicitly returns `ask` and no askpass / harness UI is reachable to answer, deny — never silent-allow.

## Iron Laws

1. **Rules are data, not scripts.** Declarative builders (`cmd`, `path`, `content`, `pipe`, `redirect`, `custom`, `stateful`), never raw shell. Testable without process spawning, composable across modules, inspectable for reporting.
2. **Parse once, evaluate many.** shell-AST WASM init is expensive (~200ms first call). The AST is parsed once per invocation and reused across all command/pipe/redirect rules.
3. **Recurse into inline shells.** `bash -c "…"` / `sh -c "…"` / `eval "…"` / `exec "…"` are re-evaluated against the same modules. Without this, every rule has a 1-line bypass.
4. **Fail open on infrastructure errors.** State-store disk full, JSON parse error, rule throws — caught, treated as silent. Hook-kit never blocks a user because of its own bugs. Exception: `ask` with no responder and no harness UI to fall back to denies with a reason.
5. **Blacklist semantics.** There is no `allow` decision. A hook either blocks (deny) / asks / annotates (warning, note) — or stays silent. Silent = nothing was wrong.
6. **Output convention is the wire format.** stdout for needs-review (ask) and annotations (warning, note), stderr for errors (deny), exit code carries success/failure. No caller needs a JSON parser to consume an outcome.
7. **Each plugin compiles its own binary.** Plugin isolation. One plugin can iterate without affecting the others. ~50 MB per binary; sub-50 ms cold start.
8. **Escalation is async, tree-shaped, out-of-band.** Escalation requests publish to per-session ask channels and propagate up a `parent_session_id` tree. Any registered listener (TTY, parent agent, bridge) can answer through the same `askpass` contract; listeners that don't want to decide forward up via `escalate-up`. When the chain exhausts at the root, `harness-ask` delegates to whatever native UI the harness has (or, with `HOOK_KIT_ASKPASS` unset, falls through to harness-ask immediately — no broker infra needed for simple "ask the user" hooks).

## Architecture

### Package Layout

```
@questi0nm4rk/hook-kit/
├── src/
│   ├── index.ts                  # Public barrel: types + builders + engine + run() + runShell()
│   ├── version.ts                # VERSION (sourced from package.json at compile time)
│   ├── core/
│   │   ├── types.ts              # Decision, HookEvent, HookModule, Rule, EvalContext
│   │   ├── decision.ts           # deny(), ask(), warning(), note()
│   │   ├── event.ts              # toToolEvent() — typed view of HookEvent
│   │   └── module.ts             # createModule() factory
│   ├── builders/                 # Rule BUILDERS (primitives) — hook-kit ships
│   │   │                         # no pre-built rules; consumers compose their own.
│   │   ├── command.ts            # cmd() — shell-AST based command matching
│   │   ├── path.ts               # path() — file path patterns (Edit/Write/Read events)
│   │   ├── pipe.ts               # pipe(from, into) — `cmd1 | cmd2` detection
│   │   ├── redirect.ts           # redirect(pathPattern?) — shell write-redirect detection
│   │   ├── content.ts            # content() — PostToolUse body inspection
│   │   ├── custom.ts             # custom() — arbitrary predicates
│   │   └── state.ts              # stateful() — cross-invocation state
│   ├── engine/
│   │   ├── index.ts              # evaluate() — core loop + inline-shell recursion
│   │   └── helpers.ts            # Flag aliases, inline-shell extraction
│   ├── wrapper/
│   │   └── hk.ts                 # runShell() — the v0.3 default entrypoint
│   ├── adapters/
│   │   ├── types.ts              # ProtocolAdapter interface (for adapter bins)
│   │   ├── claude-code.ts        # CC tool-call adapter (Edit/Write/NotebookEdit/Read)
│   │   └── raw.ts                # Library-mode / testing adapter
│   ├── state/
│   │   ├── types.ts              # StateStore interface
│   │   ├── tmpdir-store.ts       # Default: tmpdir JSON per session
│   │   └── memory-store.ts       # In-memory (testing)
│   ├── escalation/
│   │   ├── askpass.ts            # Spawn HOOK_KIT_ASKPASS, read decision (unset → harness-ask)
│   │   ├── broker.ts             # Default broker — per-session ask channels
│   │   ├── enrich-git.ts         # Opt-in git context for AskRequest envelope
│   │   ├── envelope.ts           # JSON Schema for AskRequest / AskResponse (PROTOCOL_VERSION 2)
│   │   ├── forward.ts            # escalate-up forwarder (one hop sync)
│   │   ├── listeners.ts          # Listener markers + parent-chain walk
│   │   └── watch-tui.ts          # Interactive TUI listener
│   ├── run.ts                    # run(modules, adapter) — adapter-mode entry (cc-tools, library)
│   └── build/
│       ├── cli.ts                # `hook-kit` CLI entry
│       └── bundle.ts             # Generates entrypoint, drives bun build --compile
└── tests/
```

### Core Types

```typescript
// What a single Rule.evaluate() returns.
type Terminal =
  | { kind: "deny";     reason: string;  label?: string }                // hard block
  | { kind: "ask"; reason: string;  label?: string };               // ask up the tree

type Annotation =
  | { kind: "warning";  message: string; label?: string }                // non-blocking, distinct
  | { kind: "note";     message: string; label?: string };               // non-blocking, distinct

type Decision = Terminal | Annotation | null;                            // null = silent

// What the engine returns after merging per-rule decisions across all modules.
interface EvaluationOutcome {
  terminal:    Terminal | null;
  annotations: readonly Annotation[];
}

interface HookEvent {
  eventName: string;       // "PreToolUse" | "PostToolUse" | …
  sessionId: string;
  cwd: string;
  transcriptPath: string;  // empty in shell-wrapper mode
  toolName: string;        // "Bash" in shell-wrapper mode
  toolInput: Record<string, unknown>;
  raw: Record<string, unknown>;
}

interface HookModule {
  id: string;
  name: string;
  events: readonly string[];   // which event names this module fires for
  matchers?: readonly string[]; // which tool names; undefined = all
  rules: readonly Rule[];
  enabled?: boolean;            // default true
}
```

### Rule Builders

```typescript
// cmd(command, ...subcommands) — variadic, args[0..N] match subcommands by position
cmd("gh", "pr", "comment").deny("Use pr-review reply instead");
cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease")
  .deny("Use --force-with-lease, not raw --force");
cmd("git", "checkout").withDdash().ask("git checkout -- discards working tree");
cmd("gh", "api").argMatches(/\/pulls\/\d+\/reviews(?!\/)/)
  .deny("Use pr-review status");
```

Semantics:

- Variadic sub matching checks args by position. CLI convention: subcommands precede flags, so position is reliable.
- **Default basename match (0.6+)**: `cmd("git")` fires on `git`, `/usr/bin/git`, `./bin/git`, `sudo /usr/bin/rm`, `/usr/bin/bash -c "…"`. Dispatch uses shell-ast 0.6's polymorphic `resolvedCmd(u)` in `engine/helpers.ts:unwrappedName`. Opt-out: `.strictPath()` requires exact-path match (`cmd("/usr/bin/git").strictPath()` fires only on that exact invocation).
- `.withFlag("--force")` — required (presence). Flags are expanded via aliases (`-f` → `--force`, `-r` → `--recursive`/`-R`).
- `.withoutFlag("--force-with-lease")` — forbidden (must be absent).
- `.argMatches(/regex/)` — at least one resolved arg matches the pattern. Quoted strings (`"…"`/`'…'`) become `<dynamic>` and never match literal patterns. Use this for unquoted patterns like `event=COMMENT` in `--field event=COMMENT`.
- `.argIncludes("literal")` — exact-string membership in resolved args.
- **`.flagValueMatches(flag, /regex/)` and `.flagValueEquals(flag, value)` (0.6+)**: inspect the VALUE of a flag. Uses shell-ast 0.6's polymorphic `tokensAfter(u, flag)` (dispatches to `u.innerRaw` for `wrapped`, `u.raw` otherwise). Both `=` form (`--output=/etc/passwd`) and space form (`-o /etc/passwd`) captured. Multiple flagValue* predicates stack with AND; repeated occurrences of the same flag use ANY-match (at least one value must satisfy). Dynamic values (`-o $VAR`) skip silently — predicate doesn't see DYNAMIC. Composable with `.custom()` for block-on-uncertainty.
- `.withDdash()` — require the POSIX `--` end-of-options separator. Disambiguates destructive forms like `git checkout -- file` from `git checkout file`.
- `.deny(reason, label?)` — terminal; blocks the command, returns a `Rule`.
- `.ask(reason, label?)` — terminal; routes to askpass / harness UI, returns a `Rule`.
- `.warning(message, label?)` — annotation; non-blocking, surfaces as `[label] warning: <message>` above a `---` separator before the command runs.
- `.note(message, label?)` — annotation; same mechanics as warning, rendered as `[label] note: <message>`. Distinct from warning so the AI can tell severity apart visually.

**Engine-level `shellAstOpts.globalFlags` (0.6+):** `EvaluateOptions.shellAstOpts.globalFlags?: Record<string, readonly string[]>` registers per-tool value-taking flags so commands like `terraform -chdir ./infra apply` resolve `apply` as `args[0]`. Built-in shell-ast table covers `git`/`docker`/`kubectl`/`make`/`tar`/`xargs`; anything else needs registration. Threaded through `RunModuleOptions` / `RunShellOptions` / `RunOptions` (all extend `EvaluateOptions`) into every `unwrapCall(call, opts)` site — both the inline-shell recursion and the `cmd()` builder.

```typescript
// pipe(from, into) — `cmd1 | cmd2` detection via shell-AST BinaryCmd walk
pipe(["curl", "wget"], ["bash", "sh", "zsh"]).deny("RCE via pipe-to-shell");
```

Catches pipes that `cmd()` cannot express. Matches `|` and `|&`.

```typescript
// redirect(pathPattern?) — `cmd > path` detection
redirect(/\.env$/).deny("don't redirect into .env");
redirect().deny("no shell redirects in this context");
```

Matches write-redirect operators (`>`, `>>`, `>|`, `&>`, `&>>`) whose target matches `pathPattern`. With no pattern, matches any write redirect. Closes the bypass where `path()` rules can be sidestepped via `echo evil > /protected/path` in a Bash event.

```typescript
// path(pattern) — file-path matching for Edit/Write/Read tool events
path(/\.generated\.cs$/).onWrite().deny("Edit the generator, not the output");
path(/\.env(\.|$)/).onRead().deny("Don't read environment files");
```

Defaults to both. `.onWrite()` matches `Write`/`Edit`/`NotebookEdit`. `.onRead()` matches `Read`. **Only fires under the cc-tools adapter** — the shell wrapper synthesizes a Bash event, so `path()` rules are inert there. Use `redirect()` for shell-side write protection.

```typescript
// content() — PostToolUse body inspection from disk
content().matchPath(/design\/.*\.md$/).validate((filePath, body) => {
  const missing = REQUIRED_SECTIONS.filter((s) => !s.test(body));
  if (missing.length > 0) return warning(`Missing sections: ${missing.join(", ")}`);
  return null;
});
```

PostToolUse only — file is on disk after the tool ran. Same coverage caveat as `path()`: only fires under cc-tools.

```typescript
// stateful(id, fn) — cross-invocation state via StateStore
stateful("repetition", (event, state) => {
  const hash = sha256(event.toolName + JSON.stringify(event.toolInput));
  const count = (state.get(hash) as number ?? 0) + 1;
  state.set(hash, count);
  if (count > 3) return warning(`This command has run ${count}× — break the loop`);
  return null;
});

// custom(id, fn) — escape hatch
custom("session-summary", async (event) => {
  // arbitrary logic; throw → caught → silent (Iron Law 4)
  return null;
});
```

### Engine

```typescript
async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts?: { state?: StateStore; recurseInlineShells?: boolean },
): Promise<EvaluationOutcome>;
```

Flow:

1. Filter modules by `events` (must include `event.eventName`).
2. Filter modules by `matchers` (if present, at least one matches `event.toolName`; `|` is OR within a string).
3. For each remaining module, evaluate rules sequentially in array order. State mutations within a rule are visible to the next rule.
4. **Merge policy** (deterministic — no `shortCircuit` knob):
   - `deny` → terminate immediately. `outcome.terminal = deny`, `annotations = []` (DROPPED). The command will not run, so annotations about it are noise.
   - `ask` → record as terminal candidate but KEEP evaluating so annotations can still accumulate. First ask wins; later asks dropped.
   - `warning` / `note` → always append to `outcome.annotations` in encounter order.
5. **Inline-shell recursion (default on):** after the main pass, if no `deny` and the event is Bash, the engine walks the AST for `bash -c "…"` / `sh -c …` / `eval …` / `ksh -c …` etc. (shell-ast `kind: "wrapped-script"`) and re-evaluates the modules against the inner script. Depth-limited to 5; exceeding the limit returns an `ask` ("inspection depth"). Inner annotations bubble up into the outer outcome; inner `deny` short-circuits the whole evaluation. Set `recurseInlineShells: false` to disable for tests where recursion changes the asserted outcome.
6. State is flushed after evaluation (including on short-circuit).
7. If no rule returned a non-null decision → `{ terminal: null, annotations: [] }`.

shell-AST caching: `parse()` is called once per invocation for Bash events; all command/pipe/redirect rules share the AST.

Rule errors: `rule.evaluate()` throwing is caught and treated as `null`. Iron Law 4.

### Shell Wrapper (the `hk` binary — v0.3 default)

The compiled-binary entry point in v0.3. Substitutes for `bash -c "<cmd>"`. Agent-agnostic — knows nothing about hooks.json, harness JSON, or who's calling.

```typescript
import { runShell } from "@questi0nm4rk/hook-kit/wrapper/hk";
import modules from "./hooks";
runShell(modules);
```

The compiled binary accepts:

```
hk -c "<command-string>"   # mirrors `bash -c`
hk -- <argv...>            # exec form
hk --version
hk --help
```

**Output convention** (the contract every caller can rely on):

| Engine outcome | exit | stream | content |
|---|---|---|---|
| no terminal, no annotations | 0 | — | (silent, then exec the command verbatim, pass-through stdout/stderr/exit) |
| no terminal, annotations only | exec's exit | **stdout** | one `<prefix> warning: <msg>` or `<prefix> note: <msg>` line per annotation, then `---` separator on its own line, then exec's stdout flows below |
| `ask` (needs review) | non-zero (1) | **stdout** | `<prefix> needs review: <reason>` + one line per accumulated warning/note annotation; command does NOT run (harness re-runs on approval) |
| `deny` (hard block) | non-zero (2) | **stderr** | `<prefix> denied: <reason>` — warning/note annotations DROPPED |
| `error` annotation (alongside any outcome above) | unchanged | **stderr** | `<prefix> error: <ExceptionClass>: <message>` — engine-emitted on hook-infra failure; ALWAYS visible, survives deny, never blocks an otherwise-allowed command |

`<prefix>` is the user-supplied decision label when set (e.g. `[my-plugin]`),
or `[hook-kit]` when no label is provided. The label leads because it
identifies which plugin/rule made the call — more meaningful for log
grepping than the framework name.

**Per-site failure policy (0.5+ "0-silent-fails" contract):**

Every internal failure path constructs a typed `HookKitError` subclass. The policy is *visible to the operator always, but blocking behavior is per site*:

| Site class | Examples | Policy |
|---|---|---|
| Engine boundary | `rule.evaluate()` throws, `getBashAst()` parse failure, `state.flush()` failure | Fail-OPEN: append `error` annotation, preserve prior decision state. Iron Law 4 — never break the user's tool over a hook-infra glitch. |
| Security boundary | Broker envelope (`parseAskRequest`), askpass response (`parseAskResponse`), askpass spawn | Fail-CLOSED: emit typed error to stderr **and** synthesize a `deny`. A malformed envelope from a trusted IPC channel is itself a security signal. |
| Best-effort I/O | Audit log append, listener marker cleanup, git enrichment | Emit typed error to stderr, continue. The operation isn't load-bearing; visibility is the requirement. |

The exception hierarchy (8 classes — `FileReadError`, `FileWriteError`, `JsonParseError`, `EnvelopeValidationError`, `ShellAstParseError`, `ProcessSpawnError`, `RuleEvaluationError`, `StateStoreError`) is exported from `@questi0nm4rk/hook-kit` for `instanceof` checks. Custom rules that wrap external I/O should throw a `HookKitError` subclass instead of swallowing — the engine catches HookKitErrors thrown from `rule.evaluate()` and emits them as the specific error class, not as `RuleEvaluationError`.

**About the `---` separator:** chosen because it's the standard YAML
frontmatter / markdown horizontal-rule marker, so AI consumers parsing
the stream are already familiar with it. There is a known fidelity edge
case: if the wrapped command's own stdout *also* contains `---` on its
own line (rare in practice for tooling output; common in `git diff` or
markdown content), a downstream parser must use the *first* `---` after
the leading annotation block as the boundary. Annotation lines all
match `^\[[^\]]+\] (warning|note): `, so a parser can disambiguate by
scanning until the first non-annotation line and treating the next
`---` as the separator. Future versions may switch to an ASCII
record-separator (``) if collisions become real.

The synthesized HookEvent always has `toolName: "Bash"` and `eventName: "PreToolUse"`. Path/content rules don't fire here — they're inert without a tool channel that surfaces non-shell events. Use `redirect()` for shell-side write protection; use the cc-tools adapter alongside if you need full Edit/Write/Read coverage.

### Adapter Bins (opt-in companions)

For harnesses that have non-shell tool channels — Claude Code's `Edit`, `Write`, `NotebookEdit`, `Read` events bypass the shell entirely. To gate those, build a second binary with `--adapter cc-tools`:

```typescript
// generated entrypoint when --adapter cc-tools
import { run } from "@questi0nm4rk/hook-kit";
import { claudeCodeAdapter } from "@questi0nm4rk/hook-kit/adapters/claude-code";
import modules from "./hooks";
run(modules, claudeCodeAdapter);
```

The adapter reads CC's hook JSON from stdin and writes CC's hook JSON to stdout. Wire via `hooks.json` matchers (`Edit|Write|NotebookEdit|Read`) so the `hk` shell wrapper handles Bash and the cc-tools adapter handles the tool-call channel.

| Outcome | PreToolUse | PostToolUse / SessionStart / Stop |
|---------|-----------|-----------------------------------|
| no terminal, no annotations | exit 0, silent | exit 0, silent |
| no terminal, annotations only | `{hookSpecificOutput:{additionalContext}}` — annotations joined newline-separated, each prefixed `[label] warning\|note: <msg>` | same |
| `deny` (annotations dropped) | `{hookSpecificOutput:{permissionDecision:"block",permissionDecisionReason}}` | stderr + exit 2 |
| `ask` (annotations bundled) | Resolved via askpass → allow (annotations surfaced as `additionalContext`) / deny / harness-ask (annotations bundled into `permissionDecisionReason`) | Resolved via askpass → silent / deny / `additionalContext` |

Anyone can author additional adapter bins (`hk-cursor-tools`, `hk-opencode-tools`, …) by importing the engine + writing ~50 LOC of stdin/stdout glue. The shell wrapper remains the primary gate; adapters extend coverage to harness-specific channels.

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

The escalation system handles `Decision.kind === "ask"`. It is the only path where a hook binary can block waiting for an external decision. Per Iron Law 8, the hook publishes a request and waits; any registered listener up the parent chain can answer through the same askpass contract.

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

When a hook escalates, the request is published at the hook's own session spool. A listener attached to that spool — typically the parent agent watching `--children-of $MY_SESSION_ID` — sees the request and decides. If that listener doesn't want to decide, it forwards (`decide --escalate-up`), which republishes the same envelope at the grandparent's spool. The chain continues up. When the chain exhausts (no parent), the forwarder writes a `harness-ask` decision into the source's spool, which the cc-tools adapter renders as CC's native `ask` UI — the implicit root parent.

Multiple listeners can attach to any node simultaneously. They all see the same pending request. First-writer-wins on `decided/<id>.json` (atomic `O_EXCL`) gives a free input queue.

#### Askpass Contract

When the engine returns `ask`, the binary:

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
   The intent is to give a listener enough context — harness identity, project / cwd, branch + dirty state, transcript pointer, originating pid — to decide an ambiguous ask without round-tripping. `cwd`, `transcriptPath`, and `harness` come from the adapter; `pid`/`host`/`user` are autofilled. `git` is populated only when `HOOK_KIT_ENRICH_GIT=1` is set in the binary's environment (cheap shell-outs against `git -C cwd`); failures swallow to undefined per Iron Law 4.
2. Spawns the binary at `$HOOK_KIT_ASKPASS` with the envelope as JSON on stdin.
3. Waits for the askpass to exit (no internal timeout by default — the harness's hook timeout is the ceiling):
   - Exit 0 + JSON `{decision: "allow", reason?}` on stdout → engine emits silent allow.
   - Exit 0 + JSON `{decision: "deny", reason?}` on stdout → engine emits `deny`.
   - Exit 0 + JSON `{decision: "harness-ask", reason?}` on stdout → adapter delegates to the harness's native human-UI prompt (see User-UI Tier).
   - Exit non-zero or unparseable stdout → treated as deny with a reason.

`expiresAt` is computed from a TTL (default 60s) and stays in the envelope as **metadata only**. Listeners and observability layers may use it (audit logs, "raised X minutes ago" hints, MCP elicitation conformance), but neither the broker nor `callAskpass` enforce it as a deadline by default. Custom askpass binaries that callers don't trust to terminate can opt in by passing `timeoutMs` to `callAskpass`.

**`$HOOK_KIT_ASKPASS` unset** → no broker infrastructure configured; the adapter delegates directly to the harness's UI tier via `harness-ask`. The CC adapter renders this as `permissionDecision: "ask"`. This is not silent-allow — the harness UI is itself a responder. Use this when you don't want the broker tree (e.g. simple "ask the human" hooks).

**`$HOOK_KIT_ASKPASS` set but binary missing / non-executable / exits non-zero / returns malformed output** → emit deny with reason `[hook-kit] askpass …`. This is the Iron Law 4 exception: when broker infra was *expected* but is broken, fail closed — never silent-allow.

The askpass binary is the **public contract**. Any program that reads JSON on stdin, writes a decision to stdout, and exits is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, the bundled `hook-kit broker`.

#### Default Broker

The bundled `hook-kit broker` is the default askpass implementation. It manages per-session ask channels at `~/.cache/hook-kit/sessions/$SESSION_ID/`:

```
sessions/$SESSION_ID/
├── meta.json                   # {parent_session_id?, started_at, pid}
├── pending/$REQUEST_ID.json    # the envelope
├── decided/$REQUEST_ID.json    # the decision (first-writer-wins)
├── listeners/$PID.lock         # liveness markers — one per attached listener
└── audit.jsonl                 # append-only log of all events
```

Discovery: `meta.json`'s `parent_session_id` lets a process enumerate its descendant sessions. Set automatically from `$HOOK_KIT_PARENT_SESSION_ID` (env var) or by walking process lineage. Each session gets its own ask channel — no global mixed queue.

When invoked as askpass (`hook-kit broker --askpass`), it:

1. Reads the envelope from stdin.
2. **Validates: NO PARENT ATTACHED check.** Walks the parent chain via `meta.json` (cycle-safe). At each level, scans `<session>/listeners/` for live markers (`kill(pid, 0)` liveness probe, stale markers pruned). If zero live listeners exist anywhere in the chain → returns a deny with reason `[hook-kit] NO PARENT ATTACHED`. The original `ask` reason is preserved in the deny.
3. Atomically writes `pending/$REQUEST_ID.json` (`O_EXCL`).
4. Polls `decided/$REQUEST_ID.json` (default 100ms). **No internal timeout** — the broker waits until either a decision lands or its process is killed externally (CC's hooks.json timeout being the practical ceiling).
5. On match → reads decision, deletes both files, appends to `audit.jsonl`, writes decision to stdout, exits 0.

Directory permissions: `0700` on the session directory. Owner-only access; no tokens.

The validator only fires for ask paths (the broker is the askpass for ask). Non-ask decisions never reach the broker — `cmd("rm").deny("blocked")` works without any listener attached.

#### Forwarding (`escalate-up`)

A listener that doesn't want to decide a question can punt it up the tree. `hook-kit decide --escalate-up` does one hop synchronously:

1. Reads the source session's `pending/$REQUEST_ID.json`.
2. Looks up `parent_session_id` from `meta.json`.
3. **No parent →** writes a `harness-ask` decision into the source's `decided/$REQUEST_ID.json`. The cc-tools adapter sees harness-ask and emits CC's native ask UI. Chain terminates here.
4. **Parent exists →** atomically writes the envelope (with a `forwarded_from: <source>` field added) to `parent/pending/$REQUEST_ID.json`, then polls `parent/decided/$REQUEST_ID.json`. When the parent's decision lands, copies it down to the source's `decided/$REQUEST_ID.json` so the original hook unblocks.

Multi-hop chains compose by recursion: each level's listener can independently `--escalate-up`. The forwarder is synchronous (no daemon, no event watcher), bounded by the original hook process's lifetime — when CC's hook timeout kills the hook, every blocked forwarder up the chain unblocks too.

There is no per-hop timeout by default. A test or specialized caller can pass `timeoutMs` to the underlying `forwardUp()` function for bounded waits.

#### Hook Timeout (CC-side)

`hook-kit` does not enforce a timeout on its own. The only ceiling is CC's `hooks.json` per-hook timeout. The build CLI **requires** `--hook-timeout <seconds>` when emitting `hooks.json` — there is no default. Pick deliberately:

- Short (e.g., `5`) — plugins without ask rules.
- Long (e.g., `3600`) — plugins where ask may need a human to think.

If CC kills the hook process before a decision lands, the adapter returns deny via the killed-process exit. The `pending/<id>.json` and any forwarded copies up the chain remain on disk; a late listener answer is wasted but harmless.

#### MCP Elicitation Compatibility

The envelope JSON Schema is shaped to match Model Context Protocol elicitation requests. A future MCP-aware listener can subscribe and respond using the MCP elicitation contract directly — no translation layer required.

### Build CLI

```
hook-kit build <entrypoint> --out <path>
                            [--adapter shell|cc-tools]   (default: shell)
                            [--target <bun-target>]      (e.g. bun-linux-arm64; default: host)
                            [--hooks-json <path>] [--binary-command <s>]
                            [--hook-timeout <seconds>]

hook-kit broker --askpass
hook-kit watch [--session <id>] [--children-of <id>] [--poll-ms <n>]
hook-kit subscribe [--session <id>] [--children-of <id>] [--poll-ms <n>] --json
hook-kit decide <request_id> --session <id>
                --allow | --deny | --escalate-up
                [--reason <text>] [--by <name>]
hook-kit list [--children-of <id>] [--json]
```

`build`:

1. Generates a thin entrypoint wrapping the user's modules + adapter mode.
2. Runs `bun build <entrypoint> --compile --bytecode --outfile <out>`. With `--target <bun-target>` passed, the value forwards verbatim to `bun build --target=<bun-target>` for cross-compilation (e.g. `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`). bun's own error surfaces if the value is unrecognized.
3. Generates `hooks.json` from module metadata (events, matchers) when `--hooks-json <path>` is set. Only meaningful for `--adapter cc-tools` (the shell wrapper isn't wired through CC's hook system). **`--hook-timeout <seconds>` is required** in this mode — no default.

Adapter modes:

- **`shell`** (default) — produces an `hk`-style wrapper. Substitutes for `bash -c "<cmd>"`. Agent-agnostic. Output via stdout/stderr/exit-code per the convention.
- **`cc-tools`** — Claude Code tool-call adapter. Hooks `Edit` / `Write` / `NotebookEdit` / `Read` events that bypass the shell. Use alongside the shell wrapper.

## Consumption Modes

### Shell wrapper (default)

Each plugin compiles its own `hk` binary:

```
my-plugin/
├── src/hooks.ts       # createModule() + rules
├── dist/hk            # compiled wrapper binary
└── package.json       # depends on @questi0nm4rk/hook-kit
```

Build: `hook-kit build src/hooks.ts --out dist/hk`

Integration depends on the caller. Some patterns:

- Aliasing: `alias bash=/path/to/dist/hk` in the agent's environment (or scoped to a directory via `direnv`).
- Substitution in agent config: where the agent invokes `bash -c "<cmd>"`, configure it to invoke `hk -c "<cmd>"` instead (when supported).
- Wrapping: ship a `bash` shim on `$PATH` that exec's `dist/hk` with arg passthrough.
- Direct: an agent that constructs commands explicitly can call `dist/hk -c "<cmd>"` itself.

```typescript
// src/hooks.ts
import { createModule, cmd, pipe, redirect } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "block-force-push", name: "Block force push", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease")
       .deny("Use --force-with-lease, not raw --force")],
  ),
  createModule(
    { id: "block-rce", name: "Block remote code exec", events: ["PreToolUse"], matchers: ["Bash"] },
    [pipe(["curl", "wget"], ["bash", "sh", "zsh"]).deny("RCE via pipe-to-shell")],
  ),
  createModule(
    { id: "protect-env", name: "Protect .env from redirects", events: ["PreToolUse"], matchers: ["Bash"] },
    [redirect(/\.env$/).deny("don't redirect into .env")],
  ),
];
```

**Async-init entrypoint** — when the modules depend on async work (e.g.
loading a config file at startup), default-export an async function that
returns the modules array. The build wrapper calls it on startup and awaits
the result:

```typescript
// src/hooks.ts
export default async () => {
  const config = await loadHookConfig();
  return buildModules(config);
};
```

Top-level `await` directly in `hooks.ts` is not supported — `bun build
--compile --bytecode` rejects TLA in any module reachable from the
entrypoint. Wrap the async work in an exported function and the generated
wrapper handles the rest.

```bash
$ hk -c "git push --force origin main"
[hook-kit] needs review: Use --force-with-lease, not raw --force
$ echo $?
1

$ hk -c "ls -la /tmp"
total 24
drwxrwxrwt 1 root root  280 May 10 09:42 .
…
$ echo $?
0
```

### Adapter bin (cc-tools, for non-shell tool channels)

When you also need to gate Claude Code's `Edit` / `Write` / `Read` events:

```bash
hook-kit build src/hooks.ts --out dist/hk-cc-tools --adapter cc-tools \
  --hooks-json hooks/hooks.json --hook-timeout 10
```

Generates `hooks.json` that wires the binary into CC. Binary stdin/stdout speaks CC's hook JSON.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write|NotebookEdit|Read",
      "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools","timeout":10}]
    }]
  }
}
```

The two binaries cooperate: `hk` covers the shell, `hk-cc-tools` covers the rest. Same source, two builds.

### Library Mode

Import the engine and builders directly. Skip the build CLI; bring your own I/O:

```typescript
import { evaluate, createModule, cmd } from "@questi0nm4rk/hook-kit";

const modules = buildModulesFromConfig(myConfig);
const decision = await evaluate(hookEvent, modules);
// Map decision to your own output format.
```

Or use `runShell()` programmatically (e.g. for an in-process wrapper):

```typescript
import { runShell } from "@questi0nm4rk/hook-kit/wrapper/hk";
import modules from "./hooks";

await runShell(modules);  // reads process.argv, evaluates, exits
```

## Tool Plugin Pattern

A tool plugin (e.g., `qsm-github`, `qsm-spec`) consumes hook-kit to ship one or two binaries that enforce all of that tool's rules. One binary per tool, not one per rule — startup cost amortizes across rules.

```
tools/qsm-github/
├── src/hooks.ts          # createModule() + rules
├── dist/hk               # shell wrapper (default)
├── dist/hk-cc-tools      # CC tool-call adapter (optional)
├── hooks/hooks.json      # CC integration for the cc-tools binary
└── package.json
```

The shell wrapper is the always-applicable contract; the cc-tools binary is the optional companion for harnesses that have non-shell tool channels.

## Testing

| Surface | Test approach |
|---------|--------------|
| Builders | Unit per builder × edge cases (flag matching, regex, empty args, unknown commands → silent, ddash, pipe, redirect) |
| Engine | Deny short-circuit, ask-with-annotations bundling, annotation stacking, module filtering, ordering, error handling, inline-shell recursion, depth limit, typed-error annotations |
| Wrapper | Output convention (silent-on-null, stderr+exit-2 on deny, stdout+exit-1 on ask, stderr `error:` lines), exec passthrough, exit-code passthrough, --version, --help |
| Adapters | CC JSON shape per decision per event; empty/malformed stdin |
| State stores | get/set/has/delete/flush, missing file, disk full, corruption |
| Escalation | askpass spawn + stdin/stdout protocol, unset askpass falls through to harness-ask, broker spool atomicity, listener marker liveness, NO PARENT ATTACHED validator, listener CLIs, escalate-up forward (single + multi-hop), harness-ask delegation |
| Integration | Compile fixture + execute end-to-end (shell wrapper + cc-tools) |
| Performance | Compiled binary cold start < 50ms |

## Operational Readiness

- **Observability:** `HOOK_KIT_VERBOSE=1` on the binary's environment emits a single stderr trace line per evaluation: event, tool, session, module count, decision kind, label, reason, time. Each decision can carry a `label` for source attribution. Broker state and ask channels are inspectable on disk: `cat ~/.cache/hook-kit/sessions/$SESSION_ID/audit.jsonl`. Git enrichment of AskRequest envelopes opts in via `HOOK_KIT_ENRICH_GIT=1`.
- **Failure modes:**
  - shell-AST WASM fails to load → all command/pipe/redirect rules return `null` (silent), stderr warning.
  - tmpdir/cache write fails → state lost, hook returns `null` (silent).
  - Rule throws → caught, treated as `null` (silent), logged.
  - Stdin empty/malformed (cc-tools adapter) → adapter exits 0 (silent).
  - `ask` without `HOOK_KIT_ASKPASS` set → falls through to harness-ask (CC ask JSON via cc-tools; non-blocking exit 1 from shell wrapper). The harness UI tier is itself a responder, so this is not silent-allow.
  - `ask` with broken askpass infra (binary missing / non-zero exit / malformed output) → deny with `[hook-kit] askpass …` reason. Iron Law 4 exception: when broker infra was *expected* but is broken, fail closed.
  - `ask` with broker `NO PARENT ATTACHED` (no live listener anywhere in the chain) → deny with reason. Surfaces misconfigured plugins immediately instead of hanging on the hook timeout.
- **Deployment:** Compiled binary committed under the plugin (e.g., `dist/hk` for the shell wrapper, optionally `dist/hk-cc-tools` for the CC tool-call companion). For the cc-tools binary, `hooks.json` points to `${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools`. CI rebuilds on push. Plugin pins to `^major.minor` of hook-kit.
- **Rollback:** Delete the compiled binary; restore the previous version from git. Per-plugin binaries mean one broken plugin doesn't affect others.
- **CI gate:** `.github/workflows/test.yml` runs `bun install --frozen-lockfile` + `biome check` + `bun test` on push to main and every PR. Red CI = no merge.

## DON'Ts

- Don't put domain knowledge in tool binaries. Tools enforce, knowledge belongs elsewhere.
- Don't add rules that depend on which other plugins are active. Tool rules are unconditional.
- Don't output `allow` decisions. Silent exit = allowed. Only `deny` / `ask` / `warning` / `note` produce output.
- Don't catch errors and deny. Catch errors and stay silent (fail open) — except for `ask` infrastructure failures, which deny explicitly.
- Don't assume `path()` rules fire under the shell wrapper. They don't — the wrapper synthesizes a Bash event. Use `redirect()` for shell-side write protection or build a cc-tools companion binary.
- Don't put multiple tools in one binary. One binary per tool keeps release cycles independent.
- Don't bypass the askpass contract. If you need synchronous human-in-the-loop, write an askpass binary; don't reach into the broker spool directly.
- Don't expect `expiresAt` to be enforced by anything in hook-kit. It's metadata for audit/observability/MCP conformance only — listeners that want a hard deadline must enforce it themselves.
- Don't ship a plugin whose ask rules depend on broker infra without setting `HOOK_KIT_ASKPASS`. With it unset, ask falls through to harness-ask immediately, which may be the wrong policy for your use case.

## Key Trade-offs

| Chose | Over | Because |
|-------|------|---------|
| Shell wrapper as the v0.3 default | Harness adapter as the default | Caller-agnostic by design — no JSON wire protocol with the harness, decisions surface through the same channel the caller already reads. Works for any caller that runs commands. |
| Per-plugin binaries | One monolithic binary | Plugin isolation; independent release cycles. |
| Variadic `cmd(command, ...sub)` | Named or array sub | Most natural TypeScript API; covers single-level and multi-level subcommands. |
| Inline-shell recursion default-on | Opt-in | Without it every cmd() rule has a 1-line bypass via `bash -c "…"`. |
| `pipe()` and `redirect()` as first-class builders | Express via `cmd()` | They can't be — different AST shapes (BinaryCmd, Stmt redirs). Necessary for canonical patterns (curl|bash, cmd > .env). |
| tmpdir/cache JSON state | SQLite or memory-only | Simplest persistence that survives within a session. |
| Fail open on infra errors | Fail closed | Hook framework bugs must not block users. Security-critical rules belong in the harness's own deny list. |
| Wrapper output convention (stdout/stderr/exit-code) | JSON output | The caller already reads shell I/O. No new parser needed to consume a decision. |
| Sequential rule evaluation | Parallel | State mutations visible to next rule; no race conditions. |
| Blacklist semantics | Whitelist | Matches harness behavior. One block wins regardless of others. |
| `ask` resolved via askpass + broker (with unset-fallback to harness-ask) | Hard-deny on unset askpass | Most simple "ask the user" hooks don't need a broker tree. The harness UI tier is itself a responder. Iron-law-4 fail-closed is preserved when broker infra is *expected* but broken. |
| Per-session ask channels | One global queue | Avoids cross-session noise when multiple sessions × subagents are active. Discovery via `meta.json` parent links. |
| Tree-shaped escalation with `escalate-up` forward | Auto-routing in the broker | Listeners explicitly choose to forward, matching the user's mental model. Synchronous forwarder, no daemon, audit trail per hop. |
| Listener markers (`<session>/listeners/<pid>.lock`) | Implicit liveness via inotify on connections | File-based markers compose with the rest of the spool, survive process restarts of inspectors, and are pid-liveness-checkable from any tool. |
| **NO PARENT ATTACHED validator** denies ask when no listener anywhere in chain (broker mode only) | Silent hang or auto-allow | Hook timeouts can hide misconfigured plugins for minutes. The validator surfaces "you forgot to attach a listener" immediately. With `HOOK_KIT_ASKPASS` unset, the validator doesn't run — ask falls through to harness-ask. |
| No default `--hook-timeout` (required when `--hooks-json` set) | Sensible default like 65s or 3600s | Either default has a wrong tail. Forcing the plugin author to pick makes the trade-off explicit at build time. |
| Filesystem spool inside the broker | Socket-only or HTTP | Inspectable, crash-safe, atomic via `rename(2)`, no daemon strictly required. |
| Askpass as the public escalation contract | A dedicated socket protocol | Decades of prior art (sudo, ssh, git, gpg). Any binary can be a responder. |

## Considered Future Additions

Things explored but deliberately deferred. Logged so we don't re-litigate.

### Direct-ask tool (sibling project)

**Idea:** A CLI an agent invokes via its Bash tool to ask the user a discrete question with named options, e.g. `ask "Use vitest or bun:test?" --option vitest:... --option bun-test:...`. Stdout returns the chosen option, exit code encodes accept/deny/timeout. Reuses the same broker spool + TUI listeners that hook escalations already use; question envelopes vs. approval envelopes differ only in `kind`.

**Why not now:** hook-kit's purpose is hooking — intercepting tool calls the agent already made. A direct-ask tool serves the inverse flow (agent volunteers a question) and shouldn't share a binary with the wrapper. The broker substrate is reusable, but a CLI surface for it doesn't belong inside the `hk` bin.

**When to revisit:** when a concrete consumer needs it. Build as a separate project; copy the askpass envelope protocol over rather than depend on hook-kit as a library — the protocol is the contract, the code is incidental. Per-rule `timeoutMs` on `ask()` belongs in the same revisit window if/when it shows up.

### `hk exec` wrapper for non-bash-timeout harnesses

**Idea:** A second wrapper shape — `hk exec -- <cmd>` — distinct from the default `hk -c "<cmd>"`. Aimed at harnesses where the agent's bash tool timeout isn't configurable from the rule side. Hook-kit spawns the command, evaluates rules, enforces its own ask timeout end-to-end. Opt-in.

**Why not now:** CC has per-hook `timeout` in `hooks.json`, and adapter-level `timeoutMs` on `resolveCcOutput`/`callAskpass` already covers library and shell-wrapper consumers. No known harness today actually needs hook-kit to own the budget. New argv shape + exit-code mapping is non-trivial for a hypothetical user.

**When to revisit:** when a real harness ships that swallows hook timeouts silently or caps them below ~110s without override. Add `hk exec` as a sibling binary, not a subcommand of `hk` — keep the default wrapper as a pure `bash -c` substitute.
