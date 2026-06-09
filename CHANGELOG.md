# Changelog

All notable changes to `@questi0nm4rk/hook-kit` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 minor bumps may include breaking changes (noted under **Breaking**).

## [Unreleased]

> Staged for the 1.0.0 release. This collects the consumer-facing surface that
> landed across the 1.0 milestones: an unknown-is-not-safe command-gating
> guardrail, a programmatic observability hook, three extension-contract docs, an
> adapter-authoring scaffold, and escalation/state contract hardening. Internal
> tooling and refactors are omitted; see the git history for per-commit detail.

### Added

- **Unknown-is-not-safe command gating (`SecurityOptions`).** The engine now
  ESCALATES on uncertainty instead of failing open: unparsable commands, opaque
  inline-shell bodies, dynamic command words, and unresolvable flag values route
  to `ask` rather than silently passing. Configurable via `SecurityOptions` — the
  `STRICT_BUT_ASKS` (default) and `STRICT_DENY` profiles, an
  `EngineUnavailablePolicy` for when shell-AST can't load, and an `onDepthExceeded`
  hook for the wrapper-recursion limit. New STABLE exports: `SecurityOptions`,
  `STRICT_BUT_ASKS`, `STRICT_DENY`, `EngineUnavailablePolicy`, `EscalationDecision`,
  `escalate`, `isUncertaintyDecision`.
- **`protectPath()` builder.** Gate shell-side access to sensitive file paths from
  a command rule, with read/write modes via `ProtectMode`. New STABLE exports:
  `protectPath`, `ProtectMode`.
- **`allowOnly(...)` builder.** Whitelist-inverter — deny every command except an
  explicit allowlist (the dual of per-command `deny`). New STABLE export:
  `allowOnly`.
- **`reasonKind` on decision records + verbose trace.** Every decision now carries
  a machine-readable `reasonKind` (why a terminal/escalation fired), and the engine
  can emit a verbose evaluation trace for debugging rule decisions.
- **`DecisionObserver` — programmatic observability hook.** Register observers
  via `EvaluateOptions.observers` to receive a `DecisionEventRecord` for every
  decision the engine produces — terminal (`deny` / `ask`) and annotation
  (`warning` / `note` / `error`). This is the structured-data channel for sinks
  (syslog, OTLP, file, custom transport) that would otherwise have to parse the
  wrapper's stdout. Records carry a timestamp, rule id, decision kind, reason,
  optional label, per-rule timing, and an `event` sub-shape. `toolInput` is never
  logged — only its sha256 hex hash — so observers don't leak secrets to log
  infrastructure by default. Observer throws are caught and surfaced as `error`
  annotations (a new `ObserverError`); the decision proceeds and subsequent
  observers still fire. New STABLE exports: `DecisionObserver`,
  `DecisionEventRecord`, `ObserverError`. Documented in `docs/SPEC.md`
  § Observability.
- **`mockObserver()` in `@questi0nm4rk/hook-kit/testing`.** A capture-and-replay
  observer for testing decision streams, with an optional `throwOn` predicate to
  exercise the engine's observer fail-open path. Sits alongside `mockState` and
  `mockAskpass` in the testing subpath.
- **Annotation formatters are now public.** `formatNonErrorAnnotation`,
  `formatErrorAnnotation`, `partitionAnnotations`, and the `ErrorAnnotation` /
  `NonErrorAnnotation` types are exported from the main barrel so custom adapters
  can emit the shell-wrapper line convention without re-implementing it. Both
  formatters take an optional `defaultLabel` to override the `[hook-kit]`
  fallback prefix.
- **`docs/ADAPTERS.md` — `ProtocolAdapter` authoring contract.** End-to-end spec
  for writing a custom adapter (Cursor / Cline / MCP / your own) without reading
  source: per-method signatures, lifecycle, the output convention, error
  handling, and anti-patterns.
- **`examples/adapter-template/` — fork-and-modify adapter scaffold.** A worked
  custom-adapter example with injected streams (so it unit-tests without spawning
  a process), an optional `DecisionObserver` wired from an env var, and stub demo
  rules. Cross-referenced from `docs/ADAPTERS.md`.
- **`docs/ESCALATION.md` — askpass + broker contract.** Documents the askpass
  envelope schema, the broker's filesystem-spool protocol and per-session layout,
  the escalation lifecycle, the listener-authoring guide, the parent-session tree
  semantics, and the `HOOK_KIT_ASKPASS` env-var contract.
- **`ProtocolVersionError`.** Envelope protocol-version mismatch now surfaces as
  its own typed error (the 10th `HookKitError` subclass) rather than the generic
  `EnvelopeValidationError`, so observability can route version skew separately.
