// A4 (0.6.0): `EvaluateOptions.shellAstOpts.globalFlags` is passed through
// to every `unwrapCall(call, opts)` site. Consumers register per-tool
// value-taking flags so commands like `terraform -chdir=./infra apply` resolve
// `apply` as args[0] instead of being shifted by the unconsumed -chdir value.
//
// shell-ast's built-in GLOBAL_VALUE_FLAGS covers git/docker/kubectl/make/tar/
// xargs + aws/gcloud/terraform/npm/cargo/gh (since shell-ast 0.8.0). Anything
// outside that list needs registration — this is the path. `kustomize` is a
// deliberately-unregistered tool here precisely because shell-ast does NOT ship
// it, so it still demonstrates the space-form value-flag bypass.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { runModule } from "../../src/engine/index.js";
import { modOf } from "../_helpers.js";

describe("shellAstOpts.globalFlags pass-through (A4)", () => {
  test("unregistered tool: --load-restrictor X shifts build out of args[0] (no match)", async () => {
    // Without globalFlags registration, shell-ast treats --load-restrictor as a
    // boolean flag (space form), so its value 'LoadRestrictionsNone' lands at
    // u.args[0] and 'build' shifts to args[1]. cmd("kustomize","build") requires
    // args[0]==="build" — NO match. (terraform -chdir would NO LONGER show this:
    // shell-ast 0.8.0 ships terraform in its built-in GLOBAL_VALUE_FLAGS, so
    // -chdir is consumed without registration. kustomize is still unregistered.)
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "kustomize --load-restrictor LoadRestrictionsNone build /overlay", // space form
    });
    expect(out.terminal).toBeNull();
  });

  test("terraform WITH registration: space form fires correctly", async () => {
    const mod = modOf(cmd("terraform", "apply").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "terraform -chdir ./infra apply",
      shellAstOpts: { globalFlags: { terraform: ["-chdir"] } },
    });
    // With registration: -chdir consumes ./infra; args[0] = "apply"
    expect(out.terminal?.kind).toBe("deny");
  });

  test("terraform = form fires regardless of registration", async () => {
    const mod = modOf(cmd("terraform", "apply").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "terraform -chdir=./infra apply",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("registered globalFlags merge with built-in (git -C still works)", async () => {
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "git -C /tmp worktree add /tmp/x main",
      shellAstOpts: { globalFlags: { terraform: ["-chdir"] } }, // unrelated
    });
    // built-in git table still active even when extra tool registered
    expect(out.terminal?.kind).toBe("deny");
  });

  test("multiple tools registered at once", async () => {
    const tfMod = modOf(cmd("terraform", "destroy").deny("blocked"));
    const kustomizeMod = modOf(cmd("kustomize", "build").warning("kustomize build"));
    const opts = {
      shellAstOpts: {
        globalFlags: {
          terraform: ["-chdir"],
          kustomize: ["--load-restrictor"],
        },
      },
    };

    const tfOut = await runModule({
      module: tfMod,
      command: "terraform -chdir /infra destroy",
      ...opts,
    });
    expect(tfOut.terminal?.kind).toBe("deny");

    const kOut = await runModule({
      module: kustomizeMod,
      command: "kustomize --load-restrictor LoadRestrictionsNone build /overlay",
      ...opts,
    });
    expect(kOut.annotations.find((a) => a.kind === "warning")).toBeDefined();
  });

  test("opts threaded through inline-shell recursion", async () => {
    // bash -c "terraform -chdir /infra apply" — engine recurses into the
    // inner script and runs the same modules. The shellAstOpts must follow.
    const mod = modOf(cmd("terraform", "apply").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: 'bash -c "terraform -chdir /infra apply"',
      shellAstOpts: { globalFlags: { terraform: ["-chdir"] } },
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("opts threaded through sudo unwrap", async () => {
    // sudo terraform -chdir /infra apply — wrapped variant. unwrapCall(call, opts)
    // re-resolves the inner with the same opts.
    const mod = modOf(cmd("terraform", "apply").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "sudo terraform -chdir /infra apply",
      shellAstOpts: { globalFlags: { terraform: ["-chdir"] } },
    });
    expect(out.terminal?.kind).toBe("deny");
  });
});
