// Askpass — spawn $HOOK_KIT_ASKPASS, write envelope to stdin, read decision
// from stdout. See docs/SPEC.md § Escalation § Askpass Contract.

import { EnvelopeValidationError, emitErrorLine, ProcessSpawnError } from "../core/errors.js";
import type { AskRequest, AskResponse } from "./envelope.js";
import { createAskResponse, parseAskResponse } from "./envelope.js";

export interface CallAskpassOptions {
  readonly request: AskRequest;
  /** Override askpass binary path. Defaults to process.env.HOOK_KIT_ASKPASS. */
  readonly askpassPath?: string;
  /**
   * Optional wall-clock timeout in ms. Default: no timeout — the bundled
   * broker is expected to wait until a listener answers, and CC's hooks.json
   * timeout is the actual ceiling. Pass a positive number when wrapping a
   * custom askpass binary you don't trust to respond.
   */
  readonly timeoutMs?: number;
}

/**
 * Drive the askpass channel for one escalation request. Always returns an
 * AskResponse — never throws.
 *
 * `$HOOK_KIT_ASKPASS` unset → no broker infrastructure configured; punt
 * directly to the harness UI tier via `harness-ask`. The CC adapter renders
 * this as `permissionDecision: "ask"`. This is not silent-allow — the harness
 * UI is itself a responder.
 *
 * Failure modes (these map to deny — Iron Law 3 exception, never silent-allow
 * when infra was *expected* but broken):
 *   - askpass binary not executable / not found
 *   - askpass exits non-zero
 *   - askpass stdout is empty / not a valid AskResponse JSON
 *   - askpass response id does not match the request id
 *   - timeout elapses before the askpass exits (child is SIGKILLed)
 */
export async function callAskpass(opts: CallAskpassOptions): Promise<AskResponse> {
  const askpass = opts.askpassPath ?? process.env.HOOK_KIT_ASKPASS;
  const timeoutMs = opts.timeoutMs;
  if (askpass === undefined || askpass === "") {
    // No broker infra → delegate to the harness's native UI.
    return createAskResponse({
      id: opts.request.id,
      decision: "harness-ask",
      reason: "[hook-kit] no askpass configured — delegating to harness UI",
    });
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([askpass], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    // Fail-CLOSED at security boundary: typed error to stderr (always
    // visible), deny synthesized so the caller doesn't silent-allow.
    const wrapped = new ProcessSpawnError(askpass, cause);
    emitErrorLine(wrapped);
    return denied(
      opts.request.id,
      `[hook-kit] escalation infrastructure unavailable: cannot spawn askpass: ${wrapped.message}`,
    );
  }

  // Write the envelope and close stdin so the askpass can read EOF.
  // The "pipe" stdin/stdout settings give us FileSink/ReadableStream; the
  // union type from Bun's overloads needs narrowing via cast.
  const stdin = proc.stdin as import("bun").FileSink;
  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  stdin.write(JSON.stringify(opts.request));
  stdin.end();

  // Race exit against timeout (when set). Don't await streams during the
  // race — orphaned grandchildren can keep the pipe open after the askpass
  // shell dies, which would block stream EOF indefinitely.
  type RaceResult = { kind: "exit"; code: number } | { kind: "timeout" };
  const raceResult = await new Promise<RaceResult>((resolve) => {
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => resolve({ kind: "timeout" }), timeoutMs)
        : undefined;
    proc.exited.then((code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ kind: "exit", code });
    });
  });

  if (raceResult.kind === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch (cause) {
      // Process likely already dead — emit typed error for visibility.
      emitErrorLine(new ProcessSpawnError(`SIGKILL ${askpass}`, cause));
    }
    void stdoutStream.cancel().catch((cause: unknown) => {
      emitErrorLine(new ProcessSpawnError("askpass stdout cancel", cause));
    });
    void stderrStream.cancel().catch((cause: unknown) => {
      emitErrorLine(new ProcessSpawnError("askpass stderr cancel", cause));
    });
    const seconds = timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : 0;
    return denied(
      opts.request.id,
      `[hook-kit] no decision in ${seconds}s. Original: ${opts.request.reason}`,
    );
  }

  const exitCode = raceResult.code;
  const [stdoutText, stderrText] = await Promise.all([
    new Response(stdoutStream).text(),
    new Response(stderrStream).text(),
  ]);

  if (exitCode !== 0) {
    const tail = stderrText.trim().slice(0, 200);
    return denied(
      opts.request.id,
      `[hook-kit] askpass exited ${exitCode}${tail !== "" ? `: ${tail}` : ""}`,
    );
  }

  if (stdoutText.trim() === "") {
    return denied(opts.request.id, "[hook-kit] askpass produced no output");
  }

  let response: AskResponse;
  try {
    response = parseAskResponse(stdoutText.trim());
  } catch (cause) {
    // Fail-CLOSED: malformed response from a security-boundary IPC channel.
    // Typed error to stderr, deny synthesized.
    const wrapped = new EnvelopeValidationError("askpass response", cause);
    emitErrorLine(wrapped);
    return denied(opts.request.id, `[hook-kit] askpass response was malformed: ${wrapped.message}`);
  }

  if (response.id !== opts.request.id) {
    return denied(
      opts.request.id,
      `[hook-kit] askpass response id mismatch: expected ${opts.request.id}, got ${response.id}`,
    );
  }

  return response;
}

function denied(id: string, reason: string): AskResponse {
  return createAskResponse({ id, decision: "deny", reason });
}
