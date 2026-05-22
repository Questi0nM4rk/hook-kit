// Stdout-prompt listener — a worked example of the listener-authoring
// contract documented in docs/ESCALATION.md § Listener authoring.
//
// Polls one session's spool, prints each new pending request to stdout,
// reads `allow|deny` from stdin, submits the decision via the broker's
// atomic O_EXCL write. Downstream consumers fork this for Slack /
// IDE / webhook / custom-UI integrations — replace the stdout print
// + stdin read with the target medium's I/O primitives.

import { createInterface } from "node:readline/promises";
import { listPending, registerListener, submitDecision } from "@questi0nm4rk/hook-kit/escalation";

const POLL_INTERVAL_MS = 250;
const DECISION_BY = `stdout-listener:pid${String(process.pid)}`;

async function main(sessionId: string): Promise<void> {
  const detach = registerListener(sessionId, "watch");
  process.on("SIGINT", () => {
    detach();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    detach();
    process.exit(0);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const decided = new Set<string>();

  process.stdout.write(`[listener] watching session ${sessionId} (Ctrl-C to quit)\n`);
  for (;;) {
    for (const req of listPending(sessionId)) {
      if (decided.has(req.id)) {
        continue;
      }
      process.stdout.write(
        `\n[listener] PENDING ${req.id}\n  tool: ${req.toolName}\n  reason: ${req.reason}\n  cwd: ${req.cwd}\n  toolInput: ${JSON.stringify(req.toolInput)}\n`,
      );
      // biome-ignore lint/performance/noAwaitInLoops: sequential human-prompt loop; parallelizing would render multiple prompts simultaneously and corrupt stdin.
      const answer = (await rl.question("[listener] decide allow/deny/skip > "))
        .trim()
        .toLowerCase();
      if (answer === "allow" || answer === "deny") {
        const ok = submitDecision(req.sessionId, req.id, answer, undefined, {
          by: DECISION_BY,
        });
        process.stdout.write(
          ok ? `[listener] ${answer} ${req.id}\n` : `[listener] ${req.id} already decided\n`,
        );
        decided.add(req.id);
      } else {
        process.stdout.write(`[listener] skipping ${req.id}\n`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const sessionId = process.argv[2];
if (sessionId === undefined || sessionId === "") {
  process.stderr.write("usage: bun src/listener.ts <sessionId>\n");
  process.exit(1);
}
await main(sessionId);
