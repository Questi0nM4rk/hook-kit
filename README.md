# hook-kit

> Build compiled hook binaries for AI coding agents. Harness-agnostic, tree-shaped escalation, sub-50ms cold start.

`hook-kit` is a TypeScript framework for shipping the hooks an AI coding agent runs before, during, and after every tool call. Write rules as data, compile to a single Bun binary, and the agent gets a deterministic guardrail with no per-invocation `tsx` startup cost.

```typescript
import { createModule, cmd, path } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "block-force-push", name: "Block force push", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      cmd("git", "push")
        .withFlag("--force")
        .withoutFlag("--force-with-lease")
        .deny("Use --force-with-lease, not raw --force"),
    ],
  ),
  createModule(
    { id: "protect-generated", name: "Protect generated", events: ["PreToolUse"], matchers: ["Edit", "Write"] },
    [path(/\.g\.cs$/).onWrite().deny("Edit the generator, not the output")],
  ),
];
```

```bash
hook-kit build src/hooks.ts --out dist/hooks --hooks-json hooks.json --hook-timeout 5
```

That's it. The binary is now `${CLAUDE_PLUGIN_ROOT}/dist/hooks` and `hooks.json` wires it into Claude Code.

---

## Why

AI agents fire hooks on every tool call. Today every plugin reinvents stdin reading, shell-AST parsing, decision serialization, and pays per-invocation `npx tsx` startup costs (~1 second). `hook-kit` does the boilerplate once:

- **Rules as data, not scripts.** `cmd("gh", "pr", "comment").deny("…")` — testable without process spawning, composable across modules, inspectable for reporting.
- **Parse once, evaluate many.** shell-AST WASM init is ~200ms. The AST is parsed once per invocation and shared across all `cmd()` rules.
- **Fail open on infra errors.** A hook framework bug should never block a developer. State store disk full → silent. JSON parse error → silent. Rule throws → silent. The only exception is escalate-with-no-responder.
- **Blacklist semantics.** No `allow` decision exists. A hook either blocks or stays silent.
- **Tree-shaped escalation.** When a rule needs human input, the request flows up a `parent_session_id` tree until a listener answers — or reaches the harness's native UI as the implicit root parent.
- **One binary per plugin.** `bun build --compile` produces a single ~50MB executable. No runtime deps, no toolchain shipped to your users.

---

## Install

```bash
bun add @questi0nm4rk/hook-kit
```

Requires Bun ≥ 1.2 (used as runtime, test runner, and binary compiler).

---

## Quick start

A minimal plugin from scratch:

```typescript
// my-plugin/src/hooks.ts
import { createModule, cmd, path, content, deny, context } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    {
      id: "force-push",
      name: "Block force push without --force-with-lease",
      events: ["PreToolUse"],
      matchers: ["Bash"],
    },
    [
      cmd("git", "push")
        .withFlag("--force")
        .withoutFlag("--force-with-lease")
        .deny("Use --force-with-lease, not raw --force"),
    ],
  ),
  createModule(
    {
      id: "protect-env",
      name: "Don't read .env files",
      events: ["PreToolUse"],
      matchers: ["Read"],
    },
    [path(/\.env(\.|$)/).onRead().deny("Don't read environment files")],
  ),
  createModule(
    {
      id: "validate-design-docs",
      name: "Design doc section coverage",
      events: ["PostToolUse"],
      matchers: ["Write", "Edit"],
    },
    [
      content()
        .matchPath(/design\/.*\.md$/)
        .validate((_filePath, body) => {
          const required = [/##\s*Problem/i, /##\s*Decision/i, /##\s*Trade-off/i];
          const missing = required.filter((r) => !r.test(body));
          if (missing.length === 0) return null;
          return context(`Design doc missing sections: ${missing.length} required`);
        }),
    ],
  ),
];
```

Compile and wire it up:

```bash
hook-kit build src/hooks.ts \
  --out dist/hooks \
  --hooks-json hooks/hooks.json \
  --hook-timeout 5
```

Drop the plugin into `~/.claude/plugins/my-plugin/` and you're done. The binary cold-starts in <50ms; CC fires the right rules per event.

---

## Concepts

### Decisions (blacklist semantics)

A rule returns one of four values. There is no `allow` — silent = nothing was wrong.

