// 0-silent-fails (0.5) contract: every internal failure path emits a typed
// error line to stderr, even when the surrounding code's primary behavior
// (synthesized deny, returned undefined, continued operation) hides the
// failure from the caller's return value.
//
// Existing tests in this directory verify the PRIMARY behavior (e.g.,
// `callAskpass` returns a deny on spawn failure). This file verifies the
// VISIBILITY contract — that operators see the typed error class name in
// stderr, not just a generic deny reason.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAskpass } from "../../src/escalation/askpass.js";
import {
  brokerAskpass,
  brokerPaths,
  ensureSession,
  submitDecision,
} from "../../src/escalation/broker.js";
import { createAskRequest } from "../../src/escalation/envelope.js";
import { liveListeners } from "../../src/escalation/listeners.js";
import { captureStderr } from "../_helpers.js";

let workDir: string;
let captured: ReturnType<typeof captureStderr>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-stderr-"));
  captured = captureStderr();
});
afterEach(() => {
  captured.restore();
  rmSync(workDir, { recursive: true, force: true });
});

function stageScript(name: string, body: string): string {
  const path = join(workDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function makeRequest() {
  return createAskRequest({
    sessionId: "s1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    reason: "test",
  });
}

describe("broker — security-boundary stderr emission", () => {
  test("malformed stdin envelope → EnvelopeValidationError on stderr (alongside synthesized deny)", async () => {
    const response = await brokerAskpass("{ not valid json", {
      root: workDir,
      skipValidator: true,
    });
    // Primary behavior: synthesized deny.
    expect(response.decision).toBe("deny");
    expect(response.id).toBe("<malformed>");
    // Visibility contract: typed error line on stderr.
    const stderr = captured.output();
    expect(stderr).toContain("[hook-kit] error: EnvelopeValidationError:");
    expect(stderr).toContain("broker stdin");
  });

  test("malformed decision file in spool → EnvelopeValidationError on stderr (then auto-deny)", async () => {
    // Stage: a pending request the broker is polling for, then write garbage
    // at decided/<id>.json to trigger parseAskResponse failure mid-poll.
    const req = makeRequest();
    const paths = ensureSession(req.sessionId, { root: workDir });
    writeFileSync(join(paths.decidedDir, `${req.id}.json`), "{ corrupt }");

    const stdinText = JSON.stringify(req);
    // Run with a tiny pollMs + tight timeout so the test doesn't hang.
    const response = await brokerAskpass(stdinText, {
      root: workDir,
      pollMs: 5,
      timeoutMs: 200,
      skipValidator: true,
    });
    expect(response.decision).toBe("deny");
    expect(captured.output()).toContain("[hook-kit] error: EnvelopeValidationError:");
  });
});

describe("askpass — security-boundary stderr emission", () => {
  test("spawn missing binary → ProcessSpawnError on stderr (alongside deny)", async () => {
    const res = await callAskpass({
      request: makeRequest(),
      askpassPath: "/this/does/not/exist",
    });
    expect(res.decision).toBe("deny");
    const stderr = captured.output();
    expect(stderr).toContain("[hook-kit] error: ProcessSpawnError:");
    expect(stderr).toContain("/this/does/not/exist");
  });

  test("askpass returns malformed JSON → EnvelopeValidationError on stderr (alongside deny)", async () => {
    const path = stageScript("garbage.sh", "#!/bin/sh\necho '{ not json'\nexit 0\n");
    const res = await callAskpass({ request: makeRequest(), askpassPath: path });
    expect(res.decision).toBe("deny");
    const stderr = captured.output();
    expect(stderr).toContain("[hook-kit] error: EnvelopeValidationError:");
    expect(stderr).toContain("askpass response");
  });
});

describe("broker.audit — best-effort site emits typed error on write failure", () => {
  test("audit log write failure → FileWriteError on stderr, operation continues", async () => {
    // Force an unwritable auditPath: create a directory at the audit-log path
    // so appendFileSync hits EISDIR.
    const sessionId = "audit-fail";
    const paths = brokerPaths(sessionId, workDir);
    mkdirSync(paths.sessionDir, { recursive: true });
    mkdirSync(paths.auditPath); // directory where a file should be

    // submitDecision triggers an audit() call via the ensureSession path.
    // Easier: register a listener (also calls audit via the broker tree),
    // or just spawn brokerAskpass with a complete valid request to exercise
    // the audit path. Use submitDecision for a tighter call.
    submitDecision(sessionId, "test-req", "allow", "test", { root: workDir });
    // submitDecision does not currently call audit, so instead just call
    // brokerAskpass which DOES call audit on the "pending" and "decided" paths.
    const req = createAskRequest({
      sessionId,
      toolName: "Bash",
      toolInput: { command: "ls" },
      reason: "test",
    });
    // skipValidator so no listener required
    await brokerAskpass(JSON.stringify(req), {
      root: workDir,
      pollMs: 5,
      timeoutMs: 100,
      skipValidator: true,
    });

    const stderr = captured.output();
    expect(stderr).toContain("[hook-kit] error: FileWriteError:");
    expect(stderr).toContain("audit.jsonl");
  });
});

describe("listeners — best-effort site emits typed error on malformed marker", () => {
  test("garbage in <session>/listeners/*.lock → JsonParseError on stderr (marker filtered out)", () => {
    const sessionId = "listener-fail";
    const paths = brokerPaths(sessionId, workDir);
    mkdirSync(join(paths.sessionDir, "listeners"), { recursive: true });
    writeFileSync(join(paths.sessionDir, "listeners", "garbage.lock"), "{ not json");

    const live = liveListeners(sessionId, { root: workDir });
    // Visibility: typed error fires.
    expect(captured.output()).toContain("[hook-kit] error: JsonParseError:");
    // Primary behavior: malformed marker is filtered, doesn't kill the scan.
    expect(live).toHaveLength(0);
  });
});

// Note on enrich-git coverage: a unit test that forces git off PATH proved
// unreliable — Bun.spawn does NOT honor runtime mutations of process.env.PATH
// (confirmed: setting PATH to a bogus dir still resolves `git` from the
// startup PATH). The ProcessSpawnError visibility path for enrichGit is
// transitively exercised by the askpass missing-binary test above (same
// emitErrorLine + ProcessSpawnError shape, same catch site pattern). If you
// need direct enrich-git coverage in the future, refactor `runGit` to accept
// an injectable binary path or pass an explicit `env` to Bun.spawn.
