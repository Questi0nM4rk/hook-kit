# hook-kit — Known Bugs & Friction

Found during the ai-guardrails 0.2 → 0.3 migration (v4.0.0 release, 2026-05-11).

## BUG-001: Silent WASM-load failure leaves all rules disabled with no signal

**Severity:** CRITICAL — turns a single packaging bug into invisible
loss-of-coverage for every command/pipe/redirect rule.

### Symptom

A compiled hk binary runs every Bash command through the engine, silently
returns `null` (no rule fired) for everything, exits 0, exec's the command
verbatim. Decisions never trigger. Approve / deny / ask distinction
collapses to "approve everything".

### Reproduction

The triggering bug is in `@questi0nm4rk/shell-ast` (BUG-001 in shell-ast).
But hook-kit's behavior under that failure is the load-bearing observation:

```typescript
// engine/evaluate flow when shell-ast WASM fails to load:
//   getBashAst() → shell-ast.parseRaw() throws ENOENT
//   evaluator catches → AST is null → cmd()/pipe()/redirect() rules return null
//   final decision: null → exit 0, command runs
//   No log, no warning, no trace.
```

End user sees `git push --force` succeed when ai-guardrails-hk should have
askd.

### Root cause

Iron Law 4 ("fail open on infra errors") was designed to keep hook framework
bugs from blocking users. It correctly treats per-rule throws as `null`. But
applied to the WASM-load layer, it converts a single packaging bug in
shell-ast into a silent disabling of every shell-AST-dependent rule.

There is no signal at runtime that anything is wrong. `HOOK_KIT_VERBOSE=1`
also produces no output for this case (see BUG-005).

### Proposed fix

A one-line stderr warning, emitted **once per process** on first WASM-load
failure, regardless of `HOOK_KIT_VERBOSE`:

```console
[hook-kit] shell-ast WASM failed to load — command/pipe/redirect rules disabled
[hook-kit] details: <error message>
```

Iron Law 4 is preserved (engine still returns null, doesn't deny). But the
silent disabling is no longer silent. Operators see one stderr line per
session and can investigate.

Additional defense in depth: an opt-in `HOOK_KIT_REQUIRE_AST=1` env var that
flips this from a warning to a deny — for environments where missing AST
coverage is a security incident, not a degraded-mode operation.

### Why this matters more than typical Iron-Law-4 cases

Iron Law 4 protects against framework bugs blocking users — that's the right
default for "this rule threw, skip it". But the WASM-load layer is different:

- It's a single global init, not per-rule.
- Its failure cascades to *every* shell-AST rule (every cmd / pipe / redirect).
- Rules silently going away is a security regression even if no individual
  rule is "blocked".

Treating WASM-load as "infra error → fail open silent" is over-applying the
law. The principle is "framework bugs shouldn't block users". A clear stderr
warning doesn't block users; it tells them coverage is missing.

---

## BUG-002: `hook-kit build` CLI cannot cross-compile

**Severity:** Medium — workaround is straightforward but adds duplication.

### Symptom

`hook-kit build src/hooks.ts --out dist/hk` always builds for the host
platform. There is no `--target` flag. Distributing pre-built binaries for
linux/darwin × x64/arm64 requires bypassing the CLI.

### Where it bit us

ai-guardrails ships three binaries × four platform-arch combos = 12 release
artifacts. We had to write `scripts/build-hk-binaries.ts` that re-implements
the wrapper-generation logic from `src/build/bundle.ts:generateEntrypoint` so
we could pass `--target=bun-${platform}-${arch}` to `bun build` directly.

The duplication is fragile: any change to hook-kit's wrapper shape (e.g., a
new env var the wrapper sets, or a different runShell import path) silently
breaks our cross-compiled binaries until we mirror the change.

### Proposed fix

One of:

