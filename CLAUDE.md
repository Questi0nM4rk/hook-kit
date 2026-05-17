# CLAUDE.md

Guidance for Claude Code working in this repo.

## What This Is

hook-kit: agent-agnostic shell-wrapper hook binaries. A TypeScript SDK that lets *consumers* compose shell-AST-aware rules from a small set of **builder primitives**, then compile the result into a standalone Bun bytecode binary. The default binary (`hk`) substitutes for `bash -c` and surfaces decisions through stdout/stderr/exit-code — no JSON wire protocol, no harness coupling. Optional adapter bins (currently `cc-tools` for Claude Code's `Edit`/`Write`/`Read` events) extend coverage to non-shell tool channels.

**Spec:** `docs/SPEC.md` — single living document. All architectural truth lives there; this file is orientation only.

## Architecture (rule-free by design)

hook-kit ships **infrastructure + primitives**, NOT a rule library. The split:

| What hook-kit ships | What consumers ship |
|---|---|
| Builder primitives (`cmd`, `path`, `pipe`, `redirect`, `content`, `custom`, `stateful`) | Their own rule set composed from those primitives |
| Decision vocabulary (`deny`, `ask`, `warning`, `note`) | Policy: when each verb fires |
| Engine (`evaluate`, inline-shell recursion, merge policy, error annotations) | The hook module(s) registered with the engine |
| Execution surfaces (`runShell` wrapper + `cc-tools` adapter) | Build invocation (`hook-kit build src/hooks.ts --out dist/hk`) |
| Escalation infrastructure (`askpass` / broker / spool tree / TUI) | When to call `.ask()` and how to wire `HOOK_KIT_ASKPASS` |
| Typed errors (8 `HookKitError` subclasses, `error` annotation kind) | None (engine catches and annotates) |

**No pre-built rule list exists in `src/`.** `src/builders/` (renamed from `src/rules/` in 0.5.1 to remove the ambiguity) holds *primitives*, not opinions. `examples/ai-guardrails/src/hooks.ts` is the reference for how a downstream consumer composes them into a real rule set.

## Commands

```bash
bun install                       # deps
bun test                          # quick: regular suite only (skips tests-isolated/)
bun run test                      # full suite — tests/ then tests-isolated/ (use for CI parity)
bun test tests/engine             # tests in a directory
bun test --grep "short"           # filter by name
bun run typecheck                 # tsc --noEmit (tsgo not installed locally yet)
bun run lint                      # biome check src/ tests/ tests-isolated/
bun run lint:fix                  # biome check --write src/ tests/ tests-isolated/
bun run build                     # build dist/types (used by prepublishOnly)
bun run build:bin                 # compile dist/hook-kit binary
```

## Module Layout

```
src/version.ts    VERSION (single source of truth, sourced from package.json)
src/core/         types, decision constructors, event helpers, createModule()
src/builders/     cmd(), path(), pipe(), redirect(), content(), custom(), stateful()
                  — primitives; no pre-built rules ship
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

| Outcome | Exit | Stream | Content |
|---|---|---|---|
| no terminal, no annotations | 0 | — | silent, then exec the command verbatim |
| no terminal, annotations only | exec's exit | stdout | `<prefix> warning: <msg>` / `<prefix> note: <msg>` per annotation, then `---` separator, then exec output below |
| `ask` (annotations bundled) | 1 | stdout | `<prefix> needs review: <reason>` + each accumulated annotation line |
| `deny` (annotations DROPPED) | 2 | stderr | `<prefix> denied: <reason>` |

`<prefix>` = decision label (e.g. `[my-plugin]`) when set, `[hook-kit]` otherwise. Merge policy: deny short-circuits + drops warning/note (error annotations always survive), ask keeps collecting annotations (first ask wins terminal), warning/note always accumulate.

## Dependencies & Conventions

- `@questi0nm4rk/shell-ast` ^0.5.1 — local source at `~/Projects/shell-ast`, repo `Questi0nM4rk/shell-ast`. Surface used: `parse` → `findCalls` → `unwrapCall` (sudo-aware discriminated `UnwrappedCall`) / `findRedirects` / `effectOf` / `isResolved` / `wordToLit`. 0.5 adds query helpers (`tokenAfter`, `tokensAfter`, `hasFlag`-on-`CallExpr`, `flagValues`, `resolvedCmd`) + `ResolveFlagsOptions.globalFlags` — not yet adopted; planned for 0.6.0. File consumer pain at `~/Projects/shell-ast/docs/BUGS.md`.
- `bun` — runtime, test runner, binary compiler (`bun build --compile --bytecode`).
- `tsc --noEmit` typecheck via `bun run typecheck`. CLAUDE.md preference is for `tsgo` (TypeScript 7 native) but it's not installed on this machine; `tsc` is the working path.
- `biome check --reporter=rdjson` — never `--reporter=json`.
- Version: bump `package.json` only. `src/version.ts` reads from it via JSON import attribute at compile time; CLI / wrapper pick it up automatically.
- Direct commits to main are blocked by lefthook in some downstream repos (e.g. ai-guardrails). hook-kit itself allows main commits — keep PRs / branches when working across both.
- `ask` semantics (DSL verb; routes through the escalation infrastructure): `HOOK_KIT_ASKPASS` unset → falls through to harness-ask (CC ask JSON / shell-wrapper exit-1 stdout). Set + broken → deny. Set + working broker → routes through the spool tree.
- `recurseInlineShells` defaults on. `bash -c "rm -rf /"` triggers the same `cmd("rm")` rule as the bare command.
- **0-silent-fails:** Every internal failure path constructs a typed `HookKitError` (8 subclasses in `src/core/errors.ts`) and surfaces as either an `error` annotation (engine boundary, fail-open) or stderr line + synthesized deny (security boundary, fail-closed). Best-effort I/O sites emit-and-continue. NEVER add `catch {}` / `?? undefined` / silent `return null` patterns that hide a failure.

## Testing

The npm `test` script runs two `bun test` invocations:

```bash
bun test tests/ && bun test tests-isolated/
```

- `tests/` — the regular suite (~420 unit + integration tests).
- `tests-isolated/` — tests that need `mock.module()` for module-level mocks. Bun's `mock.module()` is process-sticky across files (oven-sh/bun#14516) and would poison sibling tests in the regular suite. The split keeps each isolated test file its own `bun test` process. **Don't add `mock.module()` to anything under `tests/` — put it under `tests-isolated/` instead.**
- `tests/builders/` — one file per builder primitive (renamed from `tests/rules/` in 0.5.1).
- CI (`.github/workflows/test.yml`) and `prepublishOnly` both call `bun run test`, not raw `bun test` — preserves the isolation. Don't regress that.

Canonical end-to-end tests under `tests/build/`:
- `example-ai-guardrails.test.ts` — compiles `examples/ai-guardrails/` into `dist/hk` and exercises rule firings against the real binary.
- `adversarial.test.ts` — 50+ adversarial inputs against the compiled binary (alias expansion, sudo unwrap, inline-shell recursion, redirects, edge cases).
- `warning-annotation.test.ts` — annotation rendering contract: `[label] warning: <msg>` lines + `---` separator + exec output.

Add similar coverage when introducing new builder primitives or wrapper behaviors.

## Examples

`examples/ai-guardrails/` — faithful port of the original ai-guardrails project. One source tree, two builds (`dist/hk` + `dist/hk-cc-tools`). README walks through the composed rule set and integration. Treat it as the reference implementation for new consumers — and as the smoke-test target (`tests/build/example-ai-guardrails.test.ts` builds it as part of CI).

## Roadmap (0.6.0 — breaking)

The next minor lands a coordinated set of shell-ast 0.5 adoption + SDK ergonomics. Three workstreams:

**A. Builder primitives get shell-ast 0.5's power**
- **Default basename match.** `cmd("git")` fires on `/usr/bin/git`, `./bin/git`, etc. by default (uses shell-ast's `resolvedCmd(call)`). Opt-out via `.strictPath()` if anyone needs the old behavior. Breaking — semver minor.
- **`.flagValueMatches(flag, /pattern/)` / `.flagValueEquals(flag, value)` on `cmd()`.** Inspect the VALUE of a flag, not just its presence. Backed by shell-ast 0.5's `flagValues` on `ResolvedCall`. Unlocks deny patterns like `gcc -o /etc/passwd`, `dd of=/dev/sda`, `docker --user=root`, `git commit -F /tmp/secret`, `curl -o /etc/hosts`. Pure addition.
- **`findRedirects(ast, {depth: "top"})` in `redirect()`.** Skip in-subshell redirects (`echo $(other > /tmp/x)`) which can't actually escape to outer scope. Semantic tightening; opt-out via `.includeSubshells()`.
- **Expose `ResolveFlagsOptions.globalFlags` through `evaluate()` / `runShell()`.** Let downstream consumers register their own value-taking-flag tables (`terraform: ["-chdir"]`, etc.) without waiting on shell-ast releases.

**B. Test-builders SDK (the headline ergonomics improvement)**
A first-class fluent test DSL exported from `@questi0nm4rk/hook-kit/testing`, so consumers don't have to hand-roll synthetic events / mock state stores / mock askpass scripts. Working sketch (subject to design):

```ts
import { expectModule, mockState, mockAskpass } from "@questi0nm4rk/hook-kit/testing";

expectModule(myModule)
  .onCommand("gcc -o /etc/passwd src.c")
  .toDeny(/system file/);

expectModule(myModule)
  .onCommand("rm -rf /tmp/x")
  .withState(mockState({ "deletions:count": 5 }))
  .toWarn(/quota/);

expectModule(myModule)
  .onCommand("git push --force")
  .withAskpass(mockAskpass({ decision: "allow" }))
  .toRun();
```

Surface includes: `expectModule` / `expectRule` fluent runner, `bashEvent` / `editEvent` / `writeEvent` event factories, `mockState` / `mockAskpass` factories, terminal/annotation assertions. Lives in `src/testing/` and exports via `package.json` `"./testing"` subpath. Keeps current `runModule` + `evaluateRule` as low-level escape hatches.

**C. Rename + docs (landed in 0.5.1)**
- `src/rules/` → `src/builders/`; `tests/rules/` → `tests/builders/`. Internal-only rename — no public-API change.
- README + SPEC clarify the rule-free split (hook-kit ships primitives, consumers ship rules).

When you're working in this repo and a 0.6.0-tagged item is in scope, surface it explicitly so the user can scope the work.
