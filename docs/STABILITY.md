# Stability tiers

How to read `@stable`, `@experimental`, and `@internal` tags on `@questi0nm4rk/hook-kit` exports, plus the deprecation cycle the kit promises starting with the 1.0.0 release.

This document is the contract. The full export inventory with per-symbol assignments lives in [`specs/v1.0-exports.md`](./specs/v1.0-exports.md).

---

## Three tiers

hook-kit ships three stability tiers. The tier is tagged at the symbol declaration site with a JSDoc marker; consumers can grep `node_modules/@questi0nm4rk/hook-kit/src/**/*.ts` for `@stable`, `@experimental`, or `@internal` to audit what tier a given import is.

### STABLE

```ts
/** @stable @since 1.0.0 */
export function cmd(command: string, ...sub: string[]): CommandRuleBuilder;
```

- **Promise:** semver-locked. The signature, behaviour, and observable side effects of a STABLE symbol do not change in any patch or minor release. Breaking changes require a major version bump AND go through the deprecation cycle below.
- **What counts as breaking:** removing the symbol, renaming it, narrowing a parameter type, widening a return type, adding a required parameter, removing a documented overload, changing a documented exit code / output format, changing a JSON wire shape consumers parse.
- **Reachable via:** every re-export in `src/index.ts`, every entry under the `./testing` subpath, the `./adapters/*`, `./state`, `./state/memory`, `./state/tmpdir`, `./wrapper/hk`, and `./engine` subpaths.

### EXPERIMENTAL

```ts
/** @experimental @since 1.0.0 — may change in 1.x with one-release deprecation */
export function coverageReport(...): Promise<CoverageReport>;
```

