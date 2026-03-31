# SPEC-001: @questi0nm4rk/hook-kit

## Status: Draft

## Problem

Two projects need hook infrastructure for AI coding agents:
- **ai-guardrails**: compiled binary with shell-ast rule engine — fast but non-reusable (tightly coupled to its CLI/config)
- **qsm-marketplace**: 15 TypeScript scripts across 9 plugins, each invoked via `npx tsx` (~1s startup per hook), 7 copies of hook-runtime.ts

WHY: No shared hook framework exists. Each project reinvents stdin reading, shell-ast parsing, decision serialization, and state management. Adding a rule means writing a new script with 50+ lines of boilerplate.

## Solution

`@questi0nm4rk/hook-kit` — a framework for building compiled hook binaries with:
- Protocol-agnostic core (Decision types, rule engine, builders)
- Protocol adapters (CC, future: Cursor/Windsurf/etc.)
- Per-plugin compilation (each plugin builds its own binary)
- Shared shell-ast integration (parsed once per invocation)

## Philosophy

### Iron Laws

1. **Rules are data, not scripts** — WHY: Data rules are testable without stdin mocking, composable across modules, and inspectable for reporting. Scripts require process spawning.

2. **Parse once, evaluate many** — WHY: shell-ast WASM init is expensive (~200ms first call). Parsing the command AST once and sharing it across all rules in that invocation is the key performance win.

3. **Fail open on infrastructure errors** — WHY: A hook framework bug should never block a developer. State store disk full → silent. JSON parse error → silent. Rule throws → silent. Only explicit deny() blocks.

4. **Blacklist semantics** — WHY: There is no "allow". A hook either blocks or stays silent. If 20 hooks pass and 1 blocks, it's blocked. Silent exit = didn't get blocked. The engine never outputs an explicit "allow" decision.

5. **Protocol adapter owns serialization** — WHY: The core engine returns generic Decisions. The CC adapter maps them to CC's JSON format. If CC changes its protocol, only the adapter changes.

6. **Each plugin compiles its own binary** — WHY: Plugin isolation. qsm-pr-review can iterate without affecting qsm-memory. No cross-plugin dependency chains.

## Constraints

- TypeScript + Bun for compilation (`bun build --compile`). ASSUMES: Bun compile remains stable. IF Bun drops compile support → fall back to `esbuild --bundle` + Node.js.
- `@questi0nm4rk/shell-ast` is a direct dep (bundled, not peer). ASSUMES: shell-ast API is stable. IF shell-ast breaks → vendored WASM binary as fallback.
- Compiled binary startup target: < 50ms cold, measured on host machine via `time`. IF exceeds 100ms consistently → investigate rule count, state store, WASM init.
- State store default: tmpdir JSON per session. ASSUMES: single-machine, single-agent invocations. IF concurrent agents or containers → swap to memory-store or custom adapter.

## Architecture

### Package Structure

New repo: `Questi0nM4rk/hook-kit`

```
@questi0nm4rk/hook-kit/
├── src/
│   ├── index.ts                    # Public barrel: core + builders + engine
│   ├── core/
│   │   ├── types.ts                # Decision, HookEvent, HookModule, Rule, EvalContext
│   │   ├── decision.ts             # deny(), context(), escalate()
│   │   ├── event.ts                # toToolEvent() — typed view of HookEvent
│   │   └── module.ts               # createModule() factory
│   ├── rules/
│   │   ├── command.ts              # cmd() builder — shell-ast based
│   │   ├── path.ts                 # path() builder — file path patterns
│   │   ├── content.ts              # content() builder — body/frontmatter inspection
│   │   ├── custom.ts               # custom() — arbitrary predicates
│   │   └── state.ts                # stateful() — cross-invocation state
│   ├── engine/
│   │   ├── index.ts                # evaluate(event, modules, opts) → Decision | null
│   │   └── helpers.ts              # Flag expansion, redirect/pipe detection
│   ├── adapters/
│   │   ├── types.ts                # ProtocolAdapter interface
│   │   ├── claude-code.ts          # CC stdin/stdout JSON serialization
│   │   └── raw.ts                  # For testing / library mode
│   ├── state/
│   │   ├── types.ts                # StateStore interface
│   │   ├── tmpdir-store.ts         # Default: tmpdir JSON per session
│   │   └── memory-store.ts         # For testing
│   └── build/
│       ├── cli.ts                  # `hook-kit build` command
│       └── bundle.ts               # Generates binary entrypoint
└── tests/
```

