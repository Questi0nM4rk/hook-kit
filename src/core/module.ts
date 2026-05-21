import type { HookModule, Rule } from "./types.js";

export interface ModuleConfig {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];
  readonly matchers?: readonly string[];
  readonly enabled?: boolean;
}

/** Factory that bundles config + rules into a `HookModule`. `enabled` defaults
 *  to `true`.
 *  @stable @since 1.0.0 */
export function createModule(config: ModuleConfig, rules: Rule[]): HookModule {
  return { ...config, rules, enabled: config.enabled ?? true };
}
