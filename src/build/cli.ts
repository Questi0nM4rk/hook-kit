#!/usr/bin/env bun
// hook-kit CLI: build + escalation listener subcommands
// See docs/SPEC.md § Build CLI and § Escalation.

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { brokerAskpass, listPending, listSessions, submitDecision } from "../escalation/broker.js";
import { forwardUp } from "../escalation/forward.js";
import { registerListener } from "../escalation/listeners.js";
import { runWatchTui } from "../escalation/watch-tui.js";
import {
  type AdapterName,
  BuildError,
  generateHooksJson,
  runBuild,
  SUPPORTED_ADAPTERS,
} from "./bundle.js";

const HELP = `\
hook-kit — framework for building compiled hook binaries for AI coding agents

Build:
  hook-kit build <entrypoint> --out <path>
                              [--adapter claude-code|generic]
                              [--hooks-json <path>] [--binary-command <s>]
                              [--hook-timeout <seconds>]

  --hook-timeout is REQUIRED when --hooks-json is set (no default).
  hook-kit doesn't enforce its own timeout on escalate; this CC-side
  timeout is the ceiling. Pick deliberately:
    short (e.g. 5)    — plugins without escalate rules
    long (e.g. 3600)  — plugins where escalate may need a human

Escalation:
  hook-kit broker --askpass               Read an AskRequest from stdin and
                                          drive the spool. Used as
                                          $HOOK_KIT_ASKPASS by default.
  hook-kit list [--children-of <id>]      Snapshot active session ask channels.
                [--json]
  hook-kit subscribe [--session <id>]     Stream pending requests as JSON
                     [--children-of <id>] lines. Polls until interrupted.
                     [--poll-ms <n>]
  hook-kit decide <request_id>            Submit a decision atomically.
                  --allow | --deny | --escalate-up
                  --session <id>
                  [--reason <text>] [--by <name>]
                                          --escalate-up forwards the request
                                          to the parent session's spool and
                                          waits there. If no parent exists,
                                          terminates the chain at harness-ask
                                          so the harness's native UI handles
                                          it (no timeout — chain runs as long
                                          as the original hook process is alive).
  hook-kit watch [--session <id>]         Minimal TTY listener — print pending
                 [--children-of <id>]     requests as they arrive (no prompt
                 [--poll-ms <n>]          UI yet; pair with \`hook-kit decide\`).

Misc:
  hook-kit --help / -h
  hook-kit --version / -v
`;

// ─────────────────────────── argv helpers ────────────────────────────

function getArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/** Extract positional args (those not starting with `--` and not following a `--flag`). */
function positionals(argv: readonly string[]): string[] {
  return argv.filter((a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1]?.startsWith("--")));
}

