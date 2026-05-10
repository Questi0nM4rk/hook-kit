// Shell-wrapper entrypoint — the new default for v0.3.
//
// Substitutes for `bash -c "<cmd>"`: parses the command, runs the engine,
// then either:
//   - null / context  → execs the command verbatim (fully transparent)
//   - deny            → stderr `[hook-kit] denied: …`, exit 2
//   - escalate        → stdout `[hook-kit] needs review: …`, exit 1
//
// Output convention is harness-agnostic: any caller (agent, human, CI)
// reads the decision through normal shell I/O. No JSON, no harness wiring.

import type { Decision, HookEvent, HookModule } from "../core/types.js";
import { type EvaluateOptions, evaluate } from "../engine/index.js";
import { VERSION } from "../version.js";

const USAGE = `\
hk — hook-kit shell wrapper

Usage:
  hk -c "<command-string>"   Evaluate, then exec via bash -c if allowed.
  hk -- <argv...>            Evaluate, then exec the argv directly if allowed.
  hk --version               Print version and exit.
  hk --help                  Print this and exit.

Output convention:
  silent + exit 0    → command was approved (executed transparently)
  stderr + non-zero  → denied
  stdout + non-zero  → needs review (escalate)
`;

export interface RunShellOptions extends EvaluateOptions {
  /** Override the version string for `--version`. Defaults to package.json. */
  readonly version?: string;
}

interface ParsedArgs {
  readonly mode: "bash-c" | "argv" | "version" | "help" | "error";
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly errorMessage?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) return { mode: "help" };
  const first = argv[0];
  if (first === "--help" || first === "-h") return { mode: "help" };
  if (first === "--version" || first === "-v") return { mode: "version" };
  if (first === "-c") {
    const command = argv[1];
    if (command === undefined)
      return { mode: "error", errorMessage: "hk: -c requires a command string\n" };
    return { mode: "bash-c", command };
  }
  if (first === "--") {
    const rest = argv.slice(1);
    if (rest.length === 0)
      return { mode: "error", errorMessage: "hk: -- requires at least one argv element\n" };
    return { mode: "argv", argv: rest };
  }
  return {
    mode: "error",
    errorMessage: `hk: unrecognized argument '${first}'. Use \`hk --help\`.\n`,
  };
}

function withLabel(message: string, label: string | undefined): string {
  return label !== undefined ? `${label} ${message}` : message;
}

function emitDecision(decision: Exclude<Decision, null | { kind: "context" }>): never {
  if (decision.kind === "deny") {
    process.stderr.write(`[hook-kit] denied: ${withLabel(decision.reason, decision.label)}\n`);
    process.exit(2);
  }
  // escalate — needs-review warning, non-zero exit, stdout
  process.stdout.write(`[hook-kit] needs review: ${withLabel(decision.reason, decision.label)}\n`);
  process.exit(1);
}

async function execCommand(
  args: { mode: "bash-c"; command: string } | { mode: "argv"; argv: readonly string[] },
): Promise<never> {
  const cmd = args.mode === "bash-c" ? ["bash", "-c", args.command] : [...args.argv];
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  process.exit(code);
}

/**
 * The shell-wrapper entrypoint. Compiled binaries built with
 * `hook-kit build … --adapter shell` (the default) call this with their
 * modules. Reads `process.argv`, evaluates, emits the decision via the
 * stdout/stderr/exit-code convention, then execs on approval.
 */
export async function runShell(
  modules: readonly HookModule[],
  opts: RunShellOptions = {},
): Promise<never> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.mode === "version") {
    process.stdout.write(`${opts.version ?? VERSION}\n`);
    process.exit(0);
  }
  if (args.mode === "error") {
    process.stderr.write(args.errorMessage ?? "hk: argument error\n");
    process.stderr.write(USAGE);
    process.exit(2);
  }

  // Synthesize the command string for the engine. argv mode joins on spaces
  // — lossy for args containing whitespace, but the engine only needs to
  // parse the cmd/sub/flags structure, which join-on-space preserves.
  const command = args.mode === "bash-c" ? (args.command ?? "") : (args.argv ?? []).join(" ");

  const event: HookEvent = {
    eventName: "PreToolUse",
    sessionId: process.env.HK_SESSION_ID ?? "shell",
    cwd: process.cwd(),
    transcriptPath: "",
    toolName: "Bash",
    toolInput: { command },
    raw: {},
  };

  const decision = await evaluate(event, modules, opts);

  if (decision === null || decision.kind === "context") {
    // Approved (or just context — non-blocking) → exec verbatim, transparent.
    if (args.mode === "bash-c" && args.command !== undefined) {
      await execCommand({ mode: "bash-c", command: args.command });
    } else if (args.mode === "argv" && args.argv !== undefined) {
      await execCommand({ mode: "argv", argv: args.argv });
    }
    process.exit(0);
  }

  emitDecision(decision);
}