- **`examples/escalation-listener-stdout/` — worked listener example.** A
  ~60-line stdout-prompt listener that polls a session spool and reads an
  `allow` / `deny` decision from stdin. Fork it for Slack / IDE / webhook
  integrations.
- **`@questi0nm4rk/hook-kit/escalation` subpath.** Exposes the STABLE askpass
  envelope schema + `PROTOCOL_VERSION` (and the INTERNAL broker / listener /
  forwarder primitives that worked-example listeners build on).
- **`docs/STATE.md` — `StateStore` contract.** Documents the four guarantees
  every conforming store must honour (atomicity, flush durability, last-write-wins
  concurrent stores, no multi-key transactions), the safe read-modify-write
  pattern, and a per-store comparison table — so authors of custom stores and
  `stateful()` consumers don't need to read source.
- **`docs/STABILITY.md` + `@stable @since 1.0.0` tagging.** The three-tier
  stability system (STABLE / EXPERIMENTAL / INTERNAL) and its deprecation cycle
  are documented, and every public export carries a `@stable @since 1.0.0` tag at
  its declaration site. The full inventory lives in `docs/v1.0-exports.md`.

### Changed

- **`TmpdirStore` warns on same-path reuse.** Opening a second `TmpdirStore` on a
  path another instance already opened in the same process emits a one-time
  warning pointing at `docs/STATE.md`. `TmpdirStore` is single-process by design;
  cross-process sharing needs a different store (see the state contract doc).
- **`docs/SPEC.md` audited against the shipped source.** The spec now carries a
  status banner and the timeless "default adapter" framing (replacing stale
  per-version markers); every backtick-quoted API symbol in it resolves to a real
  export.
- **Inline-shell wrapper classification is now registry-derived (shell-ast
  0.8.0).** The SA-02 opaque-inline-shell escalation previously matched the inner
  wrapper against a hand-mirrored `INLINE_SHELL_WRAPPERS` set that could drift
  from shell-ast's wrapper registry. It now calls shell-ast 0.8.0's
  `isShellInterpreter(wrapper)` predicate, which is derived from the registry and
  basename-normalized — so it cannot drift, and it covers `runuser -c "$DYN"` and
  `su -c "$DYN"` (which the hand-set under-covered). Equivalence preserved: every
  interpreter the old set escalated still escalates, and no non-shell wrapper
  (`sudo`, `env`, `timeout`, …) escalates. Bumps the `@questi0nm4rk/shell-ast`
  dependency to `^0.8.0`. Closes the consumer side of shell-ast#12.

### Fixed

- **`mockAskpass()` is now injection-safe.** The test-SDK helper (`./testing`
  subpath) previously interpolated `reason` / `by` / `decidedAt` raw into a JSON
  body emitted from an *unquoted* heredoc, so a `"` could break the JSON or forge
  sibling fields, and a `$(…)` / backtick / newline in any field would be
  shell-interpreted (executing a command when the script ran as
  `HOOK_KIT_ASKPASS`). The response is now built in TypeScript and
  `JSON.stringify`'d, emitted as a single-quoted shell string (so `$`, backtick,
  `\` and newline are inert), with the request id spliced in via POSIX parameter
  expansion + `printf` instead of `sed`. The emitted body is always valid JSON
  and every field round-trips exactly for any string value. Public API unchanged.

## [0.8.0] — 2026-05-18

### Fixed

- Chained-wrapper coverage: `sudo bash -c '…'` (sudo at the outermost wrapper) now triggers the same rule pass as the symmetric `bash -c '…'`. Was tracked as shell-ast BUG-008 / [shell-ast#11](https://github.com/Questi0nM4rk/shell-ast/issues/11). The engine's `recurseInlineShells` block in `src/engine/index.ts` now walks shell-ast 0.7's `unwrapDeepParsed` chain and recurses on the first `wrapped-script` layer found anywhere in the chain — closing the asymmetry where the v0.6 one-level `unwrapCall` would only fire for bash-outermost shapes. Multi-level chains (`bash -c 'bash -c "..."'`) handled by the recursion's own walk + `MAX_RECURSE_DEPTH` cap. The previously-failing test in `tests/builders/deep-nesting.test.ts` is now `expect(out.terminal?.kind).toBe("deny")`.

### Changed

- Bumped `@questi0nm4rk/shell-ast` to `^0.7.0`.

### Pre-1.0 hygiene (this release cycle)

- `docs/BUGS.md` wiped — all 6 catalogued entries (BUG-001 through BUG-006 from the 2026-05-11 ai-guardrails 0.2→0.3 migration) verified fixed in current code; file reset to active-catalog header.
- `CHANGELOG.md` created covering 0.1.0 → 0.7.0.
- Retroactive git tags added for v0.5.1, v0.6.0, v0.7.0 (npm-published but previously untagged).

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
