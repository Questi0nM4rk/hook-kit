// biome-ignore-all lint/suspicious/noMisplacedAssertion: BDD step bodies (Given/When/Then) contain expect() calls; the BDD runner invokes them inside test() blocks at runtime, but biome only sees them at module scope.

import { expect } from "bun:test";
import { Given, Then, When } from "@questi0nm4rk/feats";
import { rawAdapter } from "../../src/adapters/raw.js";
import { createModule } from "../../src/core/module.js";
import type { HookModule, RawAdapterState } from "../../src/index.js";
import { cmd, path, run } from "../../src/index.js";
import { bashEvent, writeEvent } from "../_helpers.js";

interface RunPipelineWorld {
  modules: HookModule[];
  state?: RawAdapterState;
  [key: string]: unknown;
}

function asString(v: unknown): string {
  if (typeof v !== "string") {
    throw new Error(`expected string, got ${typeof v}`);
  }
  return v;
}

Given<RunPipelineWorld>(
  "a hook module that denies {string} with reason {string}",
  (world: RunPipelineWorld, commandArg: unknown, reasonArg: unknown) => {
    const command = asString(commandArg);
    const reason = asString(reasonArg);
    const parts = command.split(/\s+/).filter((p) => p.length > 0);
    const head = parts[0];
    if (head === undefined) {
      throw new Error("empty command");
    }
    const rest = parts.slice(1);
    const subs = rest.filter((p) => !p.startsWith("-"));
    const flags = rest.filter((p) => p.startsWith("-"));
    let builder = cmd(head, ...subs);
    for (const flag of flags) {
      builder = builder.withFlag(flag);
    }
    world.modules = [
      createModule({ id: "m", name: "scenario", events: ["PreToolUse"], matchers: ["Bash"] }, [
        builder.deny(reason),
      ]),
    ];
  },
);

Given<RunPipelineWorld>(
  "a hook module that denies writes to {string} with reason {string}",
  (world: RunPipelineWorld, suffixArg: unknown, reasonArg: unknown) => {
    const suffix = asString(suffixArg);
    const reason = asString(reasonArg);
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    world.modules = [
      createModule(
        { id: "m", name: "scenario", events: ["PreToolUse"], matchers: ["Write", "Edit"] },
        [
          path(new RegExp(`${escaped}$`))
            .onWrite()
            .deny(reason),
        ],
      ),
    ];
  },
);

When<RunPipelineWorld>(
  "the runner processes a Bash event with command {string}",
  async (world: RunPipelineWorld, commandArg: unknown) => {
    const command = asString(commandArg);
    const { adapter, state } = rawAdapter(bashEvent(command));
    await run(world.modules, adapter);
    world.state = state;
  },
);

When<RunPipelineWorld>(
  "the runner processes a Write event with file {string}",
  async (world: RunPipelineWorld, filePathArg: unknown) => {
    const filePath = asString(filePathArg);
    const { adapter, state } = rawAdapter(writeEvent(filePath));
    await run(world.modules, adapter);
    world.state = state;
  },
);

Then<RunPipelineWorld>(
  "the captured decision is a deny with reason {string}",
  (world: RunPipelineWorld, reasonArg: unknown) => {
    const reason = asString(reasonArg);
    expect(world.state?.outcome.terminal).toEqual({ kind: "deny", reason });
    expect(world.state?.outcome.annotations).toEqual([]);
  },
);

Then<RunPipelineWorld>("the captured decision is silent", (world: RunPipelineWorld) => {
  expect(world.state?.outcome.terminal).toBeNull();
  expect(world.state?.outcome.annotations).toEqual([]);
});

Then<RunPipelineWorld>("the captured decision is an ask", (world: RunPipelineWorld) => {
  expect(world.state?.outcome.terminal?.kind).toBe("ask");
});