/** `exactOptionalPropertyTypes` workaround: produce `{}` when value is undefined,
 *  `{ [key]: value }` otherwise. Keeps spread idioms compact at call sites. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function writeErr(message: string): void {
  process.stderr.write(message);
}

// ──────────────────────────── build ──────────────────────────────

async function buildCommand(argv: readonly string[]): Promise<number> {
  const entrypoint = positionals(argv)[0];
  if (entrypoint === undefined) {
    writeErr("hook-kit build: missing <entrypoint>\n");
    writeErr(HELP);
    return 1;
  }
  const out = getArg(argv, "--out");
  if (out === undefined) {
    writeErr("hook-kit build: --out is required\n");
    return 1;
  }
  const adapterArg = getArg(argv, "--adapter") ?? "claude-code";
  if (!(SUPPORTED_ADAPTERS as readonly string[]).includes(adapterArg)) {
    writeErr(
      `hook-kit build: unsupported adapter "${adapterArg}" (supported: ${SUPPORTED_ADAPTERS.join(", ")})\n`,
    );
    return 1;
  }
  const adapter = adapterArg as AdapterName;

  try {
    const result = await runBuild({ entrypoint, out, adapter });
    writeErr(`hook-kit: compiled ${result.binPath}\n`);

    const hooksJsonPath = getArg(argv, "--hooks-json");
    if (hooksJsonPath !== undefined) {
      const code = await writeHooksJson(argv, entrypoint, out, hooksJsonPath);
      if (code !== 0) return code;
    }
    return 0;
  } catch (err) {
    if (err instanceof BuildError) {
      writeErr(`hook-kit build: ${err.message}\n`);
      if (err.stderr !== "") writeErr(err.stderr);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`hook-kit build: ${message}\n`);
    return 1;
  }
}

async function writeHooksJson(
  argv: readonly string[],
  entrypoint: string,
  out: string,
  hooksJsonPath: string,
): Promise<number> {
  const binaryCommand =
    getArg(argv, "--binary-command") ??
    `\${CLAUDE_PLUGIN_ROOT}/${out.split(/[/\\]/).pop() ?? "hooks"}`;

  const timeoutStr = getArg(argv, "--hook-timeout");
  if (timeoutStr === undefined) {
    writeErr(
      "hook-kit build: --hook-timeout <seconds> is required when --hooks-json is set.\n" +
        "  Pick deliberately: short (e.g. 5) for hooks without escalate rules; long (e.g. 3600) when escalate may need a human in the loop.\n" +
        "  hook-kit does not enforce its own timeout on escalate; CC's hook timeout is the only ceiling.\n",
    );
    return 1;
  }
  const timeout = Number.parseInt(timeoutStr, 10);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    writeErr(`hook-kit build: invalid --hook-timeout "${timeoutStr}"\n`);
    return 1;
  }

  const absEntry = isAbsolute(entrypoint) ? entrypoint : resolve(process.cwd(), entrypoint);
  const userModules = await import(absEntry);
  const modules = (userModules.default ?? []) as Parameters<typeof generateHooksJson>[0];
  const json = generateHooksJson(modules, { binaryPath: binaryCommand, timeout });
  const absJsonPath = isAbsolute(hooksJsonPath)
    ? hooksJsonPath
    : resolve(process.cwd(), hooksJsonPath);
  writeFileSync(absJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  writeErr(`hook-kit: wrote ${absJsonPath}\n`);
  return 0;
}

// ────────────────────────── escalation ───────────────────────────

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function brokerCommand(argv: readonly string[]): Promise<number> {
  if (!hasFlag(argv, "--askpass")) {
    writeErr(
      "hook-kit broker: only --askpass mode is supported. The broker doesn't run as a long-lived daemon — listeners use list/subscribe/decide on the spool directly.\n",
    );
    return 1;
  }
  const stdinText = await readAllStdin();
  const response = await brokerAskpass(stdinText);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

async function listCommand(argv: readonly string[]): Promise<number> {
  const childrenOf = getArg(argv, "--children-of");
  const sessions = listSessions(optional("childrenOf", childrenOf));
  if (hasFlag(argv, "--json")) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
  } else if (sessions.length === 0) {
    writeErr("(no active sessions)\n");
  } else {
    for (const s of sessions) {
      const lineage = s.parentSessionId !== undefined ? ` ← ${s.parentSessionId}` : "";
      process.stdout.write(
        `${s.sessionId}${lineage}  pid=${s.pid}  pending=${s.pendingCount}  started=${s.startedAt}\n`,
      );
    }
  }
  return 0;
}

async function subscribeCommand(argv: readonly string[]): Promise<number> {
  const sessionFilter = getArg(argv, "--session");
  const childrenOf = getArg(argv, "--children-of");
  const pollMs = Number.parseInt(getArg(argv, "--poll-ms") ?? "100", 10);
  const seen = new Set<string>();

  // Register a listener marker so the validator sees us. We register on each
  // observed session — for --session/--children-of filters, we attach there;
  // for unbounded (all sessions), we attach lazily as sessions appear.
  const cleanups = new Map<string, () => void>();
  const ensureMarker = (sessionId: string): void => {
    if (cleanups.has(sessionId)) return;
    cleanups.set(sessionId, registerListener(sessionId, "subscribe"));
  };
  const onExit = (): void => {
    for (const c of cleanups.values()) c();
    cleanups.clear();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  if (sessionFilter !== undefined) ensureMarker(sessionFilter);

  while (true) {
    const sessions =
      sessionFilter !== undefined
        ? [{ sessionId: sessionFilter }]
        : listSessions(optional("childrenOf", childrenOf));
    for (const s of sessions) {
      ensureMarker(s.sessionId);
      for (const req of listPending(s.sessionId)) {
        if (seen.has(req.id)) continue;
        seen.add(req.id);
        process.stdout.write(`${JSON.stringify(req)}\n`);
      }
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

async function decideCommand(argv: readonly string[]): Promise<number> {
  const requestId = positionals(argv)[0];
  if (requestId === undefined) {
    writeErr("hook-kit decide: missing <request_id>\n");
    return 1;
  }
  const session = getArg(argv, "--session");
  if (session === undefined) {
    writeErr("hook-kit decide: --session is required\n");
    return 1;
  }
  const reason = getArg(argv, "--reason");
  const by = getArg(argv, "--by");

  if (hasFlag(argv, "--escalate-up")) {
    return decideEscalateUp(session, requestId, by);
  }

  const allow = hasFlag(argv, "--allow");
  const deny = hasFlag(argv, "--deny");
  if (allow === deny) {
    writeErr("hook-kit decide: pass exactly one of --allow / --deny / --escalate-up\n");
    return 1;
  }
  const decision = allow ? "allow" : "deny";
  const ok = submitDecision(session, requestId, decision, reason, optional("by", by));
  if (!ok) {
    writeErr(
      `hook-kit decide: a decision for ${requestId} was already submitted (first-writer-wins)\n`,
    );
    return 1;
  }
  writeErr(`hook-kit: decided ${requestId} → ${decision}\n`);
  return 0;
}

async function decideEscalateUp(
  session: string,
  requestId: string,
  by: string | undefined,
): Promise<number> {
  const result = await forwardUp(session, requestId, optional("by", by));
  switch (result.kind) {
    case "missing-pending":
      writeErr(
        `hook-kit decide --escalate-up: no pending request ${requestId} in session ${session}\n`,
      );
      return 1;
    case "harness-ask":
      writeErr(
        `hook-kit: forwarded ${requestId} → harness-ask (chain end at session ${session})\n`,
      );
      return 0;
    case "forwarded":
      writeErr(
        `hook-kit: ${requestId} decided as ${result.response?.decision} (parent ${result.parentSessionId})\n`,
      );
      return 0;
  }
}

async function watchCommand(argv: readonly string[]): Promise<number> {
  const sessionFilter = getArg(argv, "--session");
  const childrenOf = getArg(argv, "--children-of");
  const pollMs = Number.parseInt(getArg(argv, "--poll-ms") ?? "", 10);

  await runWatchTui({
    ...optional("sessionFilter", sessionFilter),
    ...optional("childrenOf", childrenOf),
    ...optional("pollMs", Number.isFinite(pollMs) ? pollMs : undefined),
  });
  return 0;
}

// ───────────────────────────── main ──────────────────────────────

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case "build":
      return buildCommand(rest);
    case "broker":
      return brokerCommand(rest);
    case "list":
      return listCommand(rest);
    case "subscribe":
      return subscribeCommand(rest);
    case "decide":
      return decideCommand(rest);
    case "watch":
      return watchCommand(rest);
    default:
      writeErr(`hook-kit: unknown command '${sub}'\n${HELP}`);
      return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
