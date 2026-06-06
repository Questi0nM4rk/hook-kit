import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_BUT_ASKS } from "../../src/core/security.js";
import { __setMaxRecurseDepthForTests, evaluate, runModule } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent, moduleWith } from "../_helpers.js";

// Engine default for MAX_RECURSE_DEPTH; restore it after forcing the cap to 0.
const DEFAULT_MAX_DEPTH = 5;

// SA-10 (#24): observer records carry reasonKind ("rule" | "uncertainty") so
// operators can tune escalation noise separately from explicit rule decisions.
describe("SA-10 reasonKind on decision records", () => {
  test("a rule's own deny is reasonKind 'rule'", async () => {
    const obs = mockObserver();
    await runModule({
      module: moduleWith([cmd("rm").deny("x")]),
      command: "rm -rf /tmp/x",
      observers: [obs],
    });
    const deny = obs.records.find((r) => r.decision === "deny");
    expect(deny?.reasonKind).toBe("rule");
  });

  test("a dynamic-command-word escalation is reasonKind 'uncertainty'", async () => {
    const obs = mockObserver();
    await runModule({
      module: moduleWith([cmd("rm").deny("x")]),
      command: "$CMD -rf /tmp/x",
      observers: [obs],
    });
    const ask = obs.records.find((r) => r.decision === "ask");
    expect(ask?.reasonKind).toBe("uncertainty");
  });

  test("a warning annotation is reasonKind 'rule'", async () => {
    const obs = mockObserver();
    await runModule({
      module: moduleWith([cmd("rm").warning("heads up")]),
      command: "rm -rf /tmp/x",
      observers: [obs],
    });
    const warn = obs.records.find((r) => r.decision === "warning");
    expect(warn?.reasonKind).toBe("rule");
  });
});

// SA-10 extension: engine-side security escalations (depth / opaque-shell /
// unparsable) call escalate()/denyDecision directly and return — they must ALSO
// flow through the observer-notify path so SA-10's reasonKind tuning can see
// them. Previously these terminals produced NO DecisionEventRecord.
describe("SA-10 reasonKind on engine-side security escalations", () => {
  test("depth-exceeded escalation emits an observer record with reasonKind 'uncertainty'", async () => {
    const obs = mockObserver();
    __setMaxRecurseDepthForTests(0);
    try {
      // `cmd("bash")` fires nothing here; the depth cap (0) trips on the first
      // inline-shell frame before any inner recursion, escalating per
      // onDepthExceeded (ask by default).
      await evaluate(bashEvent("bash -c 'rm -rf /'"), [moduleWith([cmd("rm").deny("x")])], {
        observers: [obs],
        security: STRICT_BUT_ASKS,
      });
    } finally {
      __setMaxRecurseDepthForTests(DEFAULT_MAX_DEPTH);
    }
    const rec = obs.records.find((r) => r.reasonKind === "uncertainty");
    expect(rec).toBeDefined();
    expect(rec?.ruleKind).toBe("depth");
    expect(rec?.decision).toBe("ask");
  });

  test("opaque-inline-shell escalation emits an observer record with reasonKind 'uncertainty'", async () => {
    const obs = mockObserver();
    await runModule({
      module: moduleWith([cmd("rm").deny("x")]),
      command: 'eval "$X"',
      observers: [obs],
      security: STRICT_BUT_ASKS,
    });
    const rec = obs.records.find((r) => r.reasonKind === "uncertainty");
    expect(rec).toBeDefined();
    expect(rec?.ruleKind).toBe("opaque-shell");
    expect(rec?.decision).toBe("ask");
  });

  test("unparsable escalation emits an observer record with reasonKind 'uncertainty'", async () => {
    const obs = mockObserver();
    // An unbalanced quote is rejected by shell-ast's parser (ParseSyntaxError)
    // → SA-03 unparsable path → escalate per onUnparsable (ask by default).
    await runModule({
      module: moduleWith([cmd("rm").deny("x")]),
      command: 'echo "unterminated',
      observers: [obs],
      security: STRICT_BUT_ASKS,
    });
    const rec = obs.records.find((r) => r.reasonKind === "uncertainty");
    expect(rec).toBeDefined();
    expect(rec?.ruleKind).toBe("unparsable");
    expect(rec?.decision).toBe("ask");
  });
});