1. **Add `--target` to `hook-kit build`**, passing through to `bun build`:
   ```bash
   hook-kit build src/hooks.ts --out dist/hk --target=bun-linux-arm64
   ```
   Accept the same target strings bun accepts (`bun-linux-x64`,
   `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, etc).

2. **Export `generateEntrypoint` and `runBuild` via package.json `exports`**:
   ```json
   "./build/bundle": {
     "import": "./src/build/bundle.ts",
     "types": "./dist/types/build/bundle.d.ts"
   }
   ```
   Currently `build/bundle.ts` is internal — programmatic users can't import
   `generateEntrypoint` to drive `bun build` themselves with custom flags.

Option 1 is the better default (most users want to cross-compile, not
script). Option 2 unlocks advanced use cases (custom flags, multi-target
batch builds, alternative bundlers).

---

## BUG-003: Top-level await in entrypoint breaks `bun build --compile --bytecode`

**Severity:** Medium — forced a synchronous-only design in our config loader.

### Symptom

When `src/hooks.ts` (the entrypoint passed to `hook-kit build`) uses
top-level await, the resulting `bun build --compile --bytecode` invocation
fails with a parser error pointing at the line *after* the await:

```text
src/hooks.ts:7:28
error: "await" can only be used inside an "async" function
  ...buildAllModules(await loadHookConfig()),
                           ^

src/hooks.ts:11:11
error: Expected ";" but found ":"
      name: "Suppress unjustified linter-disable comments",
            ^
```

The error message blames the awaiter, then cascades into the rest of the
file. Misleading; the real cause is that `bun build --compile` doesn't
support TLA in the entrypoint module.

### Where it bit us

ai-guardrails wants to load `cwd()/.ai-guardrails/config.toml` once at hook
startup. The natural shape is:

```typescript
const config = await loadHookConfig();
const modules = buildAllModules(config);
export default modules;
```

We had to refactor `loadHookConfig()` to be synchronous (`readFileSync`
instead of `readFile`) and call it without `await`. This worked because the
hook process is single-shot, but it's a real constraint on entrypoint design
that isn't documented in the SPEC.

### Proposed fix

Either:

1. **Document the constraint** in `docs/SPEC.md` § Build CLI — "the
   entrypoint must export `default modules` synchronously; no top-level
   await". Add a one-line note about why (bun --compile limitation).

2. **Make the wrapper await the import**, so the user's entrypoint can be
   async-default-exported. The generated entrypoint becomes:

   ```typescript
   const { default: modules } = await import(<userEntrypoint>);
   await runShell(modules);
   ```

   This shifts the await into hook-kit's wrapper (which bun's compiler
   handles), letting user entrypoints freely use TLA.

Option 2 is the cleaner consumer experience. Option 1 is the "document the
sharp edge" minimum.

---

## BUG-004: `Rule.evaluate(event, ctx)` signature trips test authors

**Severity:** Low — discoverable from types, but examples in
README/SPEC suggest a different shape.

### Symptom

When writing unit tests for a custom `content()` or `custom()` rule, the
natural pattern is:

```typescript
const rule = suppressCommentsRule();
const decision = await rule.evaluate(event);  // ← TS error: Expected 2 arguments
```

`Rule.evaluate` requires `(event: HookEvent, ctx: EvalContext)`. Building
an `EvalContext` by hand is non-trivial (it has `state: StateStore`,
`modules: HookModule[]`, `getBashAst(): Promise<File | null>`).

### Workaround

Tests should go through the public `evaluate(event, modules)` engine
function, which builds the context internally:

```typescript
import { createModule, evaluate } from "@questi0nm4rk/hook-kit";
const modules = [createModule({ id: "test", events: ["PostToolUse"], matchers: ["Edit"] }, [rule])];
const decision = await evaluate(event, modules);
```

This works correctly. But it's not the obvious shape from reading the
`Rule` interface, which exposes `evaluate(event, ctx)` directly.

### Proposed fix

Either:

1. **Add a test-helper export** like `evaluateRule(event, rule, opts?)`
   that builds a single-rule single-module context and evaluates it. Most
   useful documentation by code, not by prose.

2. **Document the testing pattern** in `docs/SPEC.md` § Rule builders or
   in a new `docs/TESTING.md` — "to test a rule, wrap it in `createModule`
   and call `evaluate(event, modules)`. Don't call `rule.evaluate` directly."

Both are cheap. Option 1 saves more typing per test.

---

## BUG-005: `HOOK_KIT_VERBOSE=1` produces no trace when WASM is broken

**Severity:** Low — but compounds BUG-001's invisibility.

### Symptom

```console
$ HOOK_KIT_VERBOSE=1 ~/.local/bin/ai-guardrails-hk -c "git push --force origin main" 2>&1
Everything up-to-date
exit=0
```

No `[hook-kit] event=PreToolUse tool=Bash …` trace line. With WASM broken,
the engine's verbose path apparently short-circuits before emitting the
trace, OR the trace-emission code itself depends on the engine completing
successfully.

In a normal (non-broken) compiled binary, a verbose decision *for an
escalating command* also doesn't emit a trace line — only the standard
`[hook-kit] needs review:` decision message appears on stdout. So
`HOOK_KIT_VERBOSE=1` may not be wired into the shell-wrapper path at all.

### Where it bit us

While debugging the v4.0.0 silent-allow regression, we expected
`HOOK_KIT_VERBOSE=1` to tell us *what* the engine thought it was doing
(modules loaded, rules considered, final decision). Instead we got
silence — same as without verbose. Pushed us toward `strings`-dumping the
binary to find the baked path.

### Proposed fix

Either:

1. Wire `HOOK_KIT_VERBOSE` through `runShell()` so it always emits one
   stderr trace line per evaluation (even for null decisions): `event=
   tool= modules-considered= modules-fired= final=null|deny|ask
   reason= time=`.

2. If verbose only fires for the cc-tools adapter today, document that
   limitation explicitly in `docs/SPEC.md` § Observability — currently the
   README implies it works for both modes.

Option 1 makes verbose a real diagnostic tool, not a partial one.

---

## BUG-006 (cosmetic): Decision marker double-prefixes the user label

**Severity:** Cosmetic.

### Symptom

```console
$ ai-guardrails-hk -c "git push --force origin main"
[hook-kit] needs review: [ai-guardrails] git push --force
```

The output convention prefixes the decision with `[hook-kit] needs review:`
and then the user's `label` (set via `ask("reason", "[ai-guardrails]")`)
appears as the next token. Two prefix-shaped tokens stacked.

### Possible fix

Drop the `[hook-kit]` prefix when the decision carries a label, OR move the
hook-kit marker after the label:

```console
[ai-guardrails] needs review: git push --force
```

vs current:

```console
[hook-kit] needs review: [ai-guardrails] git push --force
```

The user-set label is the more meaningful identifier (tells consumers
*which* hook plugin made the call), so leading with it reads better.

If keeping `[hook-kit]` as a routing tag is intentional, document the
two-prefix shape in the README so consumers know what to grep for in logs.

---
