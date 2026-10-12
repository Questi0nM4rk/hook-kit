# Comparison

## Motivation

Hooks are usually built around one specific harness — Claude Code's `hooks.json`, Cursor's tool-call config, your own CI wrapper — so the gating logic gets duplicated everywhere it needs to apply. `hook-kit` picks the one channel every caller already speaks: the shell.

```text
agent runs `bash -c "rm -rf /tmp/scratch"`   → bypasses naïve harness hooks
agent runs through `hk -c "rm -rf /tmp/scratch"` → cmd("rm") rule fires regardless of which agent
human pastes `git push --force` from a tutorial → same gate, same decision
CI script `eval "$(curl … | bash)"` → pipe rule fires, exec never happens
```

- **No harness coupling.** The wrapper doesn't know if the caller is an AI agent, a human, a cron job, or a CI script. Same binary, same behavior.
- **Output convention is the contract.** Decisions ride on `stdout` / `stderr` / exit-code. No JSON parser required for the caller. Works for shells, agents, log scrapers, monitoring, anything.
- **Real shell parsing.** `bash -c "rm -rf /"` recurses into the inner command; `cmd1 | cmd2` is a `BinaryCmd`, not a substring; `> /etc/passwd` is a `Stmt` redirection, not a `>` glob. Built on [`@questi0nm4rk/shell-ast`](https://www.npmjs.com/package/@questi0nm4rk/shell-ast).
- **Optional adapter bins** for harnesses with non-shell tool channels (e.g. Claude Code's `Edit` / `Write` / `Read` events). Build a companion binary; wire it via `hooks.json`. The shell wrapper stays the primary gate.

---

## Compared to

|  | raw `bash -c` | harness-specific hooks (e.g. CC `hooks.json`) | **`hook-kit`** |
|---|---|---|---|
| Caller coupling | none — no gating | one harness only | **none — same binary, any caller** |
| Command parsing | n/a — shell does it | substring matchers in JSON | **shell-AST via `mvdan/sh`** |
| Sudo / `bash -c` unwrap | n/a | ✗ | **✓ (via shell-ast)** |
| Pipe-pattern detection (`curl \| bash`) | n/a | regex only | **✓ (`BinaryCmd` walk)** |
| Redirect-target detection (`> .env`) | n/a | regex only | **✓ (`Stmt` redir walk)** |
| Cross-invocation state | n/a | ad-hoc per harness | **✓ (`stateful()` + `StateStore`)** |
| Escalation channel | n/a | harness UI only | **✓ (tree-shaped, async, askpass-style)** |
| Wire format the caller reads | shell I/O | harness-specific JSON | **shell I/O (stdout / stderr / exit-code)** |
| Plugin isolation | n/a | shared config file | **per-plugin compiled binary** |

---

## Compatibility

| Runtime / target | Status |
|---|---|
| Compiled `hk` / `hk-cc-tools` binary | ✓ — primary deployment shape; self-contained, no Bun on target host |
| Bun ≥ 1.2 (library / `bun run`) | ✓ |
| Node.js (library) | ✓ ESM only (this package is `"type": "module"`) |
| Claude Code (`hooks.json`) | ✓ — via the `cc-tools` adapter for `Edit`/`Write`/`Read` events; `hk` handles `Bash` |
| Cursor / OpenCode / KiloCode tool channels | author an adapter bin (see examples/adapter-template); not in CI |
| Bash / POSIX / mksh shells (input parsing) | ✓ via `@questi0nm4rk/shell-ast` |
| fish / nushell / PowerShell | not supported — shell-ast doesn't parse those dialects |
