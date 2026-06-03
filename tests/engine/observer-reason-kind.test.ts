import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { runModule } from "../../src/engine/index.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { moduleWith } from "../_helpers.js";

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
