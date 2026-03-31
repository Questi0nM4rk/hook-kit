// @questi0nm4rk/hook-kit — framework for building compiled hook binaries
// See docs/specs/SPEC-001-hook-kit.md for architecture

// Core types
export type {
  Decision,
  HookEvent,
  HookModule,
  Rule,
  EvalContext,
  ToolEvent,
} from "./core/types.js";

// Decision constructors
export { deny, context, escalate } from "./core/decision.js";

// Event helpers
export { toToolEvent } from "./core/event.js";

// Module factory
export { createModule } from "./core/module.js";

// Rule builders
export { cmd } from "./rules/command.js";
export { path } from "./rules/path.js";
export { content } from "./rules/content.js";
export { custom } from "./rules/custom.js";
export { stateful } from "./rules/state.js";
