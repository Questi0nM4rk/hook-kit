# CLAUDE.md

Guidance for Claude Code working in this repo.

## What This Is

hook-kit: agent-agnostic shell-wrapper hook binaries. TypeScript rule definitions → standalone Bun bytecode binaries with shell-AST-aware matching. The default binary (`hk`) substitutes for `bash -c` and surfaces decisions through stdout/stderr/exit-code — no JSON wire protocol, no harness coupling. Optional adapter bins (currently `cc-tools` for Claude Code's `Edit`/`Write`/`Read` events) extend coverage to non-shell tool channels.

**Spec:** `docs/SPEC.md` — single living document. All architectural truth lives there; this file is orientation only.

## Commands

```bash
bun install                       # deps
bun test                          # all tests
bun test tests/engine             # tests in a directory
bun test --grep "short"           # filter by name
tsgo --noEmit                     # typecheck (NOT tsc)
biome check src/ tests/           # lint+format
biome check --write src/ tests/   # auto-fix
bun run build                     # build dist/types (used by prepublishOnly)
```

## Module Layout

```
src/version.ts    VERSION (single source of truth, sourced from package.json)
src/core/         types, decision constructors, event helpers, createModule()
src/rules/        cmd(), path(), pipe(), redirect(), content(), custom(), stateful()
src/engine/       evaluate() loop + helpers (flag aliases, inline-shell extraction)
src/wrapper/      hk.ts — runShell() (the v0.3 default for compiled binaries)
src/adapters/     ProtocolAdapter: claude-code (cc-tools), raw
src/state/        StateStore: memory-store, tmpdir-store
src/escalation/   askpass, broker, envelope, forward, listeners, watch-tui, enrich-git
src/build/        hook-kit CLI: build, broker, watch, subscribe, decide, list
```

## Consumption Modes

- **Shell wrapper (default):** `hook-kit build src/hooks.ts --out dist/hk` (adapter defaults to `shell`). The compiled binary is `hk -c "<cmd>"`-shaped. Caller-agnostic.
- **CC tool-call adapter:** `hook-kit build src/hooks.ts --out dist/hk-cc-tools --adapter cc-tools`. For `Edit`/`Write`/`NotebookEdit`/`Read` events that bypass the shell. Use alongside the shell wrapper.
- **Library:** import `evaluate` + builders directly, OR `runShell(modules)` for in-process wrapper use.

## Output Convention (the contract for shell-wrapper mode)

| Decision | Exit | Stream | Content |
|---|---|---|---|
| `null` (no rule fired) | 0 | — | silent, then exec the command verbatim |
| `context` | 0 | — | silent (use cc-tools or library mode for context output) |
| `escalate` | 1 | stdout | `<prefix> needs review: <reason>` |
| `deny` | 2 | stderr | `<prefix> denied: <reason>` |

`<prefix>` = decision label (e.g. `[my-plugin]`) when set, `[hook-kit]` otherwise.

## Dependencies & Conventions

- `@questi0nm4rk/shell-ast` — local source at `~/Projects/shell-ast`, repo `Questi0nM4rk/shell-ast`. API: `parse → findCalls → resolveFlags` / `unwrapCall` (sudo-aware) / `walk` for BinaryCmd / Stmt traversal. File issues there for bugs/features.
- `bun` — runtime, test runner, binary compiler (`bun build --compile --bytecode`).
- `tsgo --noEmit` — TypeScript 7 native typechecker (not `tsc`).
- `biome check --reporter=rdjson` — never `--reporter=json`.
- Version: bump `package.json` only. `src/version.ts` reads from it via JSON import attribute at compile time; CLI / wrapper pick it up automatically.
- Direct commits to main are blocked by lefthook in some downstream repos (e.g. ai-guardrails). hook-kit itself allows main commits — keep PRs / branches when working across both.
- `escalate` semantics: `HOOK_KIT_ASKPASS` unset → falls through to harness-ask (CC ask JSON / shell-wrapper exit-1 stdout). Set + broken → deny. Set + working broker → routes through the spool tree.
- `recurseInlineShells` defaults on. `bash -c "rm -rf /"` triggers the same `cmd("rm")` rule as the bare command.

## Testing

`tests/build/example-ai-guardrails.test.ts` is the canonical end-to-end smoke — compiles the `examples/ai-guardrails/` plugin into `dist/hk` and exercises rule firings against the real binary. Add similar coverage when introducing new rule kinds or wrapper behaviors.

## Examples

`examples/ai-guardrails/` — faithful port of the original ai-guardrails project. One source tree, two builds (`dist/hk` + `dist/hk-cc-tools`). README walks through the rule list and integration. Treat it as the reference implementation for new consumers.
