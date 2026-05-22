# Changelog

All notable changes to `@questi0nm4rk/hook-kit` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 minor bumps may include breaking changes (noted under **Breaking**).

## [Unreleased]

### M1.1 — DecisionObserver API (in flight)

- **`DecisionObserver` + `DecisionEventRecord` types and `EvaluateOptions.observers` field.** New programmatic hook on every decision the engine produces (terminal `deny` / `ask` + annotation `warning` / `note` / `error`) so consumers can sink to syslog / OTLP / file / custom transport without parsing wrapper stdout. `DecisionEventRecord` carries `timestamp`, `ruleId` (`module.id:rule.kind:index`), `ruleKind`, `decision`, `reason`, optional `label`, an `event` sub-shape (`eventName`, `toolName`, `cwd`, `sessionId`, `toolInputHash`), and `timingMs`. `toolInput` itself is NOT logged — only its sha256 hex hash — so observers don't leak secrets to log infrastructure by default. New `ObserverError` typed error subclass + corresponding `HookKitErrorCode` entry to preserve the zero-silent-fails contract at the observer boundary (engine catches observer throws and surfaces as `error` annotations). All four symbols re-exported from `src/index.ts` and `@stable @since 1.0.0`. Implementation lands across TASK-012..022.
- **Engine fires observers per terminal decision (`deny` / `ask`) with per-rule timing.** `evaluate()` brackets each `rule.evaluate(event, ctx)` call with `performance.now()` and reports `timingMs` on the record. Bracketing is gated on `observers !== undefined && observers.length > 0` so the default zero-observer path stays zero-overhead (no record built, no hash computed, no timing measured). Observers fire per rule-PRODUCED terminal even when the merge policy drops the terminal from the outcome (e.g., a second `ask` after the first has won). Observer throws are caught and surfaced as `error` annotations on the outcome (one per throwing observer); the decision and subsequent observers in the same array continue to fire. `toolInputHash` is cached per-evaluation so multiple records in the same frame share the same hash. `ObserverError` describes the failed observer with its array index in the message. Engine-emitted error annotations from rule throws (`RuleEvaluationError` / `HookKitError` passthrough) also fire observers with `decision: "error"`. [TASK-015 / 017 / 018 / 019 / 020 land in one commit because they share the same code path; engine-throw safety is required to land observer firing safely.]
- **Engine fires observers per annotation (`warning` / `note` / `error`).** Rule-emitted warnings and notes invoke the observer with `decision: "warning" | "note"` carrying the annotation's `message` as `reason` plus any `label`. Engine-emitted error annotations from `state.flush()` failures and `drainContextErrors()` (shell-ast parse errors) invoke observers with `decision: "error"`, the synthetic `ruleId` `<engine>:state-flush` / `<engine>:shell-ast`, and `timingMs = 0` (no rule.evaluate() was bracketed). The merge policy's deny-drop behavior on `outcome.annotations` does NOT affect observer firing — the observer sees every decision the engine encountered, even those that get filtered out of the outcome. [TASK-016]
- **`docs/SPEC.md` § Observability.** New top-level section documenting the `DecisionObserver` contract end-to-end: when observers fire, sync semantics + array order, throw-safety / `ObserverError`, inline-shell recursion semantics (observers fire for sub-decisions; inner `ruleId` reflects the inner rule), zero-overhead gate, the record shape, the sha256-hex hash policy + per-evaluation caching, the rationale for NOT including raw `toolInput` by default, and anti-patterns (no synchronous I/O in `onDecision`, throws aren't flow control, records are read-only, programmatic consumers use the observer not wrapper stdout). § Operational Readiness gets a one-line cross-reference. [TASK-022]
- **Engine observer plumbing collapsed post-implementation /simplify pass.** The five repeated `notifyObservers(buildRecord({...}))` blocks in `evaluateInternal` shared the same four ambient args (event, toolInputHash, annotations, observers) and varied only on the per-decision fields; promoting to a `notifyFor(args)` closure cuts each call site from ~12 lines to one. Hash cache + `notifyFor` + `notifyEngineError` closures are now allocated INSIDE the `if (observersActive)` branch so the zero-observer path never builds them. `ruleId` template-literal allocation per rule is also gated behind `observersActive`. `EngineErrorSource` is now a string-literal union (`"state-flush" | "shell-ast"`) rather than free-form `string`, preventing typos at the call sites. `DecisionObserver` JSDoc compressed to one sentence + SPEC link. SPEC § Hash policy now pins the exact `crypto.createHash('sha256').update(JSON.stringify(toolInput)).digest('hex')` construction (no key sorting / normalization) as part of the 1.0 STABLE contract — algorithm/normalization changes now require the deprecation cycle.
- **`mockObserver()` added to `@questi0nm4rk/hook-kit/testing`.** New STABLE export at `src/testing/mock-observer.ts` — capture-and-replay `DecisionObserver` for tests, with an optional `throwOn(record) => boolean` predicate for exercising the engine's observer-throw fail-open path. Shape: `{ records: readonly DecisionEventRecord[], onDecision, reset() }`. Re-exported from the `@questi0nm4rk/hook-kit/testing` subpath barrel alongside `mockState` and `mockAskpass`. The 5 observer test files (terminal / throw / hash / shortcircuit / annotation) now use `mockObserver` + the shared `bashEvent` / `moduleWith` helpers from `tests/_helpers.ts` instead of 5 hand-rolled copies of the same closures. 7 new tests in `tests/testing/mock-observer.test.ts` cover the SDK directly (records capture, no-decision case, `throwOn` predicate triggering, default never-throw, `reset()` identity-preservation, fresh-instance-per-call, barrel re-export). Net `tests/` count: 552 → 558. Coverage rises to 85.72% funcs / 90.06% lines (was 84.94 / 89.52). The tautological placeholder test in `observer-annotation.test.ts` (`expect("<engine>:shell-ast").toContain("<engine>")`) deleted in this pass — a real `tests-isolated/` job mocking `parse()` is M2 scope.
- **Library-mode e2e against the `ai-guardrails` example.** New `tests/integration/observer-ai-guardrails.test.ts` (new top-level test directory) drives the example's real default-exported module array (gcc / git / path / redirect rules) through `evaluate()` with `mockObserver` and asserts the captured records. Five firing scenarios covered: DENY (gcc -o /etc/passwd → `system-path-writes`), ASK via cmd (git push --force → `git-force-push`), ASK via path (Write /proj/.env → `protect-configs`), CLEAN (ls /tmp → 0 records), and observer-throw fail-open against a real deny rule. A sixth test demonstrates the canonical JSONL file-observer recipe (inline `{ onDecision: r => fs.appendFileSync(...) }` — NOT a new SDK function) for consumers to copy. Setup mirrors `tests/build/example-ai-guardrails.test.ts`'s tmpdir + symlinks pattern for node_modules resolution; the example itself is NOT modified. Net `tests/` count: 558 → 565. **Build-CLI observer wiring** (passing a `observers` named export from the consumer's source through `hook-kit build` into the compiled binary) is deferred — this validates the engine-level wiring against a real rule set, which is the M1.1 acceptance gate; the build-CLI surface is a future feature when consumers ask for it.

### M0.5 — Tooling hardening (completed 2026-05-22)

Dev-tooling discipline ported from `ai-guardrails` Python-strict-ruff to the TS-stack equivalent. 8 batches shipped across 25+ commits. Hook-kit's dev stack now: max-strict tsc + biome 6-groups-at-error + typescript-eslint strict-type-checked + suppress-comment discipline (≥10-char content-bearing reasons) + semgrep + 84%/89% coverage floor + markdownlint CI + 4 pre-commit hooks + 4 CI gate scripts. CP-1 (no `warn` severity) enforced: zero `warn` entries across all static-check configs. The 525-test suite remains green throughout. Full per-batch retrospective + design decisions in [`docs/plans/v1.0.0-lessons.md`](docs/plans/v1.0.0-lessons.md) § Phase M0.5.

### Added

- **v1.0 stability tagging.** Every public export now carries a `@stable @since 1.0.0` JSDoc tag at its declaration site; internal-only modules (`src/engine/helpers.ts`, `src/engine/trace.ts`, `src/escalation/{broker,listeners,watch-tui,enrich-git,forward}.ts`, `src/build/`, `src/core/annotations.ts`) carry a file-header `@internal` tag. Consumers can grep `node_modules/@questi0nm4rk/hook-kit/src/**/*.ts` for `@stable` to audit what's part of the v1.0 semver-promised surface. The full inventory + tier assignments live in `docs/specs/v1.0-exports.md`.
- **`docs/STABILITY.md`.** Documents the three stability tiers (STABLE / EXPERIMENTAL / INTERNAL), the deprecation cycle for STABLE removals (`@deprecated` JSDoc + runtime `console.warn` once-per-load + minimum-one-minor warning before removal at next major), and the versioning policy table covering which change kinds are allowed in patch / minor / major.
- **`scripts/check-stable-exports.ts`.** CI diff guard that fails the build when STABLE exports are removed from `src/index.ts` without a `BREAKING CHANGE:` footer in the commit range. Wired into `.github/workflows/test.yml` on every PR.
- **`scripts/check-changelog.ts`.** CI discipline check that fails when commits touch `src/` without a corresponding edit to the `## [Unreleased]` section. Wired alongside `check-stable-exports.ts`. `[skip-changelog]` in any commit message in the range opts out (use for refactors / comment-only edits).
- **`scripts/check-suppress-comments.ts` (M0.5 batch S4).** Requires every inline linter suppression (`// biome-ignore`, `// biome-ignore-all`, `// eslint-disable*`, `// @ts-ignore`, `// @ts-expect-error`) to carry a content-bearing reason of ≥10 non-whitespace characters after its separator (`:` for biome / TS, `--` for ESLint). TS directives accept either an inline `:` reason or a preceding-line `// ...` comment. Generic placeholders (`TODO`, `see comment`, `needed`, `fix later`, `wip`, `temp`, `temporary`, `xxx`) rejected by an explicit denylist so the gate can't be defeated by typing characters. Supports per-file mode (`{staged_files}` for lefthook) and `--all` mode (recursive walk of `src/ tests/ tests-isolated/ scripts/` for CI). Block-comment-aware: marker syntax quoted inside multi-line JSDoc is not flagged. Wired into `lefthook.yml` pre-commit (priority 2 alongside gitleaks/codespell/markdownlint) and `.github/workflows/test.yml` (runs unconditionally — no base ref needed since `--all` scans the full tree). Existing 85 suppressions across the repo all conform; no remediation needed to land the gate.
- **Semgrep CI job (M0.5 batch S5).** New parallel job in `.github/workflows/test.yml` runs `semgrep --config auto --error` (registry default ruleset, any finding fails the build per CP-1). Excludes `tests/`, `tests-isolated/`, `examples/`, `docs/` to scope the scan to production source. Ported from `ai-guardrails/.github/workflows/check.yml`.
- **Coverage floor enforcement (M0.5 batch S5).** `bunfig.toml` enables coverage emission; `scripts/check-coverage.ts` parses the text reporter's `All files` row and exits non-zero when function coverage drops below 84% or line coverage below 89%. Codifies the 2026-05-22 status quo (84.65% / 89.29%) to prevent regression. Bun's native `[test] coverageThreshold` key would have done this directly but is not enforced in Bun 1.3.x — see oven-sh/bun#7367 / #8111 / #17664; the custom script becomes a belt-and-suspenders check once upstream lands the fix. Raising past 85% is its own follow-up batch — current shortfall concentrated in `src/wrapper/hk.ts` (compiled-binary entrypoint, exercised end-to-end only) and `src/core/event.ts` (factories tested through consumers).
- **Markdownlint CI job (M0.5 batch S5).** New `markdown` job in `.github/workflows/test.yml` runs `bunx --bun markdownlint-cli2 "**/*.md" "#node_modules/**" "#dist/**"` on every push and PR. Catches doc drift the pre-commit hook misses (lefthook only scans staged files and excludes `docs/plans` + `docs/specs`). Pre-existing CI-scope drift: 76 violations across `docs/SPEC.md`, `docs/plans/`, `docs/specs/`, and `examples/ai-guardrails/README.md` fixed in this batch (MD032 blanks-around-lists, MD040 fenced-code-language, MD031 blanks-around-fences, MD038 no-space-in-code, MD056 table-column-count, MD026 no-trailing-punctuation). MD025 (multiple H1) and MD001 (heading-increment) disabled at config with WHY — `docs/plans/v1.0.0-tasks.md` intentionally uses one H1 per phase (M0..M5).

### Changed

- **`docs/SPEC.md` audited against the 0.8 source.** Added a top-of-file status banner referencing `STABILITY.md`, the export inventory, and `plans/v1.0.0.md`. Replaced misleading "v0.3 default" version markers on `runShell` with the timeless "default adapter" framing. Marked § Considered Future Additions as "subject to M1–M5" so deferred items there are read against the 1.0 roadmap, not as deferred-forever. Verified every backtick-quoted API symbol in the SPEC resolves to a real export in `src/` (42 symbols, zero missing).
- **Strict biome ruleset (M0.5 batch S2).** All 6 active rule groups (`complexity` / `correctness` / `performance` / `security` / `style` / `suspicious`) now enabled at `error` severity via the string-shorthand "all-rules-in-group" form; `a11y` and `nursery` explicitly `off` with one-line WHY (server-side TS library; experimental). 11 rules disabled at config with content-bearing reasons in an `overrides` block (`noProcessGlobal`, `noNodejsModules`, `useQwikValidLexicalScope`, `useTopLevelRegex`, `useNamingConvention`, `noProcessEnv`, `useExportsLast`, `useAwait`, `noExcessiveLinesPerFunction`); `javascript.globals` added (`["Bun", "process", "__dirname", "__filename"]`) to resolve 26 `noUndeclaredVariables` false-positives. Initial pass surfaced 891 violations; 235 auto-fixed via `biome check --write --unsafe`, 18 src-side `noMagicNumbers` extracted to named constants, 3 nested ternaries refactored to helpers, and 66 per-line / per-file `// biome-ignore` entries (each with ≥12-char WHY) cover the remainder. CP-1 compliance: zero `"warn"` / `"warning"` / `"info"` severities in `biome.jsonc`. Pre-commit `biome-fix` hook now uses `bunx --bun biome` (project devDep 2.4.15) instead of system `/usr/bin/biome` (2.3.15) which didn't know the newer rule names. `.codespellrc` gains `afterall` to allow Bun's `afterAll` test-hook identifier.
- **Strict typescript-eslint ruleset (M0.5 batch S3a/S3b).** Adopted `strict-type-checked` + `stylistic-type-checked` (typescript-eslint v8 flat config) layered on top of biome — eslint owns type-aware rules biome can't compute (`no-floating-promises`, `no-misused-promises`, `restrict-template-expressions`, `no-unsafe-*` family, etc.). Six async-correctness rules explicitly reaffirmed at error (`no-floating-promises`, `no-misused-promises`, `no-unnecessary-type-assertion`, `prefer-promise-reject-errors`, `require-await`, `no-non-null-assertion`) to document hook-kit's contract. One config tweak: `no-unused-vars` adds the `_`-prefix exemption matching biome's `noUnusedFunctionParameters` convention. CP-1 compliance: zero `"warn"` / `"warning"` / `"info"` severities in `eslint.config.js`; `--max-warnings=0` belt-and-braces in the lint script. `package.json` `lint` script now runs `lint:biome && lint:eslint` (each runnable independently). S3a's adoption surfaced 182 violations; S3b resolved every one: 26 via `eslint --fix`, ~75 via code changes (mostly extracting narrow shape interfaces for JSON.parse boundaries — see `tests/_helpers.ts` `CcStdoutJson` + `parseCcStdout`, mirrored locally in broker/forward tests), ~25 via per-line eslint-disable comments with content-bearing reasons (API contracts: `ProtocolAdapter.readInput`, `mock.module`, Bun FileSink `number | Promise<number>` race patterns, `process.env` dynamic-delete), 2 via file-header disables for spawned-binary test files (15 sites of `proc.stdin.write/.end` in `tests/build/end-to-end.test.ts` + `tests/escalation/end-to-end.test.ts`), and 4 latent test bugs surfaced + fixed (`expect(promise).rejects.toThrow(...)` without await → silent test passes; rewrote to try/await/catch). Test count unchanged: 525 / 525.

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
