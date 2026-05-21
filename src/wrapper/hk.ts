// Shell-wrapper entrypoint — the v0.3 default for compiled binaries.
//
// Substitutes for `bash -c "<cmd>"`: parses the command, runs the engine,
// then renders the EvaluationOutcome through the shell convention:
//
//   null / no rule         → silent, exec verbatim, exit = exec's exit
//   warning / note only    → emit each annotation + `---` separator + exec
//                            (annotations go to stdout, then the command's
//                             own stdout follows below the separator)
//   ask                    → stdout `<prefix> needs review: <reason>`, plus
//                            any accumulated warning/note annotations, exit 1,
//                            NO exec (harness re-runs on user approval, or the
//                            askpass broker handled it before reaching us)
//   deny                   → stderr `<prefix> denied: <reason>`, exit 2,
//                            NO exec, warning/note annotations DROPPED
//
// `error` annotations (engine-emitted on infra failures) ALWAYS go to stderr
// regardless of terminal decision — they're hook-health output, never rule
// output. They survive deny so a crashed rule alongside a deny still surfaces.
//
// `<prefix>` is the user-supplied decision label when present (e.g.
// `[my-plugin]`), or `[hook-kit]` when no label is set.

import { preloadWasm, WasmLoadError, WasmRuntimeError } from "@questi0nm4rk/shell-ast";
import {
  formatErrorAnnotation,
  formatNonErrorAnnotation,
  partitionAnnotations,
} from "../core/annotations.js";
import { formatErrorLine, ShellAstParseError } from "../core/errors.js";
import type { HookEvent, HookModule, Terminal } from "../core/types.js";
import { type EvaluateOptions, evaluate } from "../engine/index.js";
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
  stdout + exit 1          → needs review (ask)
  stderr + exit 2          → denied
  stderr 'error:' line     → hook-infra failure (always visible, never blocks
                              an otherwise-allowed command)
`;

/** @stable @since 1.0.0 */
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

function formatTerminal(t: Terminal): string {
  const prefix = t.label ?? "[hook-kit]";
  const verb = t.kind === "deny" ? "denied" : "needs review";
  return `${prefix} ${verb}: ${t.reason}\n`;
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
 * @stable @since 1.0.0
 */
export async function runShell(
  modules: readonly HookModule[],
  opts: RunShellOptions = {},
): Promise<never> {
  // Warm shell-ast's WASM during startup so the first cmd/pipe/redirect rule
  // doesn't pay cold-init in its hot path. On infra failure, write a typed
  // error line directly to stderr — there's no EvaluationOutcome to attach
  // an annotation to yet, but the failure must remain visible.
  await preloadWasm().catch((err: unknown) => {
    if (err instanceof WasmLoadError || err instanceof WasmRuntimeError) {
      const wrapped = new ShellAstParseError("(preload)", err);
      process.stderr.write(formatErrorLine(wrapped));
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

  const { others, errors } = partitionAnnotations(outcome.annotations);

  // Emit error annotations to stderr immediately — they accompany every
  // outcome, regardless of terminal.
  for (const err of errors) {
    process.stderr.write(`${formatErrorAnnotation(err)}\n`);
  }

  // deny — hard stop. warning/note annotations are dropped (per merge policy);
  // error annotations have already been written above.
  if (outcome.terminal?.kind === "deny") {
    process.stderr.write(formatTerminal(outcome.terminal));
    process.exit(2);
  }

  // ask — emit reason + any warning/note annotations to stdout, exit 1,
  // no exec. The harness (or askpass broker, if it already handled approval
  // upstream) is responsible for re-running the command after approval.
  if (outcome.terminal?.kind === "ask") {
    process.stdout.write(formatTerminal(outcome.terminal));
    for (const ann of others) {
      process.stdout.write(`${formatNonErrorAnnotation(ann)}\n`);
    }
    process.exit(1);
  }

  // No terminal. If any warning/note annotations fired, emit them above a
  // `---` separator so the AI can distinguish the framework's annotation
  // lines from the command's own output below. Then exec verbatim.
  if (others.length > 0) {
    for (const ann of others) {
      process.stdout.write(`${formatNonErrorAnnotation(ann)}\n`);
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
