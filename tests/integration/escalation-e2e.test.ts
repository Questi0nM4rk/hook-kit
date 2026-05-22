// biome-ignore-all lint/style/noMagicNumbers: integration tests use literal session/version values inline so cross-feature wiring stays readable; named constants would obscure the test intent.

// M1.4 + M1.1 + M1.2 triple-window e2e — per L-M1.3-5.
//
// Validates THREE features in one suite:
//   1. M1.4 escalation protocol: HOOK_KIT_ASKPASS env contract, mock askpass
//      round-trip, fail-CLOSED on broken askpass infra.
//   2. M1.1 DecisionObserver: observers fire on `ask` decisions BEFORE the
//      askpass round-trip resolves to the final terminal.
//   3. M1.2 ProtocolAdapter contract: the CC adapter's `resolveCcOutput`
//      faithfully renders the final terminal (CC's CcOutput shape) after
//      the listener response or fallback to harness-ask.
//
// Pure-protocol broker tests (v=1/v=99/v=2 rejection + acceptance through
// brokerAskpass) live in tests/escalation/broker-version.test.ts — this
// suite intentionally focuses on the observer + adapter integration axes.
//
// Library-mode (direct `evaluate()` + `resolveCcOutput()` calls) — NOT
// against the compiled binary. The compiled-binary e2e is covered by
// tests/build/end-to-end.test.ts (escalation flow against `dist/hk`)
// and tests/build/adapter-template-e2e.test.ts (M1.3 adapter triple-window).
// This suite covers the M1.4 askpass-routing surface + observer wiring at
// the adapter boundary without paying the 10-30s compile cost.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveCcOutput } from "../../src/adapters/claude-code.js";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import type { DecisionEventRecord, HookModule } from "../../src/core/types.js";
import { evaluate } from "../../src/engine/index.js";
import { mockAskpass } from "../../src/testing/mock-askpass.js";
import { mockObserver } from "../../src/testing/mock-observer.js";
import { bashEvent } from "../_helpers.js";

