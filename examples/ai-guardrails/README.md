# ai-guardrails example

A faithful port of [ai-guardrails](https://github.com/Questi0nM4rk/ai-guardrails)
built on `@questi0nm4rk/hook-kit`. One compiled binary covers what the original
did via four separate Claude Code hooks (`dangerous-cmd`, `protect-configs`,
`protect-reads`, `suppress-comments`) plus its own check engine.

## What it blocks / asks

| Module | Triggers on | Decision |
|---|---|---|
| `destructive-rm` | `rm -rf …` (any flag aliases) | escalate |
| `git-force-push` | `git push --force` without `--force-with-lease` | escalate |
| `git-destructive` | `git reset --hard`, `git checkout --`, `git restore --`, `git clean -f`, `git branch -D` | escalate |
| `git-bypass-hooks` | `git commit --no-verify`, `git commit -n` | escalate |
| `chmod-world-writable` | `chmod -R 777`, `chmod -R a+rwx` | escalate |
| `remote-code-exec` | `curl … \| bash` (and other fetcher → shell pipes) | escalate |
| `protect-configs` | Edit/Write to `.env`, `biome.json`, `.claude/settings.json`, `package.json`, etc. | escalate |
| `protect-reads` | Read of `.env`, `~/.ssh/`, `~/.gnupg/` | escalate |
| `protect-from-redirects` | `cmd > .env` and similar — closes the Bash-redirect bypass | escalate |
| `suppress-comments` | PostToolUse: linter-disable comment added without `ai-guardrails-allow:` justification | escalate |

`escalate` decisions delegate to the harness UI when no broker is configured
(prompts the CC user). Configure `HOOK_KIT_ASKPASS=hook-kit broker --askpass`
to route through the broker tree instead, where parent agents or scripted
listeners can answer via `hook-kit decide`.

## Building

```bash
cd examples/ai-guardrails
bun install
bun run build
```

Produces `dist/hooks` — a self-contained ~50 MB bytecode binary with sub-50 ms
cold start. Wire into Claude Code via `hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/dist/hooks", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/dist/hooks", "timeout": 10 }]
      }
    ]
  }
}
```

(Or generate it: `hook-kit build … --hooks-json hooks.json --hook-timeout 10`.)

## How it maps to hook-kit primitives

- **`cmd(name, ...sub).withFlag(…).withoutFlag(…).withDdash().argIncludes(…).escalate(…)`** → all six command-rule groups.
- **`pipe(from, into).escalate(…)`** → `remote-code-exec`. AG's pipe-rule kind, now first-class.
- **`redirect(pathPattern).escalate(…)`** → `protect-from-redirects`. Closes the path-protection bypass that AG handled in `engine-helpers.checkRedirectsAgainstPathRules`.
- **`path(re).onWrite() / .onRead().escalate(…)`** → `protect-configs` + `protect-reads`.
- **`custom("suppress-comments", fn)`** → `suppress-comments`. PostToolUse, reads file from disk, scans for unjustified linter-disable comments.

The engine recurses into `bash -c "rm -rf /"` automatically (default-on
`recurseInlineShells`), so commands hidden inside an inline shell still trigger
their respective rules — no extra rule needed.

## What's intentionally not ported

- AG's `ALL_RULE_GROUPS` discoverable disabled-groups config — the example uses
  hook-kit's `enabled: false` per-module. Same effect, simpler.
- AG's TOML config loader for managed-files / managed-paths — keep paths hardcoded
  in this port. Real consumers can wrap in their own config-loading layer.
- AG's `tee`/`cp`/`mv`/`sed -i` argument-destination checks against path rules —
  hook-kit doesn't yet have a generic builder for "this command writes to which
  arg." Use `redirect()` for the common `cmd > path` case; if you need the rest,
  write a `custom()` rule.
