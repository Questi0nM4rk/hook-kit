// @questi0nm4rk/hook-kit — framework for building compiled hook binaries
// See docs/SPEC.md for architecture

// Adapter interface + raw adapter (for library/test use)
export { type RawAdapter, type RawAdapterState, rawAdapter } from "./adapters/raw.js";
export type { ProtocolAdapter } from "./adapters/types.js";
// Decision constructors
export { context, deny, escalate } from "./core/decision.js";
// Event helpers
export { toToolEvent } from "./core/event.js";
// Module factory
export { createModule } from "./core/module.js";
// Core types
export type {
  Decision,
  EvalContext,
  HookEvent,
  HookModule,
  Rule,
  ToolEvent,
} from "./core/types.js";
// Engine
export { type EvaluateOptions, evaluate } from "./engine/index.js";
// Rule builders
export { cmd } from "./rules/command.js";
export { content } from "./rules/content.js";
export { custom } from "./rules/custom.js";
export { path } from "./rules/path.js";
export { pipe } from "./rules/pipe.js";
export { redirect } from "./rules/redirect.js";
export { stateful } from "./rules/state.js";
// Entry point — adapter mode (used by cc-tools binary, library consumers)
export { type RunOptions, run } from "./run.js";
// Entry point — shell-wrapper mode (the v0.3 default for compiled binaries)
export { type RunShellOptions, runShell } from "./wrapper/hk.js";