| Decision | Effect |
|----------|--------|
| `null` | Silent pass-through |
| `deny(reason, label?)` | Hard block with a reason |
| `context(message, label?)` | Inject an info message into the agent's conversation; doesn't block |
| `escalate(reason, label?)` | Ask up the parent tree (see [Escalation](#escalation)) |

### Iron Laws

The seven invariants the framework enforces. The full version lives in [`docs/SPEC.md`](docs/SPEC.md). The load-bearing summary:

1. **Rules are data, not scripts.**
2. **Parse once, evaluate many** — one shell-AST per invocation, shared across all `cmd()` rules.
3. **Fail open on infra errors** (with one exception: `escalate` with no responder denies, never silent-allows).
4. **Blacklist semantics** — only `deny`, `context`, `escalate`, or `null`.
5. **Protocol adapter owns serialization** — swapping harnesses changes one file.
6. **Each plugin compiles its own binary** — plugin isolation; one plugin's iteration doesn't disturb the others.
7. **Escalation is async, tree-shaped, out-of-band** — see below.

---

## Rule builders

### `cmd(command, ...subcommands)` — shell-AST aware command matching

```typescript
cmd("rm").withFlag("-r").withFlag("-f").deny("No recursive rm");

cmd("git", "push")
  .withFlag("--force")
  .withoutFlag("--force-with-lease")
  .deny("Use --force-with-lease");

cmd("gh", "api")
  .argMatches(/\/pulls\/\d+\/reviews/)
  .deny("Use the pr-review CLI for review operations");

cmd("gh", "api", "graphql")
  .withFlag("--field")
  .argMatches(/event=COMMENT/)
  .deny("Strict review forbids COMMENT-event reviews");
```

- **Variadic subcommands** match by position: `cmd("gh", "pr", "comment")` checks `args[0] == "pr" && args[1] == "comment"`.
- **`.withFlag("...")`** is alias-aware: `-r`, `-R`, and `--recursive` are interchangeable. Compound shorts like `-D` expand to `--delete + --force`.
- **`.argMatches(/regex/)`** searches all resolved args (including flag values like `event=COMMENT` from `--field event=COMMENT`). Quoted strings (`"…"`/`'…'`) become `<dynamic>` in shell-ast and never match — your rules can't accidentally fire on the contents of a `--body "secret"`.
- **`unwrapCall`** strips `sudo`/`doas`/`run0`/`su` automatically: `cmd("rm")` matches `sudo -u root rm /etc/passwd`.

### `path(pattern)` — file-path matching

```typescript
path(/\.generated\.cs$/).onWrite().deny("Edit the generator, not the output");
path(/[/\\](obj|bin)[/\\]/).onWrite().deny("Build artifact, not source");
path(/\.env(\.|$)/).onRead().deny("Don't read environment files");
```

`onWrite()` matches `Write` + `Edit` + `NotebookEdit`. `onRead()` matches `Read`. Default (no chain) covers both.

### `content()` — PostToolUse body inspection from disk

```typescript
content()
  .matchPath(/design\/.*\.md$/)
  .validate((filePath, body) => {
    const missing = REQUIRED_SECTIONS.filter((s) => !s.test(body));
    if (missing.length > 0) return context(`Missing: ${missing.join(", ")}`);
    return null;
  });
```

Runs only on `PostToolUse` (the file is on disk after the tool ran). The validator returns a `Decision` and is `async`-friendly.

### `stateful(id, fn)` — cross-invocation state

```typescript
stateful("repetition", (event, state) => {
  const key = `cmd:${(event.toolInput.command as string) ?? ""}`;
  const count = ((state.get(key) as number) ?? 0) + 1;
  state.set(key, count);
  if (count > 3) return context(`Repeated ${count}× — break the loop?`);
  return null;
});
```

State persists across hook invocations within a session via the `TmpdirStore` (default) or any custom `StateStore` implementation.

### `custom(id, fn)` — escape hatch

```typescript
custom("session-summary", async (event) => {
  // arbitrary logic; throws are caught and treated as null (Iron Law 3)
  return null;
});
```

---

## Escalation

When a rule returns `escalate`, the binary blocks waiting for a decision from somewhere up the parent tree:

```
[ root: harness UI (CC's native ask) ]
            |
[ agent session ]
        |- [ subagent A ]
        |       |- [ sub-subagent ]
        |- [ subagent B ]
```

A request publishes at the hook's own session spool. A listener attached to that session — or any ancestor session up the chain — sees it. If no live listener exists anywhere, the broker denies immediately with `[hook-kit] NO PARENT ATTACHED`. If a listener doesn't want to decide, it forwards via `--escalate-up` to the next level. When the chain exhausts at the root, it terminates at `harness-ask` — Claude Code emits its native `permissionDecision: "ask"` and the user UI takes over with no timeout.

### The askpass contract

`hook-kit` calls whatever `$HOOK_KIT_ASKPASS` points at. The bundled default is `hook-kit broker --askpass`, which manages per-session ask channels at `~/.cache/hook-kit/sessions/$SESSION_ID/`:

```
sessions/abc-123/
├── meta.json            # {parent_session_id?, started_at, pid}
├── pending/<id>.json    # the envelope
├── decided/<id>.json    # the decision (first-writer-wins via O_EXCL)
├── listeners/<pid>.lock # liveness markers — one per attached listener
└── audit.jsonl          # append-only event log
```

Any program that reads JSON on stdin and writes a decision to stdout is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, the bundled broker.

### Listening with the TUI

```bash
hook-kit watch                         # all sessions on this host
hook-kit watch --children-of $MY_ID    # only descendants of a session you spawn
hook-kit watch --session abc-123       # one specific session
```

```
hook-kit watch                                3 pending  ·  1 listener attached

  SESSION             REQ-ID      AGE   TOOL      DETAILS
❯ abc-123             7f8a2b…     12s   Bash      git push --force origin main
  abc-123             3c4d5e…      3s   Write     /tmp/output.cs
  def-456             8b9c0a…      1m   Bash      rm -rf /tmp/scratch

↑↓/jk select  ·  allow  ·  deny  ·  escalate-up  ·  quit
```

Press `a` / `d` / `e` and the screen drops into a reason prompt; type the reason, hit `Enter` to submit, `Esc` to cancel.

### Listening programmatically

```bash
hook-kit subscribe --children-of $MY_SESSION_ID --json | while read req; do
  ID=$(jq -r .id <<<"$req")
  SESSION=$(jq -r .sessionId <<<"$req")
  hook-kit decide "$ID" --session "$SESSION" --allow --reason "in scope"
done
```

Or forward the question up the tree without deciding:

```bash
hook-kit decide "$ID" --session "$SESSION" --escalate-up
```

The forwarder is synchronous: it republishes the envelope at the parent's spool, polls the parent's `decided/`, and copies the answer back down to the source so the original hook unblocks.

### Hook timeout

`hook-kit` does not enforce a timeout on its own — the broker polls forever, the askpass call waits forever, the forwarder waits forever. The only ceiling is Claude Code's `hooks.json` per-hook timeout, which is **required** when you generate `hooks.json`. There's no default — pick deliberately:

```bash
hook-kit build … --hook-timeout 5      # plugins without escalate rules
hook-kit build … --hook-timeout 3600   # plugins where escalate may need a human
```

---

## CLI reference

```
hook-kit build <entrypoint> --out <path> [--adapter claude-code]
                            [--hooks-json <path>] [--binary-command <s>]
                            [--hook-timeout <seconds>]

hook-kit broker --askpass                  # the bundled default $HOOK_KIT_ASKPASS

hook-kit list [--children-of <id>] [--json]
hook-kit watch [--session <id>] [--children-of <id>] [--poll-ms <n>]
hook-kit subscribe [--session <id>] [--children-of <id>] [--poll-ms <n>] --json
hook-kit decide <request_id> --session <id>
                --allow | --deny | --escalate-up
                [--reason <text>] [--by <name>]

hook-kit --help
hook-kit --version
```

---

## Library mode

For consumers that want the engine and builders without the compiled-binary workflow (e.g., wrapping into an existing CLI like `ai-guardrails`):

```typescript
import { evaluate, createModule, cmd, type HookEvent } from "@questi0nm4rk/hook-kit";

const modules = buildModulesFromConfig(myConfig);
const event: HookEvent = parseMyHookInput(stdin);
const decision = await evaluate(event, modules);
// Map decision to your own output format.
```

The `raw` adapter and `run()` entry point are exported for library consumers that want the full `read → evaluate → write` orchestration with their own I/O:

```typescript
import { rawAdapter, run, createModule, cmd } from "@questi0nm4rk/hook-kit";

const { adapter, state } = rawAdapter(myEvent);
await run(modules, adapter);
console.log(state.decision);
```

---

## Architecture

The full architecture lives in [`docs/SPEC.md`](docs/SPEC.md) — it's a single living document, no version markers, no migration plans. Iterate via commits.

```
src/
├── core/         types.ts, decision.ts, event.ts, module.ts
├── rules/        cmd(), path(), content(), custom(), stateful()
├── engine/       evaluate() loop + helpers (flag aliases, redirect/pipe)
├── adapters/     ProtocolAdapter: claude-code, raw
├── state/        StateStore: memory-store, tmpdir-store
├── escalation/   askpass, broker, envelope, forward, listeners, watch-tui
└── build/        hook-kit CLI: build, broker, watch, subscribe, decide, list
```

---

## Testing

`hook-kit` ships with 224 tests across 20 files covering rule builders, the engine, both adapters, the state stores, the entire escalation system (envelope schemas, askpass child-process invocation, broker spool atomicity, listener marker liveness, NO PARENT ATTACHED validator, escalate-up forwarding, the TUI render function), and a real compile + execute end-to-end smoke for the build CLI.

```bash
bun test                          # run everything (~2 seconds including binary builds)
bun test tests/escalation         # one directory
bun test --grep "shortCircuit"    # by name
```

---

## Status

Pre-release (`0.x`). The API is stable on the load-bearing surface — `cmd`/`path`/`content`/`custom`/`stateful`, the `Decision` shape, the engine contract, the askpass envelope, the broker spool layout. Smaller pieces (CLI flag names, the TUI keybindings) may shift before `1.0`.

Not yet published to npm — install from the local repo for now.

---

## License

MIT — see [LICENSE](LICENSE).
