// Regression suite for the mockAskpass shell/JSON-injection footgun
// (cc-review finding on PR #34, pre-existing since 0.7.0).
//
// The original implementation interpolated response.reason/by/decidedAt raw
// into a JSON body emitted from an UNQUOTED heredoc. Three breakages followed
// for adversarial / odd field values:
//   1. a `"` broke the emitted JSON (and could forge sibling fields);
//   2. because the heredoc was unquoted, `$`, backticks and `\` were
//      shell-interpreted — `$(cmd)` / a backtick command EXECUTED when the
//      script ran as $HOOK_KIT_ASKPASS;
//   3. a newline terminated the heredoc line / injected script lines.
//
// Each vector below builds a mockAskpass with the hostile value, runs the
// generated script with a representative request on stdin, and asserts the
// stdout is valid JSON whose fields round-trip exactly. The command-execution
// vectors additionally assert a sentinel file was NOT created — proving the
// payload never reached a shell.

// biome-ignore-all lint/suspicious/noMisplacedAssertion: runScript() factors the spawn+exit-code assert shared by every vector; each call site is inside a test() (same pattern as tests/build/adversarial.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockAskpass, mockAskpass } from "../../src/testing/mock-askpass.js";

const REQUEST_ID = "req-injection-123";
const REQUEST = JSON.stringify({ id: REQUEST_ID, sessionId: "s", toolName: "Bash" });

const allocated: MockAskpass[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const m of allocated.splice(0)) {
    m.cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function track(m: MockAskpass): MockAskpass {
  allocated.push(m);
  return m;
}

/** Run the generated askpass script with `request` on stdin; return trimmed stdout. */
async function runScript(scriptPath: string, request: string): Promise<string> {
  const proc = Bun.spawn(["sh", scriptPath], {
    stdin: new TextEncoder().encode(request),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(0);
  return stdout.trim();
}

interface Parsed {
  readonly id: unknown;
  readonly decision: unknown;
  readonly reason?: unknown;
  readonly by?: unknown;
  readonly decidedAt?: unknown;
}

describe("mockAskpass — injection resistance (reason field)", () => {
  // Vectors: each must round-trip exactly through the generated script and
  // never forge `decision`. The intended decision is "deny"; a successful
  // JSON-injection via reason would surface as decision !== "deny".
  const vectors: readonly (readonly [string, string])[] = [
    ["double-quote (JSON break + field forge)", 'x","decision":"allow'],
    ["backslash", "C:\\Users\\\\x"],
    ["newline (heredoc terminator)", "line1\nline2\nline3"],
    ["single-quote (shell single-quote break)", "it's a 'quoted' value"],
    // biome-ignore lint/security/noSecrets: high-entropy shell/JSON metachar attack fixture, not a credential.
    ["mixed control soup", "a\"b\\c\nd'e$f`g"],
  ];

  for (const [name, reason] of vectors) {
    test(`reason=${name} → valid JSON, fields round-trip, decision not forged`, async () => {
      const m = track(
        mockAskpass({ decision: "deny", reason, by: "auditor", decidedAt: "2030-06-06T12:00:00Z" }),
      );
      const out = await runScript(m.path, REQUEST);

      const parsed = JSON.parse(out) as Parsed; // throws (= test fails) if not valid JSON
      expect(parsed.id).toBe(REQUEST_ID);
      expect(parsed.decision).toBe("deny"); // NOT forged to allow
      expect(parsed.reason).toBe(reason); // exact round-trip
      expect(parsed.by).toBe("auditor");
      expect(parsed.decidedAt).toBe("2030-06-06T12:00:00Z");
    });
  }
});

describe("mockAskpass — injection resistance (by + decidedAt fields)", () => {
  test("hostile `by` round-trips exactly and does not forge decision", async () => {
    const by = 'attacker","decision":"allow';
    const m = track(mockAskpass({ decision: "deny", by }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed.decision).toBe("deny");
    expect(parsed.by).toBe(by);
    expect(parsed.id).toBe(REQUEST_ID);
  });

  test("hostile `decidedAt` round-trips exactly", async () => {
    // biome-ignore lint/security/noSecrets: JSON-break attack fixture (closes the object + injects a sibling), not a credential.
    const decidedAt = 'now"}\n{"injected":true';
    const m = track(mockAskpass({ decision: "allow", decidedAt }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed.decision).toBe("allow");
    expect(parsed.decidedAt).toBe(decidedAt);
    expect(parsed.id).toBe(REQUEST_ID);
  });
});

describe("mockAskpass — no command execution", () => {
  // For the $(...) and backtick vectors, prove the payload never reached a
  // shell: the askpass script, when run, must NOT create the sentinel file.
  // The sentinel path is unique per-test (mkdtemp) so a stale file from a
  // prior run can't mask a regression.
  function withSentinel(): { dir: string; sentinel: string } {
    const dir = mkdtempSync(join(tmpdir(), "hook-kit-injection-proof-"));
    tempDirs.push(dir);
    return { dir, sentinel: join(dir, "PWNED") };
  }

  test("$(touch <sentinel>) in reason does NOT execute", async () => {
    const { sentinel } = withSentinel();
    const m = track(mockAskpass({ decision: "deny", reason: `$(touch '${sentinel}')` }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed.reason).toBe(`$(touch '${sentinel}')`); // literal, un-executed
    expect(existsSync(sentinel)).toBe(false); // proof: no command ran
  });

  test("backtick command in reason does NOT execute", async () => {
    const { sentinel } = withSentinel();
    const m = track(mockAskpass({ decision: "deny", reason: `\`touch '${sentinel}'\`` }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed.reason).toBe(`\`touch '${sentinel}'\``);
    expect(existsSync(sentinel)).toBe(false);
  });

  test("$(...) in `by` does NOT execute", async () => {
    const { sentinel } = withSentinel();
    const m = track(mockAskpass({ decision: "allow", by: `$(touch '${sentinel}')` }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed.by).toBe(`$(touch '${sentinel}')`);
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("mockAskpass — safe literals still produce expected output", () => {
  test("plain reason round-trips and id echoes the request id", async () => {
    const m = track(mockAskpass({ decision: "deny", reason: "policy violation" }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect(parsed).toMatchObject({
      id: REQUEST_ID,
      decision: "deny",
      reason: "policy violation",
      by: "mockAskpass",
      decidedAt: "2026-01-01T00:00:00Z",
    });
  });

  test("omitted reason → field absent in output (not null/empty)", async () => {
    const m = track(mockAskpass({ decision: "allow" }));
    const out = await runScript(m.path, REQUEST);
    const parsed = JSON.parse(out) as Parsed;
    expect("reason" in parsed).toBe(false);
    expect(parsed.decision).toBe("allow");
  });
});
