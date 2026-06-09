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

  test("unregistered tool WITH registration: space form fires correctly", async () => {
    // Re-pointed terraform -> kustomize: shell-ast 0.8.0 ships terraform built-in,
    // so registering it is a no-op and this test would pass even if the
    // registration path were broken. kustomize is still unregistered, so the
    // registration is genuinely load-bearing here.
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "kustomize --load-restrictor LoadRestrictionsNone build /overlay",
      shellAstOpts: { globalFlags: { kustomize: ["--load-restrictor"] } },
    });
    // With registration: --load-restrictor consumes its value; args[0] = "build"
    expect(out.terminal?.kind).toBe("deny");
  });

  test("built-in tool needs no registration: terraform -chdir resolves (0.8.0)", async () => {
    // shell-ast 0.8.0 added terraform to GLOBAL_VALUE_FLAGS, so -chdir is consumed
    // without any globalFlags registration — args[0] = "apply". (Pre-0.8.0 this
    // required registration; the test now documents the built-in coverage.)
    const mod = modOf(cmd("terraform", "apply").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "terraform -chdir ./infra apply", // space form, NO registration
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("= form fires regardless of registration", async () => {
    // = form is special-cased by resolveFlags independently of the value-flag
    // table, so it resolves even for an unregistered tool. kustomize (still
    // unregistered) keeps this discriminating — terraform would now resolve via
    // its built-in table entry and no longer isolate the = form path.
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "kustomize --load-restrictor=LoadRestrictionsNone build /overlay",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("registered globalFlags merge with built-in (git -C still works)", async () => {
    const mod = modOf(cmd("git", "worktree", "add").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "git -C /tmp worktree add /tmp/x main",
      shellAstOpts: { globalFlags: { kustomize: ["--load-restrictor"] } }, // unrelated, still-unregistered
    });
    // built-in git table still active even when extra tool registered
    expect(out.terminal?.kind).toBe("deny");
  });

  test("multiple tools registered at once", async () => {
    // Both tools must be genuinely unregistered for the registration to be
    // load-bearing. terraform was re-pointed -> helm: shell-ast 0.8.0 ships
    // terraform built-in, so registering it proved nothing. helm + kustomize are
    // both still unregistered.
    const helmMod = modOf(cmd("helm", "install").deny("blocked"));
    const kustomizeMod = modOf(cmd("kustomize", "build").warning("kustomize build"));
    const opts = {
      shellAstOpts: {
        globalFlags: {
          helm: ["--namespace"],
          kustomize: ["--load-restrictor"],
        },
      },
    };

    const helmOut = await runModule({
      module: helmMod,
      command: "helm --namespace kube-system install mychart",
      ...opts,
    });
    expect(helmOut.terminal?.kind).toBe("deny");

    const kOut = await runModule({
      module: kustomizeMod,
      command: "kustomize --load-restrictor LoadRestrictionsNone build /overlay",
      ...opts,
    });
    expect(kOut.annotations.find((a) => a.kind === "warning")).toBeDefined();
  });

  test("opts threaded through inline-shell recursion", async () => {
    // bash -c "kustomize --load-restrictor X build" — engine recurses into the
    // inner script and runs the same modules. The shellAstOpts must follow.
    // Re-pointed terraform -> kustomize: terraform is built-in to shell-ast 0.8.0,
    // so its registration is a no-op and this test would pass even if threading
    // were broken. kustomize is still unregistered, so reaching a deny PROVES the
    // registration threaded through the recursion.
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: 'bash -c "kustomize --load-restrictor LoadRestrictionsNone build /overlay"',
      shellAstOpts: { globalFlags: { kustomize: ["--load-restrictor"] } },
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("opts threaded through sudo unwrap", async () => {
    // sudo kustomize --load-restrictor X build — wrapped variant. unwrapCall(call,
    // opts) re-resolves the inner with the same opts. Re-pointed terraform ->
    // kustomize (still unregistered) so the deny actually proves the threading;
    // terraform would now resolve via its built-in table regardless.
    const mod = modOf(cmd("kustomize", "build").deny("blocked"));
    const out = await runModule({
      module: mod,
      command: "sudo kustomize --load-restrictor LoadRestrictionsNone build /overlay",
      shellAstOpts: { globalFlags: { kustomize: ["--load-restrictor"] } },
    });
    expect(out.terminal?.kind).toBe("deny");
  });
});