const ASK_MODULE: HookModule = createModule(
  {
    id: "git-force-push",
    name: "git-force-push",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [cmd("git").withFlag("--force").ask("force-push needs review", "[strict]")],
);

const PRIOR_HOOK_KIT_ASKPASS = process.env.HOOK_KIT_ASKPASS;

beforeEach(() => {
  delete process.env.HOOK_KIT_ASKPASS;
});

afterEach(() => {
  if (PRIOR_HOOK_KIT_ASKPASS === undefined) {
    delete process.env.HOOK_KIT_ASKPASS;
  } else {
    process.env.HOOK_KIT_ASKPASS = PRIOR_HOOK_KIT_ASKPASS;
  }
});

describe("M1.4 escalation e2e — triple-window (protocol + observer + adapter)", () => {
  test("case 1: HOOK_KIT_ASKPASS unset → engine produces ask + observer captured + adapter renders harness-ask CcOutput", async () => {
    // The full ask-without-broker path: engine produces an `ask` terminal,
    // observer captures the rule-emitted ask, the CC adapter's resolveCcOutput
    // routes through callAskpass which sees an unset env and synthesizes a
    // harness-ask response — surfaced to CC as `permissionDecision: "ask"`.
    const obs = mockObserver();
    const event = bashEvent("git push --force");
    const outcome = await evaluate(event, [ASK_MODULE], { observers: [obs] });

    // M1.1: observer captured the ask BEFORE adapter resolution.
    expect(outcome.terminal?.kind).toBe("ask");
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("ask");
    expect(obs.records[0]?.ruleId).toBe("git-force-push:command:0");

    // M1.2: adapter renders harness-ask through CC's wire format.
    const cc = await resolveCcOutput(outcome, event);
    // PreToolUse renders harness-ask as permissionDecision:"ask" in stdout JSON.
    expect(cc.exitCode).toBe(0);
    expect(cc.stdout).toMatch(/permissionDecision/);
    expect(cc.stdout).toMatch(/force-push needs review/);
  });

  test("case 2: askpass present + decides 'allow' via mockAskpass → observer sees pre-escalation ask + adapter renders silent allow", async () => {
    // M1.1+M1.2+M1.4 full integration: ask flows from rule → observer
    // (captures `decision: "ask"`) → engine outcome (ask terminal) →
    // adapter's resolveCcOutput → callAskpass → mock askpass returns
    // {decision: "allow"} → adapter renders silent allow CcOutput.
    const askpass = mockAskpass({ decision: "allow" });
    process.env.HOOK_KIT_ASKPASS = askpass.path;
    try {
      const obs = mockObserver();
      const event = bashEvent("git push --force");
      const outcome = await evaluate(event, [ASK_MODULE], { observers: [obs] });

      // M1.1: observer captured the rule-emitted ask BEFORE adapter resolution.
      expect(outcome.terminal?.kind).toBe("ask");
      expect(obs.records).toHaveLength(1);
      expect(obs.records[0]?.decision).toBe("ask");
      expect(obs.records[0]?.ruleId).toBe("git-force-push:command:0");

      // M1.2+M1.4: adapter resolves through askpass → allow → silent CcOutput.
      const cc = await resolveCcOutput(outcome, event);
      expect(cc.exitCode).toBe(0);
      // Allow path: no permissionDecision in stdout (silent).
      expect(cc.stdout).toBe("");
    } finally {
      askpass.cleanup();
    }
  });

  test("case 3: askpass present + decides 'deny' via mockAskpass → observer sees pre-escalation ask + adapter renders deny CcOutput", async () => {
    // Mirror of case 2 with the listener voting deny. Same observer
    // contract: observer captures the rule-emitted ask. Adapter renders
    // CC's deny via permissionDecision:"deny".
    const askpass = mockAskpass({ decision: "deny", reason: "force-push to main is blocked" });
    process.env.HOOK_KIT_ASKPASS = askpass.path;
    try {
      const obs = mockObserver();
      const event = bashEvent("git push --force");
      const outcome = await evaluate(event, [ASK_MODULE], { observers: [obs] });

      // M1.1: observer captured the rule-emitted ask (pre-escalation).
      expect(outcome.terminal?.kind).toBe("ask");
      expect(obs.records).toHaveLength(1);
      expect(obs.records[0]?.decision).toBe("ask");

      // M1.2+M1.4: adapter resolves through askpass → deny → CC deny.
      // CC renders deny as permissionDecision:"block" (its wire-format
      // vocabulary; see src/adapters/claude-code.ts).
      const cc = await resolveCcOutput(outcome, event);
      expect(cc.exitCode).toBe(0);
      expect(cc.stdout).toMatch(/permissionDecision/);
      expect(cc.stdout).toMatch(/block/);
      expect(cc.stdout).toMatch(/force-push to main is blocked/);
    } finally {
      askpass.cleanup();
    }
  });

  test("case 4: askpass binary missing → fail-CLOSED with deny + observer fires on the original ask", async () => {
    // Per docs/SPEC.md § Askpass Contract: HOOK_KIT_ASKPASS set but the
    // binary is missing → Iron Law 4 exception, fail-CLOSED with a deny.
    // The observer STILL captures the original rule-emitted ask record.
    process.env.HOOK_KIT_ASKPASS = "/this/does/not/exist-m14-e2e";
    const obs = mockObserver();
    const event = bashEvent("git push --force");
    const outcome = await evaluate(event, [ASK_MODULE], { observers: [obs] });

    // Engine still produces an ask terminal; askpass routing happens at the adapter.
    expect(outcome.terminal?.kind).toBe("ask");
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("ask");

    // M1.2: adapter resolves through callAskpass which fails to spawn
    // → fail-CLOSED with a synthesized deny (CC renders as "block").
    const cc = await resolveCcOutput(outcome, event);
    expect(cc.exitCode).toBe(0);
    expect(cc.stdout).toMatch(/permissionDecision/);
    expect(cc.stdout).toMatch(/block/);
    // The deny reason carries the escalation-infrastructure-unavailable signal.
    expect(cc.stdout).toMatch(/escalation infrastructure unavailable|cannot spawn askpass/);
  });

  test("case 5: throwing observer + ask → fail-open, ask still surfaces, ObserverError annotation lands", async () => {
    // M1.1 observer fail-open boundary, applied during an ask path. The
    // observer throws on the ask record; the engine catches, surfaces as
    // an `error` annotation, and the ask terminal still wins. With no
    // askpass configured, the outcome is the ask itself.
    const obs = mockObserver({
      throwOn: (r: DecisionEventRecord) => r.decision === "ask",
    });
    const event = bashEvent("git push --force");
    const outcome = await evaluate(event, [ASK_MODULE], { observers: [obs] });

    expect(outcome.terminal?.kind).toBe("ask");
    const errors = outcome.annotations.filter((a) => a.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind === "error" && errors[0].errorCode).toBe("ObserverError");
    // Observer's records still contain the captured ask (the push happens
    // BEFORE the throw inside mockObserver).
    expect(obs.records).toHaveLength(1);
    expect(obs.records[0]?.decision).toBe("ask");
  });
});
