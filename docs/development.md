# Development

## Quality bar

- **873 tests** covering rule builders (incl. `pipe` / `redirect` / `withDdash`), the engine (incl. inline-shell recursion + depth limit + the `DecisionObserver` feed), the shell wrapper output convention, the cc-tools adapter, both state stores, the entire escalation system (envelope schemas, askpass child-process invocation, broker spool atomicity, listener marker liveness, `NO PARENT ATTACHED` validator, escalate-up forwarding, the TUI render function), git enrichment, and real compile + execute end-to-end smokes for both binary modes. (Run via `bun run test` — the regular suite plus the isolated- and example-test processes.)
- **CI gate** (`.github/workflows/test.yml`) — `bun install --frozen-lockfile` + `biome check` + `bun test` on push to main and every PR. Red CI = no merge.
- **`mock.module()` isolation** — Bun's process-sticky module mocks ([oven-sh/bun#14516](https://github.com/oven-sh/bun/issues/14516)) would poison sibling tests in the regular suite. The `tests-isolated/` directory runs as its own `bun test` process so each isolated test file is its own context.
- **Compiled-binary smoke tests** baked in — `tests/build/example-ai-guardrails.test.ts` and `tests/build/adversarial.test.ts` build a real `dist/hk` and run 50+ adversarial inputs (alias expansion, sudo unwrap, inline-shell recursion, redirects, edge cases). A regression in the bundler or shell-ast WASM loading fails the build, not silently fails at user-deploy.
- **Annotation-rendering contract** asserted in `tests/build/warning-annotation.test.ts` — `[label] warning: <msg>` lines + `---` separator + exec output below, byte-for-byte.

```bash
bun test                          # everything (about 19s on the machine in the README Numbers table)
bun test tests/escalation         # one directory
bun test --grep "shortCircuit"    # by name
```

---

## Development

Prerequisites: Bun ≥ 1.2 (used as runtime, test runner, and binary compiler), TypeScript 6.

```bash
git clone https://github.com/Questi0nM4rk/hook-kit
cd hook-kit
bun install
bun run test            # full suite (see Numbers in the README)
bun run typecheck       # tsc --noEmit
bun run lint            # biome + eslint
bun run build           # emit dist/types
bun run build:bin       # compile the hook-kit CLI binary itself
```

The npm `test` script runs three separate `bun test` processes (under a coverage-floor wrapper):

```bash
bun scripts/check-coverage.ts && bun test tests-isolated/ && bun test examples/adapter-template/tests/
```

(`check-coverage.ts` internally runs `bun test tests/ --coverage` — the regular suite.)

- `tests/` — the regular suite.
- `tests-isolated/` — tests that need `mock.module()` for module-level mocks. Bun's `mock.module()` is process-sticky across files ([oven-sh/bun#14516](https://github.com/oven-sh/bun/issues/14516)) and would poison sibling tests in the regular suite. The split keeps each isolated test file its own `bun test` process. **Don't add `mock.module()` to anything under `tests/` — put it under `tests-isolated/` instead.**
- `examples/adapter-template/tests/` — the adapter-template's own in-process unit tests, run in their own process for the same isolation reason.

### Releasing

Pushing a `v*` tag stages to npm through `.github/workflows/release.yml` (npm trusted publishing: no token); a maintainer approves the staged version on npmjs.com with 2FA before it is live. The workflow fails unless the tag matches the `version` in `package.json`. To ship a new version:

```bash
# 1. set "version" in package.json to X.Y.Z, then:
git commit -am "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Versions are `X.Y.Z-beta.N` under the npm dist-tag `beta`; nothing is promised in a beta.
