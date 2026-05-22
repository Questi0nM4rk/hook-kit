// Compiled-binary entry point for the adapter template. Wires real
// `process.*` handles into `createMyAdapter`, wires an optional JSONL
// observer from `TEMPLATE_OBSERVER_LOG`, and dispatches to hook-kit's
// `run()`. The hooks module list comes from the default export of
// `./hooks.ts` — replace those stubs with your own rule composition.

import { appendFileSync } from "node:fs";
import { type DecisionEventRecord, type DecisionObserver, run } from "@questi0nm4rk/hook-kit";
import { hooks } from "./hooks.js";
import { createMyAdapter } from "./my-adapter.js";

/** Build a file-appending observer when the env var is set. Returns
 *  `undefined` if observability is not wired so the engine's zero-overhead
 *  default path stays hot. Errors from the appendFileSync are caught and
 *  surfaced as engine `error` annotations (the observer throw fail-open
 *  path, see docs/SPEC.md § Observability). */
function buildObserverFromEnv(): DecisionObserver | undefined {
  const logPath = process.env.TEMPLATE_OBSERVER_LOG;
  if (logPath === undefined || logPath === "") {
    return;
  }
  return {
    onDecision(record: DecisionEventRecord): void {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}

// Wrapped because `bun build --compile --bytecode` rejects top-level await
// in any module reachable from the entrypoint. Canonical workaround mirrored
// from `src/build/bundle.ts` — chain a `.catch` so biome's `noVoid` rule
// stays happy AND any uncaught failure surfaces to stderr instead of
// silently sinking.
async function dispatch(): Promise<void> {
  const observer = buildObserverFromEnv();
  const adapter = createMyAdapter({
    streams: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exit: (code: number): void => process.exit(code),
    },
  });

  // `run()` is the canonical adapter entry. It calls adapter.readInput →
  // evaluate → adapter.writeOutput on the happy path, or adapter.handleError
  // on any throw. The `observers` option is what makes M1.1's
  // DecisionObserver wiring reach the engine.
  await run(hooks, adapter, observer === undefined ? {} : { observers: [observer] });
}

dispatch().catch((err: unknown) => {
  // Last-resort surfacing for anything `adapter.handleError` doesn't catch
  // (module-load failure, dispatch() throw before run() takes over). Per
  // docs/ADAPTERS.md zero-silent-fails.
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[template-demo] fatal (pre-run): ${msg}\n`);
  process.exit(2);
});
