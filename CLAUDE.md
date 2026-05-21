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

```text
src/version.ts    VERSION (single source of truth, sourced from package.json)
src/core/         types, decision constructors, event helpers, createModule()
src/builders/     cmd(), path(), pipe(), redirect(), content(), custom(), stateful()
                  — primitives; no pre-built rules ship
src/engine/       evaluate() loop + helpers (flag aliases, inline-shell extraction)
src/wrapper/      hk.ts — runShell() (the v0.3 default for compiled binaries)
src/adapters/     ProtocolAdapter: claude-code (cc-tools), raw
src/state/        StateStore: memory-store, tmpdir-store
src/escalation/   askpass, broker, envelope, forward, listeners, watch-tui, enrich-git
src/testing/      0.7+ test-builders SDK: expectModule, mockState, mockAskpass,
                  event factories — exported via `./testing` subpath
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

- `@questi0nm4rk/shell-ast` ^0.7.0 — local source at `~/Projects/shell-ast`, repo `Questi0nM4rk/shell-ast`. Surface used: `parse` → `findCalls` → `unwrapCall(call, opts)` (sudo-aware discriminated `UnwrappedCall`, `flagValues` and `innerRaw` on `.wrapped`) / `unwrapDeepParsed(call, parse, opts)` (0.7+ — walks the full wrapper chain outermost-first through `bash -c '…'` boundaries; used by the engine's inline-shell recursion to close the `sudo bash -c '…'` chained-wrapper case) / `findRedirects` / `effectOf` / `isResolved` / `wordToLit` / `tokensAfter(u, flag)` (polymorphic — dispatches to `innerRaw` for wrapped, `raw` for plain) / `resolvedCmd(u)` (basename normalization). `ResolveFlagsOptions.globalFlags` exposed through hook-kit's `EvaluateOptions.shellAstOpts`. File consumer pain as GH issues on the shell-ast repo (their autonomous agent polls every 15 min; `docs/BUGS.md` is their internal catalog only, doesn't trigger work).
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

## What 0.6.0 landed (workstream A — shipped)

Three coordinated builder-primitive upgrades adopting shell-ast 0.6's polymorphic lens:

- **Default basename match on `cmd()`.** `cmd("git")` fires on `/usr/bin/git`, `./bin/git`, `sudo /usr/bin/rm`, `/usr/bin/bash -c "..."`, etc. by default. Backed by shell-ast's polymorphic `resolvedCmd(u)` in `engine/helpers.ts:unwrappedName`. Breaking change from 0.5.x's strict-path default. Opt-out: `cmd("/usr/bin/git").strictPath()` for vendored-binary policies.
- **`.flagValueMatches(flag, /regex/)` and `.flagValueEquals(flag, value)` on `cmd()`.** Inspect the VALUE of a flag, not just its presence. Uses shell-ast 0.6's polymorphic `tokensAfter(u, flag)` which auto-dispatches to `u.innerRaw` for wrapped variants, so `cmd("gcc").flagValueMatches("-o", /^\/etc/)` fires on bare `gcc`, `sudo gcc`, and `bash -c "gcc ..."` invocations uniformly. Both `=` form (`--output=/tmp/x`) and space form (`-o /tmp/x`) captured. Multiple flagValue* calls stack with AND semantics; repeated occurrences of the same flag use ANY-match. Dynamic values (`-o $VAR`) skip silently — compose `.custom()` for block-on-uncertainty.
- **`EvaluateOptions.shellAstOpts.globalFlags` pass-through.** Lets downstream consumers register per-tool value-taking flags (`{terraform: ["-chdir"], kustomize: ["--load-restrictor"]}`) so commands like `terraform -chdir ./infra apply` resolve `apply` as `args[0]` instead of being shifted by the unconsumed `-chdir`. Threaded through `RunModuleOptions` / `RunShellOptions` / `RunOptions` (all extend `EvaluateOptions`) into every `unwrapCall(call, opts)` site — both the inline-shell recursion and the `cmd()` builder.

A3 (`findRedirects({depth: "top"})` as default) was **deliberately dropped** — subshell redirects DO touch the filesystem (`result=$(echo evil > /etc/passwd)` actually overwrites `/etc/passwd`), so switching to top-only would create a silent deny-bypass. Current `depth: "any"` default is correct for filesystem-write security rules.

## What 0.7.0 landed (workstream B — shipped)

**Test-builders SDK** as a first-class subpath export `@questi0nm4rk/hook-kit/testing`. Consumers no longer hand-roll synthetic events / mock state stores / mock askpass scripts.

```ts
import {
  expectModule, expectRule,
  bashEvent, editEvent, writeEvent, readEvent,
  mockState, mockAskpass,
} from "@questi0nm4rk/hook-kit/testing";

// terminal assertions
await expectModule(myModule).onCommand("gcc -o /etc/passwd src.c").toDeny(/system file/);
await expectModule(myModule).onCommand("git push --force").toAsk(/confirm/);
await expectModule(myModule).onCommand("ls /tmp").toRun();

// annotation assertions
await expectModule(myModule).onCommand("rm /tmp/x").toWarn(/quota/);
await expectModule(myModule).onCommand("rm /tmp/x").toNote(/heads up/);

// chained setup (mockState, shellAstOpts, recursion override)
await expectModule(myModule)
  .withState(mockState({ "deletions:count": 5 }))
  .onCommand("rm -rf /tmp/x")
  .toWarn(/quota/);

await expectModule(myModule)
  .withShellAstOpts({ globalFlags: { terraform: ["-chdir"] } })
  .onCommand("terraform -chdir ./infra apply")
  .toDeny();

// non-Bash events
await expectModule(myModule).onWrite("/tmp/.env", "x=1").toDeny();
await expectModule(myModule).onEdit("/migrations/001.sql", "old", "new").toDeny();
await expectModule(myModule).onRead("/secrets.json").toDeny();

// askpass-mediated decisions
const askpass = mockAskpass({ decision: "allow" });
try {
  process.env.HOOK_KIT_ASKPASS = askpass.path;
  await expectModule(myModule).onCommand("git push --force").toRun();
} finally {
  askpass.cleanup();
}

// single-rule shortcut + outcome() escape hatch
await expectRule(cmd("rm").deny("blocked")).onCommand("rm /").toDeny();
const out = await expectModule(myModule).onCommand("rm /").outcome();
```

Surface lives in `src/testing/` and exports via `package.json` `"./testing"` subpath. `runModule` + `evaluateRule` remain in the main barrel as low-level escape hatches; the testing SDK is the ergonomic primary lens for rule tests.

Coverage: `tests/testing/` has 51 cases (10 events, 9 mock-state, 9 mock-askpass via real `callAskpass` integration, 23 expect). Exercises actual builders (cmd, path, redirect, stateful) end-to-end through the engine — not against a mock — so divergence between SDK behavior and production behavior surfaces in CI.
