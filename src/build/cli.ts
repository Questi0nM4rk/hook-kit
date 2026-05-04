#!/usr/bin/env bun
// hook-kit build CLI
// See docs/SPEC.md § Build CLI

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { BuildError, generateHooksJson, runBuild } from "./bundle.js";

const HELP = `\
hook-kit — framework for building compiled hook binaries for AI coding agents

Usage:
  hook-kit build <entrypoint> --out <path> [--adapter claude-code] [--hooks-json <path>] [--hook-timeout <seconds>]
  hook-kit --help
  hook-kit --version

Build options:
  --out <path>            Output binary path (required).
  --adapter <name>        Protocol adapter. Today: claude-code (default).
  --hooks-json <path>     Also emit a CC hooks.json next to the binary. Path is
                          where the JSON lands; the embedded \`command\` points
                          at the binary's eventual install location.
  --binary-command <s>    Override the \`command\` string used in hooks.json.
                          Default: \${CLAUDE_PLUGIN_ROOT}/<basename of --out>.
  --hook-timeout <s>      Per-hook timeout in seconds (default 65 — leaves
                          slack for escalation; reduce for hooks without
                          escalate rules).

Escalation listener subcommands (M3 — not yet implemented):
  hook-kit broker [--askpass]
  hook-kit watch [--session <id>]
  hook-kit subscribe [--session <id>] [--children-of <id>] --json
  hook-kit decide <request_id> --allow|--deny [--reason <text>]
  hook-kit list [--children-of <id>]
`;

function getArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

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
  if (sub === "build") return buildCommand(rest);
  if (
    sub === "broker" ||
    sub === "watch" ||
    sub === "subscribe" ||
    sub === "decide" ||
    sub === "list"
  ) {
    process.stderr.write(
      `hook-kit: '${sub}' is part of the escalation system (M3 — not yet implemented).\n`,
    );
    return 1;
  }
  process.stderr.write(`hook-kit: unknown command '${sub}'\n${HELP}`);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
