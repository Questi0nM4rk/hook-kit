# hook-kit escalation listener — stdout-prompt worked example

A minimal listener for hook-kit's escalation tree: polls one session's spool, prints each new `pending/<id>.json` to stdout, reads a decision (`allow` / `deny` / `skip`) from stdin, submits via the broker's atomic O_EXCL write. Downstream consumers fork this for Slack / IDE / webhook / custom-UI integrations — replace the stdout print + stdin read with the target medium's I/O primitives.

This is **not** a production listener. It is the skeleton you copy when bridging a new listener channel into hook-kit's broker tree. The full contract for what a listener must do is in [`docs/ESCALATION.md`](../../docs/ESCALATION.md) at the repository root.

## What this demonstrates

- The 3 things every listener does (per [`docs/ESCALATION.md`](../../docs/ESCALATION.md) § Listener authoring):
  1. **Detect.** Calls `registerListener(sessionId, "watch")` to drop a `<pid>.lock` marker so the broker's NO PARENT ATTACHED validator sees us as live; polls `listPending(sessionId)` every 250ms.
  2. **Decide.** Reads `allow` / `deny` / `skip` from the user on stdin via `node:readline/promises`. A real listener replaces this with its own decision logic (LLM call, policy match, Slack-button webhook, IDE-modal response, etc.).
  3. **Respond.** Calls `submitDecision(sessionId, requestId, "allow"|"deny", reason?, { by })`. The first-writer-wins `O_EXCL` semantics handle the case where multiple listeners try to answer simultaneously.

- The escalation imports from `@questi0nm4rk/hook-kit/escalation` (subpath barrel). The envelope schema + `PROTOCOL_VERSION` are `@stable`; the broker / listener / forwarder primitives are `@internal` for v1.0 (see [`docs/STABILITY.md`](../../docs/STABILITY.md)).

## Fork this

```bash
cp -r examples/escalation-listener-stdout/ examples/my-custom-listener/
cd examples/my-custom-listener/
# Then edit src/listener.ts per "What to change" below.
```

The example lives under `examples/` in the hook-kit repo. When forking into a separate repository, you also need to:

- Switch the `"@questi0nm4rk/hook-kit": "*"` dependency to a real published version.
- Install with `bun install` to populate `node_modules/` (this example uses a symlinked `node_modules/@questi0nm4rk/hook-kit` for in-repo dev).
- Ship a `tsconfig.json` if you do not have one.

## What to change

When bridging a new listener channel, modify `src/listener.ts`:

1. **Replace stdin reads** (the `rl.question(...)` call) with your medium's input primitive — webhook POST handler, Slack button-click event, IDE-side IPC message, MCP elicitation response, etc.
2. **Replace stdout writes** (the `process.stdout.write(...)` calls rendering the pending request) with your medium's output primitive — Slack `chat.postMessage`, IDE notification, webhook POST to a UI server, MCP elicitation request.
3. **Adjust the polling interval** if the medium has its own event push (e.g. Slack RTM, WebSocket subscription). For event-driven mediums, drop the `setTimeout` poll loop entirely and call `submitDecision` from the event handler.
4. **Add forwarding logic** if the listener should escalate-up under some conditions (call `forwardUp(sessionId, requestId)` instead of `submitDecision`). See `src/escalation/forward.ts` for the one-hop semantics.
5. **Wire authentication** if the medium needs it (Slack token, OAuth, mTLS). The broker itself runs as the same user; the listener authenticates upstream to the human/decision-maker, not to the broker.

## Run

```bash
# In one terminal: start a hook-kit session and stage a pending ask.
# (Typically this happens automatically when a rule emits `.ask(...)` and
# HOOK_KIT_ASKPASS is set to `hook-kit broker --askpass`.)

# In another terminal: attach this listener.
cd examples/escalation-listener-stdout/
bun src/listener.ts <sessionId>

# The listener prints each PENDING request and prompts for allow/deny/skip.
# Answers are written atomically to ~/.cache/hook-kit/sessions/<sessionId>/decided/<id>.json.
```

## What this does NOT demonstrate

- **A `ProtocolAdapter`.** Adapters bridge a harness's event stream INTO hook-kit's engine. Listeners bridge OUT of hook-kit's escalation tree TO a decision-maker. They are different roles. See [`examples/adapter-template/`](../adapter-template/) for the adapter pattern; see [`docs/ADAPTERS.md`](../../docs/ADAPTERS.md) for the adapter contract.
- **Authentication.** The broker runs as the same user as the hook process; there's no auth boundary between them. The listener authenticates to its decision-maker (the human, the Slack workspace, the IDE), not to the broker. Add auth in your fork as appropriate.
- **Forwarding.** The example only decides locally. To forward up the chain (escalate-up), call `forwardUp(sessionId, requestId)` from `@questi0nm4rk/hook-kit/escalation` instead of `submitDecision`. The forwarder is synchronous and bounded by the source hook's lifetime (per [`docs/ESCALATION.md`](../../docs/ESCALATION.md) § Tree semantics).
- **Audit log integration.** The broker appends to `audit.jsonl` automatically for every event in this session. A more sophisticated listener might tail that file and ship records to a log sink (syslog, OTLP, Splunk HEC). Use a `DecisionObserver` on the hook side for the structured-record version; the audit log is for operator visibility.

## Testing

The example does not ship its own test suite — the listener-authoring contract is exercised by `tests/integration/escalation-e2e.test.ts` at the repo root. That suite drives `submitDecision` + `listPending` against a mock escalation envelope and validates the broker's atomic write semantics, observer wiring, and protocol-version handling.

To smoke-test this listener manually:

```bash
# Stage a pending request in a test spool.
bun -e '
import { mkdirSync, writeFileSync } from "node:fs";
import { createAskRequest } from "@questi0nm4rk/hook-kit/escalation";
const root = "/tmp/listener-smoke-test";
const sid = "smoke-session";
mkdirSync(`${root}/${sid}/pending`, { recursive: true });
mkdirSync(`${root}/${sid}/listeners`, { recursive: true });
const req = createAskRequest({ sessionId: sid, toolName: "Bash", toolInput: { command: "rm -rf /tmp/x" }, reason: "smoke test" });
writeFileSync(`${root}/${sid}/pending/${req.id}.json`, JSON.stringify(req));
writeFileSync(`${root}/${sid}/meta.json`, JSON.stringify({ sessionId: sid, startedAt: new Date().toISOString(), pid: process.pid }));
console.log("staged", req.id);
'

# Then run this listener pointing at the same root. (Listener uses
# the default HOME-based root by default; for a different root, fork the
# example to accept --root or set XDG_CACHE_HOME accordingly.)
```
