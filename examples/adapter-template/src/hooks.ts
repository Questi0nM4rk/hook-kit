// STUB demo modules. NOT a real rule set — these exist to exercise the
// adapter's wire format end-to-end (deny / ask / annotation / clean).
// REPLACE with your own composition of cmd() / path() / pipe() / redirect()
// / content() / custom() / stateful() primitives. See the ai-guardrails
// example for a real rule set, and docs/SPEC.md § Builders for the full
// primitive catalog.

import { cmd, createModule } from "@questi0nm4rk/hook-kit";

const destructiveRm = createModule(
  {
    id: "demo-destructive-rm",
    name: "Demo: destructive rm",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [cmd("rm").withFlag("-r").withFlag("-f").deny("destructive rm -rf", "[template-demo]")],
);

const gitForcePush = createModule(
  {
    id: "demo-git-force-push",
    name: "Demo: git force-push",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [
    cmd("git", "push")
      .withFlag("--force")
      .withoutFlag("--force-with-lease")
      .ask("force-push needs review", "[template-demo]"),
  ],
);

const rmWarning = createModule(
  {
    id: "demo-rm-warning",
    name: "Demo: rm warning",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  // Plain `rm` (no -r/-f) — fires a warning but lets the command run. Exists
  // so the e2e test can exercise the annotation-only path.
  [
    cmd("rm")
      .withoutFlag("-r")
      .withoutFlag("-f")
      .warning("rm without -rf still deletes files", "[template-demo]"),
  ],
);

export const hooks = [destructiveRm, gitForcePush, rmWarning];
