// @questi0nm4rk/hook-kit/testing — test-builders SDK
//
// Fluent assertion runner + event factories + mock state/askpass for
// downstream consumers writing rule tests. Keeps `runModule` /
// `evaluateRule` from the main barrel as low-level escape hatches; this
// subpath is the ergonomic primary lens.

// Event factories
export { bashEvent, type EventOpts, editEvent, readEvent, writeEvent } from "./events.js";
// Fluent runner
export { expectModule, expectRule, type StringMatcher } from "./expect.js";
// Mock askpass script generator
export {
  type MockAskpass,
  type MockAskpassResponse,
  mockAskpass,
} from "./mock-askpass.js";
// Mock state store
export { type MockStateOpts, mockState } from "./mock-state.js";
