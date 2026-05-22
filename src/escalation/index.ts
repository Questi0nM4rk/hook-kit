// @internal — escalation subsystem barrel.
//
// The askpass envelope schema + `PROTOCOL_VERSION` are part of the public
// STABLE contract (see docs/ESCALATION.md). The broker / listener
// primitives below are INTERNAL for v1.0 — exported here so worked-example
// listeners (examples/escalation-listener-stdout/) and downstream listener
// implementations can use them, but the surface may change in a future
// minor based on listener-author demand. See docs/STABILITY.md for tier
// semantics.
// biome-ignore-all lint/performance/noBarrelFile: subpath public API barrel for `@questi0nm4rk/hook-kit/escalation`.

// Askpass driver (INTERNAL — `HOOK_KIT_ASKPASS` env-var contract is STABLE)
export { type CallAskpassOptions, callAskpass } from "./askpass.js";

// Broker primitives (INTERNAL — see docs/ESCALATION.md § Public broker functions)
export {
  type BrokerAskpassOptions,
  type BrokerPaths,
  brokerAskpass,
  brokerPaths,
  ensureSession,
  type ListSessionsOptions,
  listPending,
  listSessions,
  type SessionInfo,
  type SessionMeta,
  type SubmitDecisionOptions,
  submitDecision,
} from "./broker.js";
// Envelope schema + helpers (STABLE — see docs/ESCALATION.md § Envelope schema)
export {
  type AskDecisionKind,
  type AskRequest,
  type AskResponse,
  type CreateAskOptions,
  type CreateResponseOptions,
  createAskRequest,
  createAskResponse,
  type GitInfo,
  type Harness,
  PROTOCOL_VERSION,
  parseAskRequest,
  parseAskResponse,
} from "./envelope.js";

// Forwarder (INTERNAL)
export { type ForwardOptions, type ForwardResult, forwardUp } from "./forward.js";
// Listener primitives (INTERNAL)
export {
  hasParentListener,
  type ListenerMarker,
  type ListenerMode,
  liveListeners,
  type RegisterOptions,
  registerListener,
} from "./listeners.js";
