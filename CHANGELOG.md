# Changelog

All notable changes to `@questi0nm4rk/hook-kit` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 minor bumps may include breaking changes (noted under **Breaking**).

## [Unreleased]

### Fixed
- Chained-wrapper coverage: `sudo bash -c '…'` (sudo at the outermost wrapper) now triggers the same rule pass as the symmetric `bash -c '…'`. Was tracked as shell-ast BUG-008 / [shell-ast#11](https://github.com/Questi0nM4rk/shell-ast/issues/11). The engine's `recurseInlineShells` block in `src/engine/index.ts` now walks shell-ast 0.7's `unwrapDeepParsed` chain and recurses on the first `wrapped-script` layer found anywhere in the chain — closing the asymmetry where the v0.6 one-level `unwrapCall` would only fire for bash-outermost shapes. Multi-level chains (`bash -c 'bash -c "..."'`) handled by the recursion's own walk + `MAX_RECURSE_DEPTH` cap. The previously-failing test in `tests/builders/deep-nesting.test.ts` is now `expect(out.terminal?.kind).toBe("deny")`.

### Changed
- Bumped `@questi0nm4rk/shell-ast` to `^0.7.0`.

## [0.7.0] — 2026-05-18

### Added
- Testing SDK at the `@questi0nm4rk/hook-kit/testing` subpath. Exports `expectModule`, `expectRule`, event factories (`bashEvent`, `editEvent`, `writeEvent`, `readEvent`), `mockState`, `mockAskpass`. Fluent assertions: `.toDeny(reason?)`, `.toAsk(reason?)`, `.toRun()`, `.toWarn(msg?)`, `.toNote(msg?)`, `.outcome()`. (#11)
- Chained setup on assertion builder: `.withState(mockState(...))`, `.withShellAstOpts({...})`, `.withRecurseInlineShells(false)`.

## [0.6.0] — 2026-05-18

### Breaking
- `cmd()` defaults to basename match. `cmd("git")` now fires on `/usr/bin/git`, `./bin/git`, `sudo /usr/bin/rm`, `/usr/bin/bash -c "..."` uniformly. Opt out with `.strictPath()` for vendored-binary policies.

### Added
- `.flagValueMatches(flag, /regex/)` and `.flagValueEquals(flag, value)` on `cmd()`. Polymorphic dispatch via shell-ast 0.6's `tokensAfter(u, flag)` — fires uniformly on bare, sudo-wrapped, and `bash -c`-wrapped invocations. Both `=` form (`--output=/tmp/x`) and space form (`-o /tmp/x`) captured. Multiple flagValue\* calls AND together; repeated occurrences of the same flag use ANY-match. Dynamic values (`-o $VAR`) skip silently — compose `.custom()` for block-on-uncertainty.
- `EvaluateOptions.shellAstOpts.globalFlags` pass-through. Register per-tool value-taking flags (e.g. `{terraform: ["-chdir"], kustomize: ["--load-restrictor"]}`) so `terraform -chdir ./infra apply` resolves `apply` as `args[0]` instead of being shifted by the un-consumed `-chdir`. Threaded through `RunModuleOptions` / `RunShellOptions` into every `unwrapCall(call, opts)` site.

### Changed
- Bumped `@questi0nm4rk/shell-ast` to `^0.6.0`.

## [0.5.1] — 2026-05-17

### Changed
- Bumped `@questi0nm4rk/shell-ast` to `^0.5.1`. Closes shell-ast BUG-000: global value-taking flag bypass (`git -C /tmp ...` and similar). (#9)
- Renamed `src/rules/` → `src/builders/` to reflect that hook-kit ships primitives, not pre-built rules.
- Test isolation: `mock.module()`-using tests moved to `tests-isolated/` and run as a separate `bun test` process. The npm `test` script is now `bun test tests/ && bun test tests-isolated/`; CI uses `bun run test`, not raw `bun test`.

## [0.5.0] — 2026-05-15

### Breaking
- Renamed `escalate` → `ask` everywhere — DSL verb, decision kind, envelope `kind`. Migrate `escalate(...)` rule calls to `ask(...)`.

### Added
- **Zero-silent-fails policy.** Every internal failure path constructs a typed `HookKitError` (8 subclasses in `src/core/errors.ts`) and surfaces as either an `error` annotation (engine boundary, fail-open) or stderr line + synthesized deny (security boundary, fail-closed). Per-site fail-open vs fail-closed policy.
- `runModule()` test harness. Builds a synthetic event from a `command` string and returns the full `EvaluationOutcome` — replaces hand-built event matrices in rule tests.
- Decision merge envelope: `Terminal(deny|ask)` + `Annotation(warning|note|error)`. `deny` short-circuits and drops `warning`/`note`; `error` annotations always survive. `ask` keeps collecting annotations (first ask wins terminal).

## [0.4.1] — 2026-05-14

### Changed
- Bumped `zod` to 4.x, TypeScript to 6.x, `@questi0nm4rk/shell-ast` to 0.3.2.
- README structural rewrite.

## [0.4.0] — 2026-05-14

### Added
- Adopted shell-ast 0.3's `UnwrappedCall` discriminated union (`kind: "plain" | "wrapped" | "wrapped-script"`).
- `preloadWasm()` integration — moves WASM load to wrapper startup so first-rule latency stays minimal.
- Typed errors: `ShellAstParseError`, `RuleEvaluationError`, `StateStoreError`, `FileReadError` (early subset of the 0-silent-fails system finalized in 0.5).

### Changed
- Migrated `cmd()` / `pipe()` / `redirect()` to consume shell-ast 0.3's union-based primary lens. Deleted ~150 lines of v0.2 workarounds.
- Pre-ai-guardrails cleanup pass: closed catalogued BUG-001 through BUG-006 over 0.4 + 0.5. (#7)

## [0.3.0] — 2026-05-10

### Breaking
- Shell wrapper `hk` is now the default build target. Compiled binaries are `bash -c`-substitutes — `hk -c "<cmd>"`-shaped, caller-agnostic.
- The Claude Code tool-call adapter is now opt-in via `--adapter cc-tools` (was the default in 0.2).

### Added
- `cc-tools` adapter binary for `Edit`/`Write`/`NotebookEdit`/`Read` events that bypass the shell. Use alongside the shell wrapper.
- Inline-shell recursion: `bash -c "rm -rf /"` triggers the same `cmd("rm")` rule as the bare command.
- `pipe()` and `redirect()` builders.
- `withDdash()` modifier on `cmd()`.
- SPEC + README + CLAUDE.md rewritten for the v0.3 ideology.

## [0.2.0] — 2026-05-10

### Added
- `hook-kit build` CLI — compiles a TypeScript hooks module to a standalone Bun bytecode binary. Generates entrypoint + emits `hooks.json`.
- Escalation infrastructure: filesystem-spool broker, askpass contract, listener markers, parent-chain walk, `escalate-up` forward verb, interactive TUI watch (`hook-kit watch`), broker validator, `callAskpass` with opt-in custom-binary timeouts.
- `HOOK_KIT_ASKPASS` env var. Unset → falls through to harness-ask (CC ask JSON / shell-wrapper exit-1 stdout). Set + working broker → routes through the spool tree.
- `content()` builder for `PostToolUse` body inspection.
- `stateful()` builder + `TmpdirStore` for cross-invocation state.
- `HOOK_KIT_VERBOSE=1` tracing: single stderr trace line per evaluation.
- `HOOK_KIT_ENRICH_GIT=1` ask envelope enrichment.
- Generic adapter (no Claude-Code coupling).
- ai-guardrails port in `examples/` as the reference downstream consumer.

### Fixed
- Engine honors `shortCircuit: false` in the terminal-decision branch.

## [0.1.0] — 2026-04-01

### Added
- Initial scaffold + SPEC-001.
- `cmd()` and `path()` builders backed by shell-ast.
- `evaluate()` engine with per-invocation shell-ast cache on `EvalContext`.
- `Module` + `Rule` core types.
- `expandFlags` / `hasFlag` flag-alias engine helpers.
- Biome config, feats + zod, `tsc --noEmit` baseline; biome `--reporter=rdjson` convention.
- First npm publish preparation.
