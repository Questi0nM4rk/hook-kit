# Guide

Rule recipes, builders, output convention, observability and CLI reference. Moved from the README.

## Highlights

- **Five-decision blacklist semantics** — `null` (silent pass), `deny` (stderr + exit 2, annotations dropped), `ask` (needs review, annotations bundled), `warning` / `note` (non-blocking annotations rendered above `---` separator before exec output). No `allow` — silent = nothing was wrong.
- **Shell-AST-aware command matching** — `cmd("rm")` matches `sudo -u root rm /etc/passwd` via `unwrapCall`, recurses into `bash -c "rm …"` via inline-shell extraction, expands compound shorts (`-rf` ≡ `-r -f`), aliases canonicalized (`-r` ≡ `-R` ≡ `--recursive`), quoted-flag bypass closed.
- **First-class `pipe()` and `redirect()` builders** — `BinaryCmd` and `Stmt` redirections need different traversal than `cmd()`. Canonical patterns (`curl … | bash`, `echo evil > /etc/passwd`) wouldn't otherwise be expressible without these.
- **Tree-shaped escalation** — `ask` rules publish to a per-session filesystem spool. A listener attached anywhere up the parent tree can `allow` / `deny` / `escalate-up`. Exhausting the chain terminates at the harness's native ask UI. Bundled `hook-kit watch` TUI, programmable via `hook-kit subscribe --json`.
- **State across invocations** — `stateful(id, fn)` rules persist via `TmpdirStore` (default) or any custom `StateStore` implementation. Useful for rate-limiting, sequence detection, session-level invariants.
- **Adapter bins are small** — anyone can author `hk-cursor-tools`, `hk-opencode-tools`, etc. Same engine, same rule definitions, just a different `stdin → HookEvent → stdout` glue.
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

Each `DecisionEventRecord` carries a timestamp, rule id, decision kind, reason, optional label, per-rule `timingMs`, and an `event` sub-shape. `toolInput` is **never** logged — only its sha256 hex hash — so observers don't leak secrets by default. A throw from `onDecision` is caught, surfaced as an `ObserverError` `error` annotation, and the decision proceeds (fail-open at the observer boundary). The default zero-observer path is zero-overhead. The testing SDK ships `mockObserver()` for asserting the decision stream. Full contract in [`docs/SPEC.md`](SPEC.md) § Observability.

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

## Examples

[`examples/ai-guardrails/`](../examples/ai-guardrails/) is a port of [ai-guardrails](https://github.com/Questi0nM4rk/ai-guardrails) — six rule groups (destructive-rm, git-force-push, git-destructive, git-bypass-hooks, chmod-world-writable, remote-code-exec), path/redirect protection, and suppress-comments — built as both `dist/hk` and `dist/hk-cc-tools`.

```bash
cd examples/ai-guardrails
bun install
bun run build      # produces dist/hk + dist/hk-cc-tools
```

See [`examples/ai-guardrails/README.md`](../examples/ai-guardrails/README.md) for the rule list and integration walkthrough.
