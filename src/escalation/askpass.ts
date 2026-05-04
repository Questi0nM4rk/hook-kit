// Askpass — spawn $HOOK_KIT_ASKPASS, write envelope to stdin, read decision
// from stdout. See docs/SPEC.md § Escalation § Askpass Contract.

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
 * AskResponse — never throws. Iron Law 3 with the explicit exception that
 * `escalate` requests with no usable responder must deny, never silent-allow.
 *
 * Failure modes (all map to deny with a descriptive reason):
 *   - $HOOK_KIT_ASKPASS unset or empty
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
    return denied(
      opts.request.id,
      "[hook-kit] escalation infrastructure unavailable: HOOK_KIT_ASKPASS not set",
    );
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([askpass], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return denied(
      opts.request.id,
      `[hook-kit] escalation infrastructure unavailable: cannot spawn askpass: ${msg}`,
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
    } catch {
      // ignore — already dead
    }
    void stdoutStream.cancel().catch(() => {});
    void stderrStream.cancel().catch(() => {});
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return denied(opts.request.id, `[hook-kit] askpass response was malformed: ${msg}`);
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
