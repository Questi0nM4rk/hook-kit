<div align="center">

# `hook-kit`

**A TypeScript library that compiles command-gating rules into one `hk` binary, used in place of `bash -c` by AI agents, humans or CI scripts.**

[![npm](https://img.shields.io/npm/v/@questi0nm4rk/hook-kit?color=cb3837&label=npm)](https://www.npmjs.com/package/@questi0nm4rk/hook-kit)
[![CI](https://github.com/Questi0nM4rk/hook-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Questi0nM4rk/hook-kit/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/@questi0nm4rk/hook-kit?color=blue)](./LICENSE)

</div>

A rule in TypeScript:

```typescript
import { createModule, cmd } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "force-push", name: "Block force push", events: ["PreToolUse"], matchers: ["Bash"] },
    [cmd("git", "push").withFlag("--force").withoutFlag("--force-with-lease")
      .deny("Use --force-with-lease, not raw --force")],
  ),
];
```

The compiled binary, run in place of `bash -c`:

```text
$ hk -c "git push --force origin main"
[hook-kit] denied: Use --force-with-lease, not raw --force      (stderr, exit 2)
$ hk -c "echo hello"
hello
```

## Why it exists

Hooks are usually written for one harness, such as the `hooks.json` of Claude Code, so the same gating logic is copied to every place that runs commands.
Agents also reach shell commands through paths a harness hook does not see, such as `sudo`, `bash -c "..."` and `curl | bash`.
hook-kit gates at the one channel every caller shares, the shell command string, and parses it with a real shell parser instead of regexes.
It refuses to be a sandbox or a security boundary, and it fails open when its own code breaks.
It would have no reason to exist if harnesses gave every caller one shared, parsed command gate.

## Quickstart

Requires Bun 1.2+ (tested with 1.3.14).

```bash
git clone https://github.com/Questi0nM4rk/hook-kit && cd hook-kit && bun install
```

```bash
(cd examples/ai-guardrails && bun install && bun run build:hk) && examples/ai-guardrails/dist/hk -c "git push --force origin main"
# [git-force-push] needs review: git push --force (use --force-with-lease)
# exit code 1
```

```bash
bun run test
# 851 pass + 7 pass + 15 pass, 0 fail
```

The example rules ask for review (exit 1) instead of deny (exit 2). The example builds against the published npm package, not your clone.

## How it works

```mermaid
flowchart LR
  A[caller: agent, human, CI] -->|hk -c "cmd"| B[hk binary]
  B --> C[shell-ast parse]
  C --> D[rule engine]
  D -->|no match| E[exec command]
  D -->|deny| F[stderr + exit 2]
  D -->|ask| G[exit 1, or escalate to a listener]
```

The binary parses the command with [shell-ast](https://github.com/Questi0nM4rk/shell-ast) and runs your rules on the result.
A rule can deny, ask, warn, note or stay silent. Decisions go out as stdout, stderr and the exit code. There is no JSON protocol with the caller.

Everything here is deterministic. No part of hook-kit calls a model.

Fail-open is a design choice.
If a rule throws, the parser fails to load or the state store cannot write, the command runs and an `error` line goes to stderr.
The exception is `ask` with a broken askpass or no listener, which denies. Rules that must never be bypassed belong in the harness's own deny list.
The known gaps are listed under Status.

More in [docs/architecture.md](docs/architecture.md) and [docs/guide.md](docs/guide.md).

## Numbers

Measured 2026-10-12 on Arch Linux, Bun 1.3.14.

| What | Value | How measured |
| --- | --- | --- |
| Tests | 873 pass, 0 fail (851 + 7 + 15) | `bun run test` |
| Test time | about 19 s | `time bun run test` |
| Source size | 4714 code lines, 45 files | `scc src --no-cocomo` |
| `hk` binary | 90.7 MB | `bun run build:hk` in `examples/ai-guardrails`, then `ls -lh dist/hk` |
| Cost per `hk -c true` | about 87 ms wall | `time` over 20 runs in a shell loop, divided by 20 |

Commits include agent-authored work under my identity; design, orchestration and review are mine.

## Status

- **Works:** shell-wrapper `hk` binary; `cmd`, `pipe` and `redirect` rules;
  `deny`, `ask`, `warning` and `note` decisions; state across invocations; escalation spool with a TUI listener; a testing SDK; a Claude Code adapter for `Edit`, `Write` and `Read` events.
- **Experimental:** the escalation tree (`ask` forwarded up a chain of listeners). Only the Claude Code and raw adapters ship;
  [docs/ADAPTERS.md](docs/ADAPTERS.md) explains how to write one for another harness.
- **Known gaps:**
  - Fail-open means a hook bug lets a command run.
  - Only bash, POSIX and mksh parse; fish, nushell and PowerShell do not.
  - Each `hk` call costs the binary start time (see Numbers).
  - The binary is large because it embeds the Bun runtime.
  - Version `0.x` has no stability promise beyond [docs/STABILITY.md](docs/STABILITY.md).
  - Open friction is tracked in [docs/BUGS.md](docs/BUGS.md).

Reference: [guide](docs/guide.md), [architecture](docs/architecture.md), [comparison](docs/comparison.md), [development](docs/development.md),
[spec](docs/SPEC.md), [adapters](docs/ADAPTERS.md), [escalation](docs/ESCALATION.md), [state](docs/STATE.md), [changelog](CHANGELOG.md).

## License

MIT. Built on [shell-ast](https://github.com/Questi0nM4rk/shell-ast) (MIT), which wraps [mvdan/sh](https://github.com/mvdan/sh) (BSD-3).