### Core Types

```typescript
// === Decisions (protocol-agnostic, blacklist semantics) ===
//
// There is NO "allow". A hook either blocks or stays silent.
// Silent (null return or no decision) = didn't get blocked.
// If any rule in any module returns a non-null decision, that decision wins.

type Decision =
  | { kind: "deny"; reason: string; label?: string }
  | { kind: "context"; message: string; label?: string }
  | { kind: "escalate"; reason: string; label?: string }
  | null  // silent = didn't block

// "deny"     = hard block. CC: permissionDecision "block" (PreToolUse) or exit 2 + stderr (PostToolUse)
// "context"  = inject info into agent's conversation. CC: additionalContext. Does NOT block.
// "escalate" = ask the human. CC: permissionDecision "ask" (PreToolUse only; degrades to context in PostToolUse)
// null       = silent pass-through. CC: exit 0 with no stdout.
// "label"    = optional prefix for observability (e.g., "[pr-review]", "[strict-review]")

// === Events ===

interface HookEvent {
  eventName: string;           // "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop" | ...
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  toolName: string;            // "Bash" | "Write" | "Edit" | "Read" | ...
  toolInput: Record<string, unknown>;
  raw: Record<string, unknown>; // full original payload (for custom rules that need extra fields)
}

// Typed tool views (computed via toToolEvent)
type ToolEvent =
  | { type: "bash"; command: string }
  | { type: "write"; path: string; content?: string }
  | { type: "read"; path: string }
  | { type: "edit"; path: string; oldStr?: string; newStr?: string }
  | { type: "other"; toolName: string; toolInput: Record<string, unknown> }

// === Rules ===

interface Rule {
  readonly kind: string;
  evaluate(event: HookEvent, ctx: EvalContext): Decision | null | Promise<Decision | null>;
  // Returns null = silent (didn't block). Returns Decision = action to take.
}

interface EvalContext {
  state: StateStore;
  modules: readonly HookModule[];
}

// === Modules ===

interface HookModule {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];    // which hook events to handle
  readonly matchers?: readonly string[]; // tool name filters ("Bash", "Edit|Write")
  readonly rules: readonly Rule[];
  readonly enabled?: boolean;            // default true, can disable via config
}
```

### Rule Builder API

```typescript
// cmd(command, ...subcommands) — variadic, checks args[0..N]
function cmd(command: string, ...sub: string[]): CommandRuleBuilder
```

**Semantics:**
- `cmd("gh", "pr", "comment")` → matches cmd=gh AND args starts with ["pr", "comment"]
- `cmd("git", "push")` → matches cmd=git AND args[0]="push"
- `cmd("rm")` → matches cmd=rm with any args
- `.withFlag("--force")` → required flags (expanded via flag aliases, e.g., `-f` → `--force`)
- `.withoutFlag("--force-with-lease")` → forbidden flags
- `.argMatches(/pattern/)` → at least one resolved arg matches regex (includes flag values — see note)
- `.argIncludes("literal")` → exact string present in resolved args array (NOT substring)
- `.deny(reason)` / `.context(msg)` / `.escalate(reason)` → terminal, returns Rule

