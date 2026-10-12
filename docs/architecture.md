# Architecture

Iron Laws, adapters, escalation, layout and failure modes. Moved from the README.

## Iron Laws

The eight invariants the framework enforces. The full version lives in [`docs/SPEC.md`](SPEC.md). Load-bearing summary:

1. **Rules are data, not scripts.**
2. **Parse once, evaluate many** — one shell-AST per invocation, shared across all command/pipe/redirect rules.
3. **Recurse into inline shells** — `bash -c "…"`, `eval`, `exec` re-evaluate against the same modules. Default-on; depth-limited to 5.
4. **Fail open on infra errors** (with one exception: `ask` infra failure denies, never silent-allows).
5. **Blacklist semantics** — only `deny` / `ask` / `warning` / `note` / `null`.
6. **Output convention is the wire format** — `stdout` / `stderr` / exit-code, no JSON for the caller to parse.
7. **Each plugin compiles its own binary** — plugin isolation; one plugin's iteration doesn't disturb the others.
8. **Escalation is async, tree-shaped, out-of-band** — see [Escalation](#escalation).

---

## Adapter bins (opt-in extensions)

For harnesses with non-shell tool channels, build a companion binary alongside `hk`:

```bash
hook-kit build src/hooks.ts --out dist/hk-cc-tools --adapter cc-tools \
  --hooks-json hooks/hooks.json --hook-timeout 10
```

Wires into Claude Code via `hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write|NotebookEdit|Read",
      "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools","timeout":10}]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write|NotebookEdit",
      "hooks": [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools","timeout":10}]
    }]
  }
}
```

The two binaries cooperate. `hk` covers Bash; `hk-cc-tools` covers `Edit` / `Write` / `NotebookEdit` / `Read`. Same source, two builds.

Anyone can author additional adapter bins (`hk-cursor-tools`, `hk-opencode-tools`, …) — they are small stdin/stdout glue around the engine.

---

## Escalation

When a rule returns `ask`, the binary asks up the parent tree:

```text
[ root: harness UI (CC's native ask) ]
            |
[ agent session ]
        |- [ subagent A ]
        |       |- [ sub-subagent ]
        |- [ subagent B ]
```

A request publishes at the hook's own session spool. A listener attached to that session — or any ancestor session up the chain — sees it. If a listener doesn't want to decide, it forwards via `--escalate-up` to the next level. When the chain exhausts at the root, it terminates at `harness-ask` (CC's native `permissionDecision: "ask"` UI takes over with no timeout).

- **`HOOK_KIT_ASKPASS` unset** → no broker tree configured; the engine falls through to harness-ask immediately. Use this for simple "ask the user" hooks where you don't need a multi-agent escalation chain.
- **`HOOK_KIT_ASKPASS` set** → routes through the configured askpass (default: `hook-kit broker --askpass`). The broker validates that a live listener exists somewhere in the chain (`NO PARENT ATTACHED`); broken infra denies (Iron Law 4 exception).

### The askpass contract

Any program that reads JSON on stdin and writes a decision to stdout is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, the bundled broker.

The bundled `hook-kit broker --askpass` manages per-session ask channels at `~/.cache/hook-kit/sessions/$SESSION_ID/`:

```text
sessions/abc-123/
├── meta.json            # {parent_session_id?, started_at, pid}
├── pending/<id>.json    # the envelope
├── decided/<id>.json    # the decision (first-writer-wins via O_EXCL)
├── listeners/<pid>.lock # liveness markers — one per attached listener
└── audit.jsonl          # append-only event log
```

### Listening with the TUI

```bash
hook-kit watch                         # all sessions on this host
hook-kit watch --children-of $MY_ID    # only descendants of a session you spawn
hook-kit watch --session abc-123       # one specific session
```

```text
hook-kit watch                                3 pending  ·  1 listener attached

  SESSION             REQ-ID      AGE   TOOL      DETAILS
❯ abc-123             7f8a2b…     12s   Bash      git push --force origin main
  abc-123             3c4d5e…      3s   Write     /tmp/output.cs
  def-456             8b9c0a…      1m   Bash      rm -rf /tmp/scratch

  ┌─ details: 7f8a2b… ─────────────────────────────────────────
  │ harness:    claude-code
  │ project:    /home/me/proj
  │ git:        main (dirty) @ fc7f341  origin: git@github.com:o/r.git
  │ transcript: /tmp/cc-…/transcript.jsonl
  │ origin:     pid 41832 @ lab-01 (me)
  │ expires:    in 48s
  │ command:    git push --force origin main

↑↓/jk select  ·  allow  ·  deny  ·  escalate-up  ·  quit
```

Press `a` / `d` / `e` and the screen drops into a reason prompt.

### Listening programmatically

```bash
hook-kit subscribe --children-of $MY_SESSION_ID --json | while read req; do
  ID=$(jq -r .id <<<"$req")
  SESSION=$(jq -r .sessionId <<<"$req")
  hook-kit decide "$ID" --session "$SESSION" --allow --reason "in scope"
done
```

Forward up the tree without deciding:

```bash
hook-kit decide "$ID" --session "$SESSION" --escalate-up
```

### Hook timeout

`hook-kit` doesn't enforce timeouts on its own. The only ceiling is the harness's hook timeout (when going through `hooks.json`). The build CLI requires `--hook-timeout` when emitting `hooks.json`:

```bash
hook-kit build … --hook-timeout 5      # plugins without ask rules
hook-kit build … --hook-timeout 3600   # plugins where ask may need a human
```

#### `--hook-timeout` (build flag) vs `"timeout"` (hooks.json field)

These are the **same value** at different layers:

- `--hook-timeout N` is the **build-time argument** to `hook-kit build … --hooks-json`. It tells the CLI what value to write into the generated `hooks.json` next to every emitted hook entry. **Required** when `--hooks-json` is set — no default; pick deliberately.
- `"timeout": N` is the **runtime field** in the generated `hooks.json`. Claude Code reads it on every PreToolUse and bounds how long the hook process can run before SIGTERM.

If you bypass the build CLI and hand-write `hooks.json`, you'd just write `"timeout": N` directly. The `--hook-timeout` flag exists only so the build step can produce the same field without you opening the JSON. **Conceptually one value, two names** — if the two ever disagree (e.g., you regenerate `hooks.json` with a different `--hook-timeout`), the regenerated value wins because it overwrites the file.

---

## Architecture

```text
TypeScript (src/)
  cmd / pipe / redirect / path / content / stateful / custom  ─┐
                                                                ├─→ HookModule[]
                                       createModule(meta, rules)┘
                                                       │
                                                       │  bun build --compile --bytecode
                                                       ▼
  evaluate(event, modules) ─→ EvaluationOutcome { terminal, annotations }
                                                       │
                              ┌────────────────────────┼─────────────────────────┐
                              ▼                        ▼                         ▼
                       shell wrapper             cc-tools adapter         raw / library
                       hk -c "<cmd>"             hooks.json events        evaluate() direct
                       stdout/stderr/exit        JSON over stdin/stdout   any I/O shape
```

```text
src/
├── core/         types.ts, decision.ts, event.ts, module.ts
├── builders/     cmd(), path(), pipe(), redirect(), content(), custom(), stateful() — primitives only; no pre-built rules ship
├── engine/       evaluate() loop + helpers (flag aliases, inline-shell extraction)
├── wrapper/      hk.ts — runShell() (the default adapter)
├── adapters/     ProtocolAdapter: claude-code (cc-tools), raw
├── state/        StateStore: memory-store, tmpdir-store
├── escalation/   askpass, broker, envelope, forward, listeners, watch-tui, enrich-git
└── build/        hook-kit CLI: build, broker, watch, subscribe, decide, list
```

The engine is intentionally minimal — its only job is to map `(event, modules)` to `EvaluationOutcome`. Adapters translate that outcome into the harness's wire format. The shell wrapper is itself an adapter: it just renders to `stdout` / `stderr` / exit-code.

---

## Operational readiness

- **Failure modes:**
  - shell-AST WASM fails to load → all command/pipe/redirect rules return `null` (silent), stderr warning.
  - tmpdir/cache write fails → state lost, hook returns `null` (silent).
  - Rule throws → caught, treated as `null` (silent), logged.
  - Stdin empty/malformed (cc-tools adapter) → adapter exits 0 silent.
  - `ask` without `HOOK_KIT_ASKPASS` set → falls through to harness-ask. The harness UI is itself a responder, so this is not silent-allow.
  - `ask` with broken askpass infra (binary missing / non-zero exit / malformed output) → deny with `[hook-kit] askpass …`. Iron Law 4 exception.
  - `ask` with broker `NO PARENT ATTACHED` → deny. Surfaces misconfigured plugins immediately instead of hanging on the hook timeout.
- **Deployment:** Compiled binary committed under the plugin (`dist/hk` for the wrapper, optionally `dist/hk-cc-tools` for the CC tool-call companion). For cc-tools, `hooks.json` points to `${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools`. CI rebuilds on push. Plugin pins to `^major.minor`.
- **Rollback:** Delete the compiled binary; restore the previous version from git. Per-plugin binaries mean one broken plugin doesn't affect others.

---

## Design rationale

The full **trade-off rationale** (why shell-wrapper-as-default, why fail-open, why filesystem spool, etc.) and the **change-trigger assumptions** (what the design assumes and when to revisit each area) live in [`docs/SPEC.md`](SPEC.md) § Key Trade-offs and § Change triggers.
