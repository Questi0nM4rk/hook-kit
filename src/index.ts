// @questi0nm4rk/hook-kit — framework for building compiled hook binaries
// See docs/SPEC.md for architecture

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

// Rule builders
export { cmd } from "./rules/command.js";
export { content } from "./rules/content.js";
export { custom } from "./rules/custom.js";
export { path } from "./rules/path.js";
export { stateful } from "./rules/state.js";