**Shell-ast resolution behavior (critical for correctness):**
- `resolveFlags()` returns `{ cmd, flags, args }` where `args` contains BOTH positional args AND flag values
- BUT: quoted strings (`"..."` and `'...'`) resolve to `<dynamic>` — they are NOT literal strings in args
- Since Claude always quotes long text (bodies, messages), flag values with content become `<dynamic>` and never match literal patterns
- Unquoted flag values (e.g., `--field event=COMMENT`) DO appear as literals in args
- The variadic sub matching (`cmd("gh", "pr", "comment")`) checks by position — `args[0]`, `args[1]` — which are always subcommands, never flag values (CLI convention: subcommands before flags)

**Edge cases:**
- `.withFlag("--force").withoutFlag("--force-with-lease")` → matches only if --force present AND --force-with-lease absent (both conditions required, same as ai-guardrails)
- `gh pr review --body "has comment"` → args: ["pr", "review", "<dynamic>"] → `argMatches(/comment/)` does NOT match (body is <dynamic>)
- `gh pr comment` → args: ["pr", "comment"] → `cmd("gh", "pr", "comment")` matches correctly by position
- `gh api --field event=COMMENT` → args: ["api", "...", "event=COMMENT"] → `argMatches(/COMMENT/)` matches (unquoted flag value)

```typescript
// path(pattern) — regex on file_path
function path(pattern: RegExp): PathRuleBuilder
// .onWrite() — only Write|Edit events (Edit is Write-adjacent, both treated as "write")
// .onRead() — only Read events
// Default: both

// content() — PostToolUse body inspection ONLY (file already on disk after tool runs)
function content(): ContentRuleBuilder
// .matchPath(pattern) — only files matching regex
// .validate((filePath, body) => Decision) — custom validation function
// body source: always readFileSync(filePath) — PostToolUse means the Write/Edit already applied
// For Edit events: file on disk has the final content (edit already applied), no need for oldStr/newStr

// stateful(id, fn) — cross-invocation state
function stateful(id: string, fn: (event: HookEvent, state: StateStore) => Decision | Promise<Decision>): Rule
// State backed by StateStore (default: tmpdir JSON per session)
// State persisted after evaluate() call (flush() called automatically)

// custom(id, fn) — escape hatch for anything else
function custom(id: string, fn: (event: HookEvent) => Decision | Promise<Decision>): Rule
// If fn throws → caught by engine → silent (null)
```

### Engine

```typescript
async function evaluate(
  event: HookEvent,
  modules: readonly HookModule[],
  opts?: { state?: StateStore; shortCircuit?: boolean }
): Promise<Decision | null>
```

**Evaluation flow:**
1. Filter modules by `events` (must include `event.eventName`)
2. Filter modules by `matchers` (if present, at least one must match `event.toolName`; `|` is OR within each string)
3. For each remaining module, evaluate rules **sequentially** (awaited one at a time, array order)
4. **Short-circuit** (default: true): first `deny` or `escalate` wins immediately, skips remaining rules AND modules
5. **Context accumulation**: all `context` messages collected, joined with `\n\n`
6. If no rule returned a non-null decision → return `null` (silent pass-through, blacklist semantics)
7. State flushed after all evaluation completes (even on short-circuit)

**Module/rule ordering:** deterministic — array order in modules[], then array order in rules[]. This is an API contract.

**Sequential evaluation:** Rules are `await`ed one at a time. No parallel evaluation. State mutations within a rule are visible to the next rule. Flush happens once at the end, after all rules complete. No race conditions.

**Shell-ast caching:** `parse()` called once per evaluate() invocation for Bash events. All command rules share the parsed AST. Cache is per-invocation only (in-memory, not persisted).

**Error handling in custom rules:** If `rule.evaluate()` throws → caught → treated as `null` (silent). Logged to stderr but never blocks. This is Iron Law 3.

### Protocol Adapter

```typescript
interface ProtocolAdapter {
  readInput(): Promise<HookEvent>;
  writeOutput(decision: Decision | null, event: HookEvent): never;
  handleError(error: unknown): never;  // never crash — exit 0
}
```

**CC adapter mapping:**

