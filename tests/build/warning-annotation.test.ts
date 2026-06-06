// End-to-end annotation-rendering test on the COMPILED hk binary.
//
// The ai-guardrails example uses only .deny()/.escalate() — to verify the
// new warning/note + `---` separator + pass-through-exec contract on a real
// compiled binary, we ship a tiny fixture hooks file that emits both kinds
// of annotations and assert the resulting stdout layout.
//
// Expected layout for `hk -c "<input>"` when only annotations fire:
//
//   [label1] warning: <message-1>
//   [label2] note: <message-2>
//   ---
//   <exec'd command's own stdout>
//
// And for `hk -c "<input>"` when an escalate fires alongside annotations:
//
//   [escalate-label] needs review: <reason>
//   [w-label] warning: <message>
//   [n-label] note: <message>
//   (exit 1, exec does NOT run)
//
// And for deny + annotations: annotations are DROPPED, only deny output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type StagedBinary, stageBinary } from "./_staged.js";

const BUILD_TIMEOUT_MS = 120_000;

const HOOKS_FIXTURE = `\
import { cmd, createModule } from "@questi0nm4rk/hook-kit";

// Module 1 — emits a warning annotation on \`ls\`.
const lsWarning = createModule(
  { id: "ls-warn", name: "ls warning", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("ls").warning("listing a directory — be sure of the path", "[ls-warn]")],
);

// Module 2 — emits a note annotation on \`ls\`. Stacks with Module 1.
const lsNote = createModule(
  { id: "ls-note", name: "ls note", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("ls").note("output may be paginated by your shell", "[ls-note]")],
);

// Module 3 — escalates on \`whoami\` (used to test escalate+annotation bundling).
// We make ls ALSO warn on whoami so both fire in the whoami flow.
const whoamiEscalate = createModule(
  { id: "whoami-esc", name: "whoami escalate", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("whoami").ask("identity check", "[whoami-esc]")],
);
const whoamiWarning = createModule(
  { id: "whoami-warn", name: "whoami warn", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("whoami").warning("user identity is sensitive", "[whoami-warn]")],
);

// Module 4 — denies \`id\` (used to test deny dropping annotations).
const idDeny = createModule(
  { id: "id-deny", name: "id deny", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("id").deny("blocked", "[id-deny]")],
);
const idWarning = createModule(
  { id: "id-warn", name: "id warn", events: ["PreToolUse"], matchers: ["Bash"] },
  [cmd("id").warning("user id leak", "[id-warn]")],
);

export default [lsWarning, lsNote, whoamiEscalate, whoamiWarning, idDeny, idWarning];
`;

let staged: StagedBinary;
// Captured only AFTER stageBinary resolves, so a beforeAll that throws (e.g. a
// failed build) leaves this undefined and afterAll's `cleanup?.()` is a no-op —
// surfacing the real build failure instead of a TypeError on `staged.cleanup`.
let cleanup: (() => void) | undefined;

beforeAll(async () => {
  staged = await stageBinary({
    hooksFixture: HOOKS_FIXTURE,
    adapter: "shell",
    prefix: "hook-kit-warn-",
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- StagedBinary.cleanup is an arrow-function property in _staged.ts (closes over staged/sandbox, never reads `this`); detaching it is safe. The rule cannot distinguish arrow-property from prototype method.
  cleanup = staged.cleanup;
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  cleanup?.();
});

describe("annotations-only path — emit + separator + exec", () => {
  test("single warning + note stack above `---`, then `ls /tmp` runs", async () => {
    // Both ls-warn and ls-note rules fire. Expected stdout:
    //   [ls-warn] warning: listing a directory ...
    //   [ls-note] note: output may be paginated ...
    //   ---
    //   <ls /tmp output>
    const r = await staged.run("ls /tmp");

    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");

    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("[ls-warn] warning: listing a directory — be sure of the path");
    expect(lines[1]).toBe("[ls-note] note: output may be paginated by your shell");
    expect(lines[2]).toBe("---");
    // The remaining lines are `ls /tmp` output — non-empty by definition.
    // biome-ignore lint/style/noMagicNumbers: index 3 = first line of exec output after the 3-line annotation header (warning + note + ---).
    expect(lines.slice(3).join("\n").trim().length).toBeGreaterThan(0);
  });

  test("annotations preserve module-declaration order", async () => {
    // ls-warn comes before ls-note in the modules array, so warning emits first.
    const r = await staged.run("ls /tmp");
    const warningIdx = r.stdout.indexOf("[ls-warn]");
    const noteIdx = r.stdout.indexOf("[ls-note]");
    expect(warningIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(-1);
    expect(warningIdx).toBeLessThan(noteIdx);
  });

  test("the separator is exactly `---` on its own line", async () => {
    const r = await staged.run("ls /tmp");
    expect(r.stdout).toMatch(/\n---\n/);
  });

  test("no annotations fire → no separator, command runs silently", async () => {
    // `echo hello` doesn't match any rule in the fixture. Pass-through path.
    const r = await staged.run("echo hello");
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("hello\n");
    expect(r.stdout).not.toContain("---");
    expect(r.stdout).not.toContain("warning:");
    expect(r.stdout).not.toContain("note:");
    expect(r.stderr).toBe("");
  });
});

describe("escalate + annotations bundle — no exec, annotations preserved", () => {
  test("`whoami` → escalate header + warning annotation, exit 1, no exec", async () => {
    const r = await staged.run("whoami");

    expect(r.exit).toBe(1);
    expect(r.stderr).toBe("");

    // Order: terminal (escalate) first, then annotations.
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    expect(lines[0]).toBe("[whoami-esc] needs review: identity check");
    expect(lines[1]).toBe("[whoami-warn] warning: user identity is sensitive");

    // No `---` separator on the escalate path — the command does not run, so
    // there's nothing to put below a separator. The harness re-runs the
    // command after approval.
    expect(r.stdout).not.toContain("---");
  });
});

describe("deny + annotations — deny wins, annotations DROPPED", () => {
  test("`id` → deny on stderr, NO annotations in output, exit 2", async () => {
    const r = await staged.run("id");

    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("[id-deny] denied: blocked");
    // The id-warn annotation is intentionally NOT shown — deny means the
    // command will not run, so annotations about a non-running command are
    // noise (per the merge policy).
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("warning");
    expect(r.stderr).not.toContain("note");
  });
});

describe("annotation prefix fallback", () => {
  // Build a second fixture-less assertion: a label-less annotation should
  // fall back to "[hook-kit]" in the rendered prefix. We can't easily
  // exercise this through the shared fixture (everything has a label) — but
  // tests/adapters/claude-code.test.ts covers the unit-level path, and the
  // shell-wrapper path uses the same formatAnnotation helper. The single
  // assertion below verifies the helper hasn't drifted by checking that
  // every annotation line above contains a non-empty `[...]` prefix.
  test("every annotation line starts with a non-empty bracket-prefix", async () => {
    const r = await staged.run("ls /tmp");
    const annotationLines = r.stdout
      .split("\n")
      .filter((l) => l.includes(" warning: ") || l.includes(" note: "));
    expect(annotationLines.length).toBeGreaterThan(0);
    for (const line of annotationLines) {
      expect(line).toMatch(/^\[[^\]]+\] (warning|note): /);
    }
  });
});