- **Promise:** subject to breaking change in any minor release. Such a change WILL get a one-release deprecation cycle (see below) — but the cycle is one minor version, not one major version. Patch releases will not break EXPERIMENTAL exports.
- **When to use them:** when you accept the looser stability contract for early access to the API. EXPERIMENTAL exports are usually labelled when downstream feedback could reshape them — shipping them gets the feedback, but consumers should expect to revisit their integration sooner than they would for STABLE.
- **Current EXPERIMENTAL surface (1.0.0):** none. First entries land in M2 (`SqliteStateStore`'s schema details) and M4 (`coverageReport`, conflict detection, snapshot harness) per `docs/plans/v1.0.0.md`.

### INTERNAL

```ts
/** @internal — no stability promise, may move/rename in any release */
```

- **Promise:** none. Internal symbols and modules can be removed, renamed, moved between files, or have their behaviour changed in any release — patch, minor, or major.
- **Why they exist:** hook-kit ships some module paths so the kit's own subprocesses and test fixtures can reach them, but consumers are not supposed to import from these paths. Examples: `src/engine/helpers.ts` (engine plumbing the builder primitives use; consumers compose builders, never call the helpers directly), `src/escalation/broker.ts` (reference implementation of the broker socket protocol — the protocol itself is STABLE, but `broker.ts`'s internal helpers are not), `src/build/cli.ts` (the `hook-kit` CLI is STABLE; the module's internal functions are not).
- **Where `@internal` is applied:** load-bearing only — on symbols that ARE exported but should not be treated as public API. Example: `__setMaxRecurseDepthForTests` in `src/engine/index.ts` (an `export function` reachable from `src/index.ts`'s export graph, but reserved for hook-kit's own tests); `errorAnnotation` in `src/core/decision.ts` (engine-only constructor for `error` annotations, NOT re-exported but flagged so a future refactor that incidentally exposes it stays honest about the tier).
- **Where it is NOT applied:** file-header `@internal` JSDoc blocks on whole modules that are entirely unreachable from `src/index.ts`. Those add no signal beyond what this STABILITY.md table already lists, and would need maintenance every time an internal file moves. The canonical INTERNAL inventory lives in [`specs/v1.0-exports.md`](./specs/v1.0-exports.md) and the consumer-facing guidance lives below in § How to consume. Do not duplicate that into per-file headers.

### Mixed-tier modules

A few modules export STABLE symbols alongside INTERNAL ones. The most prominent: `src/engine/index.ts` re-exports `evaluate`, `evaluateRule`, `runModule`, `EvaluateOptions`, `RunModuleOptions` as STABLE while housing internal helper functions (e.g., `__setMaxRecurseDepthForTests`) that bear an explicit `@internal` JSDoc. When in doubt, check the per-export tag; it's authoritative.

---

## Deprecation cycle

The deprecation cycle binds STABLE exports. EXPERIMENTAL gets a compressed version (one minor, not one major). INTERNAL gets no cycle at all — INTERNAL symbols can vanish without warning.

### The contract for STABLE removals

When a STABLE export is going to be removed or have a breaking change:

1. **Mark deprecated in a minor release.** The symbol gains a `@deprecated` JSDoc tag explaining the replacement, the migration path, and the planned removal version:

   ```ts
   /**
    * @deprecated @since 1.3.0 — use `newCmd()` instead; this alias will be
    *   removed in 2.0.0. Migration: replace `cmd(...)` with `newCmd(...)`
    *   call-for-call; signatures are identical.
    * @stable @since 1.0.0
    */
   export function cmd(command: string, ...sub: string[]): CommandRuleBuilder;
   ```

   The TypeScript compiler surfaces `@deprecated` via editor strikethrough + a warning in `tsc --noEmit` output. Downstream consumers get the warning the moment they upgrade.

2. **Emit a runtime `console.warn` once per process load.** A guarded `if (!warned) { console.warn(...); warned = true; }` ensures consumers who don't bump their typecheck eventually still see the warning, but the warning never floods the log.

3. **Wait at least one minor release.** A deprecated 1.3.0 STABLE symbol can be removed no earlier than 2.0.0 (next major). It can ALSO be retained beyond 2.0.0 if there's still meaningful downstream usage — the deprecation cycle defines the floor, not the ceiling.

4. **Remove at the next major.** When the major releases, the symbol drops out of `src/index.ts`. CHANGELOG's "Removed" section enumerates every dropped export and links to the deprecation notice from the minor where it landed.

5. **CI enforces the floor.** `scripts/check-stable-exports.ts` (added in M0) diffs the current STABLE export set against `origin/main`. A STABLE removal without a `BREAKING CHANGE:` footer in the commit-range messages fails CI — see TASK-007 in `docs/plans/v1.0.0-tasks.md`.

### Migration windows

When a STABLE removal is intrinsically painful (e.g., a renamed type that appears in user code in dozens of places), the deprecation note must include a codemod or grep-replace recipe. "Migration: rename `Foo` to `Bar` across your codebase" is the floor; for shape changes, include a before/after snippet.

### Deprecating an EXPERIMENTAL export

Same shape, compressed timeline:

1. `@deprecated @since X.Y.0` tag in a minor release.
2. Runtime warn once-per-load.
3. Remove no earlier than the NEXT minor (one full minor of overlap).
4. Document in CHANGELOG.

So an EXPERIMENTAL deprecated in 1.3.0 can be removed in 1.4.0 (not 1.4.1 — the deprecation cycle pins to minor boundaries).

### What doesn't need a deprecation cycle

- **INTERNAL symbol changes.** No cycle, no notice required. INTERNAL means "if you imported from this path, you opted out of the stability contract."
- **Bug fixes that change observable behaviour for clearly-broken inputs.** Example: a builder that previously crashed on `undefined` and now throws a typed error. Behaviour change, but the prior behaviour wasn't usable. CHANGELOG should still document it under "Fixed."
- **Documentation, JSDoc wording, internal refactors, performance improvements, dependency bumps that don't change observable behaviour.**

### Deprecation warnings should not be removable by a flag

The kit does not expose a `HOOK_KIT_SUPPRESS_DEPRECATIONS` env var. The runtime warning is part of the contract; suppressing it would defeat the purpose (a consumer who upgrades and gets zero warnings might miss the cycle entirely). If a downstream needs to silence a specific deprecation in their own logs, they can do so in their log infrastructure — but the warning fires.

---

## How to consume

A consumer integrating hook-kit should:

1. **Pin a hook-kit version.** Use `^1.x` to get the full STABLE contract across the major. `~1.0` if you want patch-only updates.
2. **Audit imports against the inventory.** [`specs/v1.0-exports.md`](./specs/v1.0-exports.md) lists every public symbol with its tier. Any import not on that list is unsupported (likely a reach into an internal path).
3. **Treat `@experimental` imports as a sub-dependency you re-version with.** Every minor bump, run your test suite; if an `@experimental` you depend on broke, the CHANGELOG will say so and you'll have one minor to migrate before the symbol is gone.
4. **Don't import from `src/engine/helpers.ts`, `src/escalation/{broker,listeners,watch-tui,forward,enrich-git}.ts`, `src/build/`, `src/core/annotations.ts`.** These are file-header `@internal`. The functionality they provide is reachable through STABLE entry points — `evaluate()`, the `hook-kit broker` CLI, the askpass envelope schema (STABLE; spec'd in M1.4).
   - **Subpath exception, `@internal` tier:** the `@questi0nm4rk/hook-kit/escalation` subpath barrel (added 1.0.0 alongside `docs/ESCALATION.md`) re-exports listener-authoring primitives — `registerListener`, `listPending`, `submitDecision`, `forwardUp`, `brokerAskpass`, `ensureSession`, and friends. They are tagged `@internal` at the barrel: subject to change in any 1.x release with one-minor-deprecation under the same cycle EXPERIMENTAL exports use. The envelope schema (`createAskRequest`, `parseAskRequest`, `AskRequest`, `AskResponse`, `PROTOCOL_VERSION`) re-exported by the same barrel IS `@stable @since 1.0.0`. The split is documented in `src/escalation/index.ts`; the worked-example listener at `examples/escalation-listener-stdout/` consumes through this subpath. Direct imports from the deep `src/escalation/*.ts` paths remain off-limits.
   - **Schema objects (`AskRequestSchema`, `AskResponseSchema`) in `src/escalation/envelope.ts` are exported `@internal` for the snapshot test at `tests/escalation/envelope-schema.test.ts` only.** They are NOT re-exported from `src/index.ts` or any subpath barrel. Consumers needing the JSON-schema form should generate it with `z.toJSONSchema(...)` against their own published Zod, OR read the snapshot file directly.