| hook-kit | CC PreToolUse | CC PostToolUse | CC SessionStart/Stop |
|----------|---------------|----------------|----------------------|
| null (silent) | exit 0, no stdout | exit 0, no stdout | exit 0, no stdout |
| deny(reason) | `permissionDecision: "block"` + `permissionDecisionReason` | stderr + exit 2 | stderr + exit 2 |
| context(msg) | `additionalContext` | `additionalContext` | `additionalContext` |
| escalate(reason) | `permissionDecision: "ask"` + `permissionDecisionReason` | degrades to `context` | degrades to `context` |

**Empty stdin** → handleError() → exit 0 (silent). Never hang.

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

**tmpdir-store:** `join(tmpdir(), "hook-kit-{namespace}-{sessionId}.json")`
- Loaded on construction (cold: empty object; warm: JSON.parse)
- Flushed automatically after evaluate()
- **No locking** — ASSUMES single-agent sequential hook invocations. IF concurrent → use memory-store or implement flock()
- **No expiry** — tmpdir cleanup is OS responsibility. State files are small (~1KB for repetition hashes)
- **Disk full** → writeFileSync throws → caught by engine → silent. State lost but hook doesn't block.

### Build System

```bash
hook-kit build src/hooks.ts --out dist/my-hooks --adapter claude-code
# OR with runtime plugin directory:
hook-kit build src/hooks.ts --out dist/my-hooks --adapter claude-code --plugins-dir ./rules/
```

**What it does:**
1. Generates a thin entrypoint that imports user's modules + adapter
2. Runs `bun build <entrypoint> --compile --bytecode --outfile <out>`
3. Optionally generates `hooks.json` from module events/matchers

**Runtime extensibility** (--plugins-dir):
- At startup, binary scans `--plugins-dir` for `.ts` files
- Each file must `export default` a `HookModule`
- Loaded modules are appended to compiled modules
- Startup cost: ~5ms per plugin file (dynamic import via bun)

**Generated hooks.json** (from modules):
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/dist/my-hooks" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Write|Edit", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/dist/my-hooks" }] }
    ]
  }
}
```

## Consumption Modes

### Binary mode (qsm-marketplace)

Each plugin with hooks compiles its own binary:

```
qsm-pr-review/      → dist/qsm-pr-review-hooks
qsm-strict-review/  → dist/qsm-strict-review-hooks
qsm-meta-agents/    → dist/qsm-meta-agents-hooks
qsm-memory/         → dist/qsm-memory-hooks
qsm-dotnet-lang/    → dist/qsm-dotnet-lang-hooks
qsm-obsidian-research/ → dist/qsm-obsidian-research-hooks
qsm-spec-design/    → dist/qsm-spec-design-hooks
```

**Example: qsm-pr-review plugin**
```typescript
// plugins/pr-review/src/hooks.ts
import { createModule, cmd } from "@questi0nm4rk/hook-kit";

export default [
  createModule({
    id: "block-raw-review-api",
    name: "Block raw review API",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  }, [
    cmd("gh", "pr", "comment").deny("[pr-review] Use pr-review reply instead"),
    cmd("gh", "pr", "view").withFlag("--json").argMatches(/\b(reviews|comments)\b/)
      .deny("[pr-review] Use pr-review status/comments"),
    cmd("gh", "api", "graphql").withFlag("--field")
      .deny("[pr-review] Use pr-review threads/resolve/reply/dismiss"),
    cmd("gh", "api").argMatches(/\/pulls\/\d+\/reviews(?!\/)/)
      .deny("[pr-review] Use pr-review status"),
    cmd("gh", "api").argMatches(/\/pulls\/\d+\/comments/)
      .deny("[pr-review] Use pr-review comments"),
  ]),
];
```

Build: `hook-kit build plugins/pr-review/src/hooks.ts --out plugins/pr-review/dist/hooks --adapter claude-code`

### Library mode (ai-guardrails)

ai-guardrails imports engine + builders, keeps its own CLI/config/output:

```typescript
import { evaluate } from "@questi0nm4rk/hook-kit/engine";
import { createModule, cmd } from "@questi0nm4rk/hook-kit";

