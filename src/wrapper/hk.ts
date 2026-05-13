// Shell-wrapper entrypoint — the v0.3 default for compiled binaries.
//
// Substitutes for `bash -c "<cmd>"`: parses the command, runs the engine,
// then renders the EvaluationOutcome through the shell convention:
//
//   null / no rule         → silent, exec verbatim, exit = exec's exit
//   warning / note only    → emit each annotation + `---` separator + exec
//                            (annotations go to stdout, then the command's
//                             own stdout follows below the separator)
//   escalate (any kind)    → stdout `<prefix> needs review: <reason>`, plus
//                            any accumulated annotations, exit 1, NO exec
//                            (harness re-runs on user approval, or the
//                             askpass broker handled it before reaching us)
//   deny                   → stderr `<prefix> denied: <reason>`, exit 2,
//                            NO exec, annotations DROPPED (deny is final)
//
// `<prefix>` is the user-supplied decision label when present (e.g.
// `[my-plugin]`), or `[hook-kit]` when no label is set.
//
// Output convention is harness-agnostic: any caller (agent, human, CI) reads
// the decision through normal shell I/O. No JSON, no harness wiring.

import { preloadWasm, WasmLoadError, WasmRuntimeError } from "@questi0nm4rk/shell-ast";
import type { Annotation, HookEvent, HookModule, Terminal } from "../core/types.js";
import { type EvaluateOptions, evaluate, warnAstUnavailable } from "../engine/index.js";
import { emitVerbose, isVerbose } from "../engine/trace.js";
import { VERSION } from "../version.js";

const USAGE = `\
hk — hook-kit shell wrapper

Usage:
  hk -c "<command-string>"   Evaluate, then exec via bash -c if allowed.
  hk -- <argv...>            Evaluate, then exec the argv directly if allowed.
  hk --version               Print version and exit.
  hk --help                  Print this and exit.

Output convention:
  silent + exit 0          → command was approved (executed transparently)
  <annotations> + --- +    → warning/note(s) emitted, then command exec'd
    command output            (the AI sees the labels above the separator)
  stdout + exit 1          → needs review (escalate)
  stderr + exit 2          → denied
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

/** Render a terminal decision to its `<prefix> kind: <reason>` line. */
function formatTerminal(t: Terminal): string {
  const prefix = t.label ?? "[hook-kit]";
  const verb = t.kind === "deny" ? "denied" : "needs review";
  return `${prefix} ${verb}: ${t.reason}\n`;
}

/** Render an annotation to its `<prefix> warning|note: <message>` line. */
function formatAnnotation(a: Annotation): string {
  const prefix = a.label ?? "[hook-kit]";
  return `${prefix} ${a.kind}: ${a.message}\n`;
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
 * modules. Reads `process.argv`, evaluates, emits the outcome via the
 * stdout/stderr/exit-code convention, then execs on approval.
 */
export async function runShell(
  modules: readonly HookModule[],
  opts: RunShellOptions = {},
): Promise<never> {
  // Warm shell-ast's WASM during startup so the first cmd/pipe/redirect rule
  // doesn't pay cold-init in its hot path. On infra failure, route through
  // the same one-shot warning as the engine's parse() catch site so non-Bash
  // sessions (no eventual parse() call) still see the signal.
  await preloadWasm().catch((err: unknown) => {
    if (err instanceof WasmLoadError || err instanceof WasmRuntimeError) {
      warnAstUnavailable(err);
    }
  });

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

  const verbose = isVerbose();
  const startedAt = verbose ? performance.now() : 0;

  const outcome = await evaluate(event, modules, opts);

  if (verbose) {
    const durationMs = Math.round(performance.now() - startedAt);
    emitVerbose(event, outcome, modules.length, durationMs);
  }

  // deny — hard stop. Annotations dropped (per merge policy).
  if (outcome.terminal?.kind === "deny") {
    process.stderr.write(formatTerminal(outcome.terminal));
    process.exit(2);
  }

  // escalate — emit reason + any annotations, exit 1, no exec. The harness
  // (or askpass broker, if it already handled approval upstream) is responsible
  // for re-running the command after approval.
  if (outcome.terminal?.kind === "escalate") {
    process.stdout.write(formatTerminal(outcome.terminal));
    for (const ann of outcome.annotations) {
      process.stdout.write(formatAnnotation(ann));
    }
    process.exit(1);
  }

  // No terminal. If any annotations fired, emit them above a `---` separator
  // so the AI can distinguish the framework's annotation lines from the
  // command's own output below. Then exec verbatim.
  if (outcome.annotations.length > 0) {
    for (const ann of outcome.annotations) {
      process.stdout.write(formatAnnotation(ann));
    }
    process.stdout.write("---\n");
  }

  if (args.mode === "bash-c" && args.command !== undefined) {
    await execCommand({ mode: "bash-c", command: args.command });
  } else if (args.mode === "argv" && args.argv !== undefined) {
    await execCommand({ mode: "argv", argv: args.argv });
  }
  process.exit(0);
}
