# CLAUDE.md

Guidance for Claude Code working in this repo.

## What This Is

hook-kit: harness-agnostic framework for building compiled hook binaries for AI coding agents. TypeScript hook definitions → standalone Bun bytecode binaries with shell-AST-aware rule matching, askpass-based escalation, per-plugin isolation.

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
bun run build                     # compile CLI binary
```

## Module Layout

```
src/core/         types, decision constructors, event helpers, createModule()
src/rules/        cmd(), path(), content(), custom(), stateful() builders
src/engine/       evaluate() loop + helpers (flag aliases, redirect/pipe)
src/adapters/     ProtocolAdapter: claude-code, raw
src/state/        StateStore: memory-store, tmpdir-store
src/escalation/   askpass.ts, broker.ts, envelope.ts
src/build/        hook-kit CLI: build, broker, watch, subscribe, decide, list
```

## Consumption Modes

- **Binary:** `hook-kit build src/hooks.ts --out dist/my-hooks --adapter claude-code` per plugin.
- **Library:** import engine + builders directly; bring your own adapter.

## Dependencies & Conventions

- `@questi0nm4rk/shell-ast` — local source at `~/Projects/shell-ast`, repo `Questi0nM4rk/shell-ast`. API: `parse → findCalls → resolveFlags` / `unwrapCall` (sudo-aware). File issues there for bugs/features.
- `bun` — runtime, test runner, binary compiler (`bun build --compile --bytecode`).
- `tsgo --noEmit` — TypeScript 7 native typechecker (not `tsc`).
- `biome check --reporter=rdjson` — never `--reporter=json`.
- `escalate` resolves via askpass before output. Infra failure = explicit deny, never silent-allow.