const modules = buildModulesFromConfig(config); // ai-guardrails converts its rules
const decision = await evaluate(hookEvent, modules);
// ai-guardrails maps decision to its own output format (exit code 2 for deny, etc.)
```

## Migration

### Phase 1: Build and publish @questi0nm4rk/hook-kit
- New repo, scaffold package structure
- Port engine from `ai-guardrails/src/check/engine.ts` + `engine-helpers.ts`
- Port flag aliases from `ai-guardrails/src/check/flag-aliases.ts`
- Implement builders: cmd(), path(), content(), stateful(), custom()
- Implement CC adapter, tmpdir-store, memory-store
- Implement build CLI
- TDD throughout, publish to npm

### Phase 2: qsm-marketplace migration (per-plugin binaries)
- For each plugin with hooks: write `src/hooks.ts` using hook-kit builders
- Import pure validation functions from existing scripts (already exported + tested)
- Compile per-plugin binaries
- Update each plugin's hooks.json to point to compiled binary
- Delete hook-runtime.ts copies and npx tsx scripts

### Phase 3: ai-guardrails migration (library mode)
- Add hook-kit as dependency
- Convert rule groups to hook-kit modules (incrementally, one group at a time)
- Replace engine.ts internals with hook-kit evaluate()
- Keep CLI, config, output formatting unchanged
- All existing tests must pass after each step

## Key Files to Port

| Source | Destination | What |
|--------|-------------|------|
| `ai-guardrails/src/check/engine.ts` | `hook-kit/src/engine/index.ts` | Core evaluation loop |
| `ai-guardrails/src/check/engine-helpers.ts` | `hook-kit/src/engine/helpers.ts` | Redirect/pipe/inline-script detection |
| `ai-guardrails/src/check/flag-aliases.ts` | `hook-kit/src/engine/helpers.ts` | Flag expansion mappings |
| `ai-guardrails/src/hooks/runner.ts` | `hook-kit/src/adapters/claude-code.ts` | stdin reading pattern |
| `qsm-marketplace/plugins/*/lib/hook-runtime.ts` | `hook-kit/src/adapters/claude-code.ts` | CC JSON output format |

## Verification

1. **Unit tests:** every builder (cmd, path, content, stateful, custom) with edge cases
2. **Engine tests:** short-circuit on deny, context accumulation, module filtering, empty modules
3. **Adapter tests:** CC JSON output matches current hook-runtime.ts output exactly
4. **Integration test:** pipe stdin JSON → compiled binary → validate stdout JSON
5. **Regression:** port ai-guardrails test suite to hook-kit engine
6. **Regression:** smoke-test all qsm-marketplace hook patterns via compiled binaries
7. **Performance:** compiled binary startup < 50ms, measured via `time echo '{}' | ./dist/hooks`
8. **Observability:** `--verbose` flag logs which modules ran, which rules matched, final decision

## Testing Strategy

**Unit tests (per builder):**
- cmd(): flag matching, flag exclusion, variadic sub matching, argMatches vs argIncludes, empty args, unknown commands → silent
- path(): regex matching, onWrite vs onRead, Edit treated as Write, no match → silent
- content(): matchPath filtering, validate callback, body read from disk, missing file → silent
- stateful(): state.get/set across invocations, flush called, state corruption → silent
- custom(): normal return, throw → silent, async rules

**Engine tests:**
- Short-circuit: deny stops evaluation, context does not
- Accumulation: multiple context() messages joined with \n\n
- Module filtering: events filter, matchers filter, disabled modules skipped
- Empty: no modules → null, module with no rules → null
- Ordering: modules evaluated in array order, rules within module in array order
- Error: rule.evaluate throws → caught → null, logged to stderr

**Adapter tests:**
- CC PreToolUse: deny → block JSON, escalate → ask JSON, context → additionalContext JSON, null → exit 0
- CC PostToolUse: deny → exit 2 + stderr, escalate → degrades to additionalContext, context → additionalContext
- Empty stdin → handleError → exit 0
- Malformed JSON → exit 0

**Integration tests:**
- Full pipeline: echo JSON | compiled binary | validate stdout
- Per qsm-marketplace hook pattern: one integration test per existing hook script behavior

**Regression:**
- Port ai-guardrails test suite (120+ tests) to use hook-kit evaluate()
- All must pass with identical semantics

## Operational Readiness

**Observability:**
- `--verbose` flag on compiled binary → logs to stderr: modules evaluated, rules matched, final decision, timing
- Each decision can carry a `label` field (e.g., "[pr-review]") for identifying which module produced it
- State store contents inspectable: `cat /tmp/hook-kit-repetition-{sessionId}.json`

**Failure modes:**
- shell-ast WASM fails to load → all command rules return null (silent), stderr warning
- tmpdir write fails (disk full) → state not persisted, hook returns null (silent)
- Rule throws → caught by engine → null (silent), error logged to stderr
- Stdin timeout/empty → adapter exits 0 (silent)
- Binary not found (deleted/moved) → CC treats missing hook as pass-through (CC default behavior)

**Deployment:**
- Each plugin's binary is committed to the plugin directory (e.g., `plugins/pr-review/dist/hooks`)
- `bun install && hook-kit build` in CI rebuilds all binaries
- hooks.json points to `${CLAUDE_PLUGIN_ROOT}/dist/hooks` — portable via CC env var
- Version pinned in plugin's package.json: `"@questi0nm4rk/hook-kit": "^1.0.0"`

**Rollback:**
- If a compiled binary breaks: delete it, restore old `npx tsx` hook in hooks.json
- Old hook-runtime.ts scripts stay in git history, recoverable via `git checkout`
- Per-plugin binaries mean one broken plugin doesn't affect others

## Explicit Trade-offs

| Chose | Over | Because |
|-------|------|---------|
| Per-plugin binaries | One monolithic binary | Plugin isolation — pr-review can ship without touching memory. Monolithic would couple all 9 plugins' release cycles. Cost: N binary files instead of 1. |
| Variadic `cmd(command, ...sub)` | Named `sub` parameter or array | Variadic is most natural TypeScript API and covers both ai-guardrails (1 sub) and qsm (multi-level). Named `sub` only handles 1 level; array syntax (`cmd("gh", ["pr", "view"])`) adds visual noise for the common case. |
| tmpdir JSON state | SQLite or in-memory only | tmpdir is the simplest persistence that survives process restarts within a session. SQLite adds a dependency. Memory-only loses state between invocations (the whole point of stateful rules). tmpdir JSON is what repetition-inspector already uses. |
| Fail open (silent) on all errors | Fail closed (deny) | A hook framework bug blocking a developer is worse than a missed rule. Security-critical rules should use CC's deny permissions list (settings.json `permissions.deny`), not hooks. |
| Protocol-agnostic core | CC-only | Future-proofing. Cursor/Windsurf/Aider all likely to add hooks. The adapter layer is ~50 lines. The cost of abstraction is minimal; the cost of rewriting rules for each agent is high. |
| Rules as objects with evaluate() | Rules as plain data (ai-guardrails pattern) | Objects with evaluate() support custom(), stateful(), and content() rules through one interface. Plain data requires the engine to know every rule type. Trade-off: engine can't introspect rules for reporting — but reporting is an ai-guardrails concern, not hook-kit's. |
| Direct shell-ast dep (bundled) | Peer dep | Peer deps cause version mismatches in monorepos. Direct dep ensures WASM is always bundled correctly. Both consumers already use shell-ast so no duplication. |

## Evolution

### When to revisit this spec
- CC hook protocol changes (new event types, new output fields) → update adapter + add events to HookEvent type
- New AI agent adds hook support (Cursor, Windsurf) → implement new adapter, validate core types are sufficient
- shell-ast major version bump → verify resolveFlags() contract, update <dynamic> documentation
- Rule count per binary exceeds 50 → benchmark startup, consider rule-tree optimization
- Bun compile breaks → activate esbuild fallback path, document in SPEC addendum

### Versioning
- hook-kit follows semver. Breaking: Decision type changes, Rule.evaluate signature changes, engine behavior changes
- Non-breaking: new builders, new adapters, new state stores
- Compiled binaries pin to `^major.minor` — patch updates are safe

## Cross-References

| Document | Relationship |
|----------|-------------|
| ai-guardrails `src/check/engine.ts` | Source of evaluation logic being ported to hook-kit engine |
| ai-guardrails `src/check/types.ts` | CallRule/PipeRule/PathRule types that hook-kit's Rule interface supersedes |
| ai-guardrails `src/check/engine-helpers.ts` | Redirect/pipe/inline-script detection ported to hook-kit helpers |
| qsm-marketplace `plugins/*/lib/hook-runtime.ts` | 7 runtime copies that hook-kit's CC adapter replaces |
| qsm-marketplace `plugins/*/hooks/hooks.json` | Hook registration format that hook-kit build generates |
| `@questi0nm4rk/shell-ast` README | Shell AST API: parse(), findCalls(), resolveFlags(), walk() |
| CC hook protocol (skill-tooling/hook-patterns.md) | 18 hook events, stdin/stdout schemas, exit code semantics |

## Decisions Register

| # | Decision | WHY | Change trigger |
|---|----------|-----|----------------|
| D1 | Protocol-agnostic core | Support future agents (Cursor, Windsurf) without rewriting rules | IF only CC is ever used → simplify by removing adapter layer |
| D2 | Per-plugin binaries | Plugin isolation: each iterates independently | IF startup overhead of N binaries > one binary → consolidate |
| D3 | Variadic cmd() builder: `cmd(command, ...sub)` | Covers both ai-guardrails (1 sub) and qsm (multi-level subs) | IF shell grammar evolves beyond flat subcommands → revisit |
| D4 | tmpdir JSON for state | Simplest persistence, matches existing repetition-inspector | IF concurrent agents break state → implement flock or memory-only |
| D5 | shell-ast as direct dep | Ensures WASM bundled correctly | IF shell-ast breaks → vendor the WASM binary |
| D6 | Both compiled + runtime extensibility | Compiled for performance, runtime --plugins-dir for iteration | IF nobody uses runtime mode → remove to reduce attack surface |
| D7 | New standalone repo (Questi0nM4rk/hook-kit) | Independent versioning, own CI, no coupling to consumers | IF coordination overhead is too high → merge into ai-guardrails |
| D8 | Edit is Write-adjacent for path rules | .onWrite() matches both Write and Edit tools | IF CC adds more file-mutation tools → add .onMutate() alias |
| D9 | Fail open (silent) on all infrastructure errors | Hook bugs must never block developers | IF security-critical rules need fail-closed → add .failClosed() option per module |
| D10 | Rule ordering is array order (API contract) | Deterministic, debuggable, no implicit priority | IF rule count grows past 100 → consider priority-based evaluation |
| D11 | Blacklist semantics (no explicit "allow") | One block wins regardless of other hooks. Matches CC behavior: hooks either block or stay silent. | IF a protocol needs explicit allow (whitelist) → add as adapter option |
| D12 | content() is PostToolUse-only, reads file from disk | Edit already applied at PostToolUse. No need for oldStr/newStr reconstruction. | IF PreToolUse content validation needed → add preContent() builder |
| D13 | argMatches/argIncludes search all resolved args (including flag values) | Needed for patterns like `event=COMMENT`. Quoted strings become `<dynamic>` so flag body text never matches accidentally. | IF shell-ast changes <dynamic> behavior → add positionalArgMatches() |
| D14 | Sequential rule evaluation (await each) | State mutations visible to next rule. No race conditions. No parallel evaluation. | IF performance requires parallel → add opt-in `parallel: true` per module |
