import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAskpass } from "../../src/escalation/askpass.js";
import { createAskRequest } from "../../src/escalation/envelope.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "hook-kit-askpass-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function makeRequest() {
  return createAskRequest({
    sessionId: "s1",
    toolName: "Bash",
    toolInput: { command: "ls" },
    reason: "test",
  });
}

/** Write an executable shell script to workDir and return its path. */
function stageScript(name: string, body: string): string {
  const path = join(workDir, name);
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("callAskpass — infrastructure failures map to deny", () => {
  test("HOOK_KIT_ASKPASS unset → deny with infra-unavailable reason", async () => {
    const req = makeRequest();
    const res = await callAskpass({ request: req });
    expect(res.id).toBe(req.id);
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("HOOK_KIT_ASKPASS not set");
  });

  test("askpass binary missing → deny with cannot-spawn reason", async () => {
    const req = makeRequest();
    const res = await callAskpass({
      request: req,
      askpassPath: "/this/does/not/exist",
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("infrastructure unavailable");
  });

  test("askpass exits non-zero → deny with exit-code reason", async () => {
    const req = makeRequest();
    const path = stageScript("fail.sh", "#!/bin/sh\necho 'oops' >&2\nexit 1\n");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("exited 1");
    expect(res.reason).toContain("oops");
  });

  test("askpass produces empty stdout → deny", async () => {
    const req = makeRequest();
    const path = stageScript("silent.sh", "#!/bin/sh\nexit 0\n");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("no output");
  });

  test("askpass produces malformed stdout → deny", async () => {
    const req = makeRequest();
    const path = stageScript("garbage.sh", "#!/bin/sh\necho '{ not json'\nexit 0\n");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("malformed");
  });

  test("askpass response id mismatch → deny", async () => {
    const req = makeRequest();
    const path = stageScript(
      "wrong-id.sh",
      `#!/bin/sh\ncat > /dev/null\necho '{"id":"wrong","decision":"allow","decidedAt":"2026-05-04T00:00:00Z"}'\n`,
    );
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("id mismatch");
  });
});

/** Tiny portable askpass: reads the envelope from stdin, extracts the id with
 *  a single grep+sed, and emits a response with the supplied decision +
 *  optional reason. Pure POSIX sh — no Bun/Node dependency at runtime. */
function stageDecisionScript(
  workDir: string,
  name: string,
  decision: "allow" | "deny" | "harness-ask",
  reason?: string,
): string {
  const reasonField = reason !== undefined ? `,\\"reason\\":\\"${reason}\\"` : "";
  const body = [
    "#!/bin/sh",
    "REQ=$(cat)",
    'ID=$(printf %s "$REQ" | grep -oE \'"id":"[^"]*"\' | head -1 | sed \'s/"id":"//; s/"$//\')',
    `printf '{"id":"%s","decision":"${decision}"${reasonField},"decidedAt":"2026-01-01T00:00:00Z"}\\n' "$ID"`,
  ].join("\n");
  const path = join(workDir, name);
  writeFileSync(path, `${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("callAskpass — happy path", () => {
  test("askpass returns allow → response carries allow with matching id", async () => {
    const req = makeRequest();
    const path = stageDecisionScript(workDir, "allow.sh", "allow");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("allow");
    expect(res.id).toBe(req.id);
  });

  test("askpass returns deny with reason → response preserves both", async () => {
    const req = makeRequest();
    const path = stageDecisionScript(workDir, "deny.sh", "deny", "policy violation");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("deny");
    expect(res.reason).toBe("policy violation");
  });

  test("askpass returns harness-ask → response carries harness-ask", async () => {
    const req = makeRequest();
    const path = stageDecisionScript(workDir, "harness.sh", "harness-ask");
    const res = await callAskpass({ request: req, askpassPath: path });
    expect(res.decision).toBe("harness-ask");
  });
});

describe("callAskpass — timeout", () => {
  test("askpass that hangs longer than timeout → deny with timeout reason", async () => {
    const req = makeRequest();
    const path = stageScript("hang.sh", "#!/bin/sh\nsleep 10\necho '{}'\n");
    const res = await callAskpass({ request: req, askpassPath: path, timeoutMs: 100 });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("no decision");
    expect(res.reason).toContain("test"); // original reason from the request
  });
});
