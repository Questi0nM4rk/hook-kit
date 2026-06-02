import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { STRICT_BUT_ASKS, STRICT_DENY } from "../../src/core/security.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-03 (#17), unparsable half: shell-ast's `parse()` throws ParseSyntaxError
// on a command it cannot parse (`echo "unterminated`). The AST is null, so
// every AST-based rule used to silently not-fire — a coverage gap (shell-ast's
// parser may reject something bash would still run). The engine now escalates
// per SecurityOptions.onUnparsable instead. This is NOT an infra error, so no
// `error` annotation is produced (distinct from the engine-unavailable path,
// covered under tests-isolated/).

const mod = () => moduleWith([cmd("rm").deny("rm blocked")]);
const UNPARSABLE = 'echo "unterminated';

describe("SA-03 unparsable command", () => {
  test("escalates to ask under the default profile", async () => {
    const out = await runModule({ module: mod(), command: UNPARSABLE });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("denies under STRICT_DENY (onUnparsable: deny)", async () => {
    const out = await runModule({ module: mod(), command: UNPARSABLE, security: STRICT_DENY });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("stays silent when onUnparsable is 'allow' (legacy fail-open)", async () => {
    const out = await runModule({
      module: mod(),
      command: UNPARSABLE,
      security: { ...STRICT_BUT_ASKS, onUnparsable: "allow" },
    });
    expect(out.terminal).toBeNull();
  });

  test("does not escalate a normal parsable command", async () => {
    const out = await runModule({ module: mod(), command: "ls -la" });
    expect(out.terminal).toBeNull();
  });

  test("produces no error annotation for an unparsable command", async () => {
    const out = await runModule({ module: mod(), command: UNPARSABLE });
    expect(out.annotations.filter((a) => a.kind === "error")).toHaveLength(0);
  });
});