5. **Run `bun run typecheck` on every hook-kit bump.** Deprecation warnings surface here first. A clean typecheck on bump = no migration work needed.

### Detecting deprecations programmatically

```bash
# In your CI, fail on new deprecation warnings:
bun run typecheck 2>&1 | grep -E "is deprecated" && exit 1 || exit 0
```

For runtime detection (in a long-running daemon embedding hook-kit), capture `console.warn` and route to your log aggregator. The deprecation warning text always starts with `[hook-kit] DEPRECATED:` so it's grep-friendly.

---

## Versioning policy

Starting with the 1.0.0 release, hook-kit follows [semantic versioning](https://semver.org/spec/v2.0.0.html) as scoped by the tier system above:

| Change | Patch (1.0.x) | Minor (1.x.0) | Major (2.0.0) |
|---|---|---|---|
| Bug fix in STABLE behaviour | YES (if observable behaviour matches what docs/tests describe) | YES | YES |
| New STABLE export | NO | YES | YES |
| Breaking change to STABLE export | NO | NO | YES (requires prior deprecation in a 1.x minor) |
| New EXPERIMENTAL export | NO | YES | YES |
| Breaking change to EXPERIMENTAL export | NO | YES (requires prior deprecation in a 1.x.0 minor) | YES |
| Change to INTERNAL | YES | YES | YES |
| Bump shell-ast minor (non-breaking) | YES | YES | YES |
| Bump shell-ast major (breaking even if absorbed) | NO | YES (if hook-kit's STABLE surface remains source-compatible) | YES |
| Change in default `recurseInlineShells` | NO | NO | YES (behavioural shift consumers depend on) |
| Change in default `cmd()` matching (basename vs strict-path) | NO | NO | YES |

### Pre-1.0 versions (0.x.y)

0.x releases did not honour the cycle above — breaking changes shipped in minor bumps. The 0.7 → 1.0 transition is the cutover. Consumers still on 0.x should consult [`MIGRATION-v1.0.0.md`](./MIGRATION-v1.0.0.md) (lands in M5) when bumping.

### Yanking a release

If a release ships a regression severe enough to require yanking, hook-kit will:

1. `npm deprecate @questi0nm4rk/hook-kit@<bad-version> "<reason>"` so consumers get a yellow line on `npm install`.
2. Publish a patch release immediately reverting the regression.
3. Document in CHANGELOG.

Yanking does NOT count as a breaking change — the previous behaviour the regression broke is the STABLE contract, and the patch restores it.
