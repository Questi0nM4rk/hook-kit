// @questi0nm4rk/hook-kit — framework for building compiled hook binaries
// See docs/SPEC.md for architecture
// biome-ignore-all lint/performance/noBarrelFile: src/index.ts is the public API barrel — the entire point of the file.

// Adapter interface + raw adapter (for library/test use)
export { type RawAdapter, type RawAdapterState, rawAdapter } from "./adapters/raw.js";
export type { ProtocolAdapter } from "./adapters/types.js";
// Rule builders
export { allowOnly } from "./builders/allow-only.js";
export { cmd } from "./builders/command.js";
export { content } from "./builders/content.js";
export { custom } from "./builders/custom.js";
export { path } from "./builders/path.js";
export { pipe } from "./builders/pipe.js";
export { type ProtectMode, protectPath } from "./builders/protect-path.js";
export { redirect } from "./builders/redirect.js";
export { stateful } from "./builders/state.js";
// Annotation formatters — re-exported for custom adapters emitting the
// shell-wrapper convention. Pass `defaultLabel` to override the "[hook-kit]"
// fallback without re-implementing the line format.
export {
  type ErrorAnnotation,
  formatErrorAnnotation,
  formatNonErrorAnnotation,
  type NonErrorAnnotation,
  partitionAnnotations,
} from "./core/annotations.js";
// Decision constructors
export { ask, deny, note, warning } from "./core/decision.js";
// Typed errors — thrown by rules / engine boundary, surfaced as `error`
// annotations in EvaluationOutcome.annotations. Consumers writing custom
// rules can throw these to surface infra failures through the annotation
// channel rather than swallowing them.
export type { HookKitErrorCode } from "./core/errors.js";
export {
  EnvelopeValidationError,
  FileReadError,
  FileWriteError,
  HookKitError,
  JsonParseError,
  ObserverError,
  ProcessSpawnError,
  ProtocolVersionError,
  RuleEvaluationError,
  ShellAstParseError,
  StateStoreError,
} from "./core/errors.js";
// Event helpers
export { toToolEvent } from "./core/event.js";
// Module factory
export { createModule } from "./core/module.js";
// Security uncertainty path (issue #14) — config surface, profiles, and the
// `escalate` emit helper matchers call for values they cannot statically
// certify. @experimental until the SA-01..SA-10 epic completes.
export {
  type EngineUnavailablePolicy,
  type EscalationDecision,
  escalate,
  isUncertaintyDecision,
  type SecurityOptions,
  STRICT_BUT_ASKS,
  STRICT_DENY,
} from "./core/security.js";
// Core types
export type {
  Annotation,
  Decision,
  DecisionEventRecord,
  DecisionObserver,
  EvalContext,
  EvaluationOutcome,
  HookEvent,
  HookModule,
  Rule,
  Terminal,
  ToolEvent,
} from "./core/types.js";
// Engine
export {
  type EvaluateOptions,
  evaluate,
  evaluateRule,
  type RunModuleOptions,
  runModule,
} from "./engine/index.js";
// Entry point — adapter mode (used by cc-tools binary, library consumers)
export { type RunOptions, run } from "./run.js";
// Entry point — shell-wrapper mode (the v0.3 default for compiled binaries)
export { type RunShellOptions, runShell } from "./wrapper/hk.js";
