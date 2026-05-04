#!/usr/bin/env bun
// hook-kit CLI: build + escalation listener subcommands
// See docs/SPEC.md § Build CLI and § Escalation.

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { brokerAskpass, listPending, listSessions, submitDecision } from "../escalation/broker.js";
import { BuildError, generateHooksJson, runBuild } from "./bundle.js";

const HELP = `\
hook-kit — framework for building compiled hook binaries for AI coding agents

Build:
  hook-kit build <entrypoint> --out <path> [--adapter claude-code]
                              [--hooks-json <path>] [--binary-command <s>]
                              [--hook-timeout <seconds>]

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
                  --allow | --deny
                  [--reason <text>] [--session <id>] [--by <name>]
  hook-kit watch [--session <id>]         Minimal TTY listener — print pending
                 [--children-of <id>]     requests as they arrive (no prompt
                 [--poll-ms <n>]          UI yet; pair with \`hook-kit decide\`).

Misc:
  hook-kit --help / -h
  hook-kit --version / -v
`;

function getArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

// ──────────────────────────── build ──────────────────────────────

async function buildCommand(argv: readonly string[]): Promise<number> {
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1]?.startsWith("--")),
  );
  const entrypoint = positional[0];
  if (entrypoint === undefined) {
    process.stderr.write("hook-kit build: missing <entrypoint>\n");
    process.stderr.write(HELP);
    return 1;
  }
  const out = getArg(argv, "--out");
  if (out === undefined) {
    process.stderr.write("hook-kit build: --out is required\n");
    return 1;
  }
  const adapter = (getArg(argv, "--adapter") ?? "claude-code") as "claude-code";
  if (adapter !== "claude-code") {
    process.stderr.write(`hook-kit build: unsupported adapter "${adapter}"\n`);
    return 1;
  }

  try {
    const result = await runBuild({ entrypoint, out, adapter });
    process.stderr.write(`hook-kit: compiled ${result.binPath}\n`);

    const hooksJsonPath = getArg(argv, "--hooks-json");
    if (hooksJsonPath !== undefined) {
      const binaryCommand =
        getArg(argv, "--binary-command") ??
        `\${CLAUDE_PLUGIN_ROOT}/${out.split(/[/\\]/).pop() ?? "hooks"}`;
      const timeoutStr = getArg(argv, "--hook-timeout") ?? "65";
      const timeout = Number.parseInt(timeoutStr, 10);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        process.stderr.write(`hook-kit build: invalid --hook-timeout "${timeoutStr}"\n`);
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
      process.stderr.write(`hook-kit: wrote ${absJsonPath}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof BuildError) {
      process.stderr.write(`hook-kit build: ${err.message}\n`);
      if (err.stderr !== "") process.stderr.write(err.stderr);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hook-kit build: ${message}\n`);
    return 1;
  }
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
    process.stderr.write(
      "hook-kit broker: only --askpass mode is supported. The broker doesn't run as a long-lived daemon — listeners use list/subscribe/decide on the spool directly.\n",
    );
    return 1;
  }
  const stdinText = await readAllStdin();
  const response = await brokerAskpass(stdinText);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  return 0;
}

function listCommand(argv: readonly string[]): number {
  const childrenOf = getArg(argv, "--children-of");
  const sessions = listSessions(childrenOf !== undefined ? { childrenOf } : {});
  if (hasFlag(argv, "--json")) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
  } else if (sessions.length === 0) {
    process.stderr.write("(no active sessions)\n");
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

  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  while (true) {
    const sessions =
      sessionFilter !== undefined
        ? [{ sessionId: sessionFilter }]
        : listSessions(childrenOf !== undefined ? { childrenOf } : {});
    for (const s of sessions) {
      const pending = listPending(s.sessionId);
      for (const req of pending) {
        if (seen.has(req.id)) continue;
        seen.add(req.id);
        process.stdout.write(`${JSON.stringify(req)}\n`);
      }
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

function decideCommand(argv: readonly string[]): number {
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && (i === 0 || !argv[i - 1]?.startsWith("--")),
  );
  const requestId = positional[0];
  if (requestId === undefined) {
    process.stderr.write("hook-kit decide: missing <request_id>\n");
    return 1;
  }
  const session = getArg(argv, "--session");
  if (session === undefined) {
    process.stderr.write("hook-kit decide: --session is required\n");
    return 1;
  }
  const allow = hasFlag(argv, "--allow");
  const deny = hasFlag(argv, "--deny");
  if (allow === deny) {
    process.stderr.write("hook-kit decide: pass exactly one of --allow / --deny\n");
    return 1;
  }
  const reason = getArg(argv, "--reason");
  const by = getArg(argv, "--by");
  const ok = submitDecision(session, requestId, allow ? "allow" : "deny", reason, {
    ...(by !== undefined ? { by } : {}),
  });
  if (!ok) {
    process.stderr.write(
      `hook-kit decide: a decision for ${requestId} was already submitted (first-writer-wins)\n`,
    );
    return 1;
  }
  process.stderr.write(`hook-kit: decided ${requestId} → ${allow ? "allow" : "deny"}\n`);
  return 0;
}

async function watchCommand(argv: readonly string[]): Promise<number> {
  // Minimal TTY listener — print a one-line summary as each new pending
  // request appears. Pair with `hook-kit decide` from another shell to
  // submit decisions. A richer TUI prompt is on the wishlist.
  const sessionFilter = getArg(argv, "--session");
  const childrenOf = getArg(argv, "--children-of");
  const pollMs = Number.parseInt(getArg(argv, "--poll-ms") ?? "200", 10);
  const seen = new Set<string>();
  process.stderr.write(
    `hook-kit watch: streaming pending requests (Ctrl+C to stop). To respond: \`hook-kit decide <id> --session <session> --allow|--deny\`\n`,
  );
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  while (true) {
    const sessions =
      sessionFilter !== undefined
        ? [{ sessionId: sessionFilter }]
        : listSessions(childrenOf !== undefined ? { childrenOf } : {});
    for (const s of sessions) {
      const pending = listPending(s.sessionId);
      for (const req of pending) {
        if (seen.has(req.id)) continue;
        seen.add(req.id);
        const inputSummary = JSON.stringify(req.toolInput).slice(0, 120);
        process.stdout.write(
          `[${s.sessionId}] ${req.id}  ${req.toolName}  reason="${req.reason}"  toolInput=${inputSummary}\n`,
        );
      }
    }
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
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
      process.stderr.write(`hook-kit: unknown command '${sub}'\n${HELP}`);
      return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
