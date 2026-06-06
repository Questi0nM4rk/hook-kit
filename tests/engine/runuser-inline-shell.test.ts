import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// BUG 6 (SA-02 fail-open): `runuser -u root -c "$EVIL"` is a shell-script
// wrapper exactly like its sibling `su` (shell-ast classifies both as
// wrapped-opaque with a dynamic body). `runuser` was missing from
// INLINE_SHELL_WRAPPERS, so the opaque-inline-shell escalation silently
// skipped it — a banned command could hide behind `runuser -c "$DYN"`.

const mod = () => moduleWith([cmd("rm").deny("rm blocked")]);

describe("BUG 6 — runuser opaque inline-shell escalation", () => {
  test("escalates runuser -c with a dynamic body to ask (matches su control)", async () => {
    const out = await runModule({ module: mod(), command: 'runuser -u root -c "$EVIL"' });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("su -c with a dynamic body escalates (control)", async () => {
    const out = await runModule({ module: mod(), command: 'su -c "$EVIL"' });
    expect(out.terminal?.kind).toBe("ask");
  });
});
