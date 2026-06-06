import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-02 (#16): eval "$X" / sh -c "$DYN" / bash -c "$VAR" produce a
// wrapped-opaque shell layer — a dynamic inline-shell body the engine cannot
// re-parse. The wrapped-script recursion only handles STATIC bodies, so the
// opaque case used to silently pass, hiding whatever the dynamic script
// expands to. It now escalates per SecurityOptions.uncertaintyDecision.
// Non-shell opaque wrappers (sudo $X) are out of scope — that is a dynamic
// command, not an inline-shell body.

const mod = () => moduleWith([cmd("rm").deny("rm blocked")]);

describe("SA-02 opaque inline-shell body", () => {
  test("escalates eval with a dynamic body to ask (default profile)", async () => {
    const out = await runModule({ module: mod(), command: 'eval "$X"' });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("escalates sh -c with a dynamic body to ask", async () => {
    const out = await runModule({ module: mod(), command: 'sh -c "$DYN"' });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("escalates bash -c with a dynamic body to deny under STRICT_DENY", async () => {
    const out = await runModule({
      module: mod(),
      command: 'bash -c "$VAR"',
      security: STRICT_DENY,
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("detects an opaque shell layer through a sudo wrapper", async () => {
    const out = await runModule({ module: mod(), command: 'sudo bash -c "$X"' });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("stays silent when uncertaintyDecision is 'allow'", async () => {
    const out = await runModule({
      module: mod(),
      command: 'eval "$X"',
      security: { ...STRICT_BUT_ASKS, uncertaintyDecision: "allow" },
    });
    expect(out.terminal).toBeNull();
  });

  test("does NOT escalate a non-shell opaque wrapper (sudo $X)", async () => {
    const out = await runModule({ module: mod(), command: "sudo $X" });
    expect(out.terminal).toBeNull();
  });

  test("still recurses into a STATIC inline-shell body (regression guard)", async () => {
    const out = await runModule({ module: mod(), command: "bash -c 'rm -rf /'" });
    expect(out.terminal?.kind).toBe("deny");
  });

  // SA-02 merge-contract (mirror of BUG 12 / depth-deny-drops-annotations):
  // when the opaque-shell escalation resolves to deny (STRICT_DENY), the deny
  // branch must drop warning/note per the merge policy (only error annotations
  // survive a deny). `cmd("bash")` fires on the OUTER `bash -c "$VAR"` call,
  // accruing a warning in the same frame BEFORE the opaque-body deny trips.
  test("opaque-shell deny under STRICT_DENY drops accrued warning/note", async () => {
    const out = await runModule({
      module: moduleWith([
        cmd("bash").warning("inline-shell warning"),
        cmd("rm").deny("rm blocked"),
      ]),
      command: 'bash -c "$VAR"',
      security: STRICT_DENY,
    });
    expect(out.terminal?.kind).toBe("deny");
    expect(out.annotations.filter((a) => a.kind === "warning")).toHaveLength(0);
    expect(out.annotations.filter((a) => a.kind === "note")).toHaveLength(0);
  });
});
