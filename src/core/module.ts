import type { HookModule, Rule } from "./types.js";

export interface ModuleConfig {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];
  readonly matchers?: readonly string[];
  readonly enabled?: boolean;
}

export function createModule(config: ModuleConfig, rules: Rule[]): HookModule {
  return { ...config, rules, enabled: config.enabled ?? true };
}
