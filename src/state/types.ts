// Stable subpath re-export so consumers can `import { StateStore } from
// "@questi0nm4rk/hook-kit/state"` per STABILITY.md § Public Subpath Exports.
// The interface itself lives in core; this file is purely a re-export to
// resolve the package.json `./state` subpath without exposing core internals.

/** @stable @since 1.0.0 */
export type { StateStore } from "../core/types.js";
