/**
 * Core types for hook-kit. Protocol-agnostic — no CC-specific concepts here.
 * See docs/SPEC.md § Core Types for the full contract.
 */

import type { ShellFile } from "@questi0nm4rk/shell-ast";

// === Decisions (blacklist semantics) ===

/** Non-null = action to take. null = silent pass-through (didn't block). */
export type Decision =
  | { readonly kind: "deny"; readonly reason: string; readonly label?: string }
  | { readonly kind: "context"; readonly message: string; readonly label?: string }
  | { readonly kind: "escalate"; readonly reason: string; readonly label?: string }
  | null;

// === Events ===

export interface HookEvent {
  readonly eventName: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ToolEvent =
  | { readonly type: "bash"; readonly command: string }
  | { readonly type: "write"; readonly path: string; readonly content?: string }
  | { readonly type: "read"; readonly path: string }
  | {
      readonly type: "edit";
      readonly path: string;
      readonly oldStr?: string;
      readonly newStr?: string;
    }
  | {
      readonly type: "other";
      readonly toolName: string;
      readonly toolInput: Readonly<Record<string, unknown>>;
    };

// === Rules ===

export interface Rule {
  readonly kind: string;
  evaluate(event: HookEvent, ctx: EvalContext): Decision | Promise<Decision>;
}

export interface EvalContext {
  readonly state: StateStore;
  readonly modules: readonly HookModule[];
  /**
   * Lazily parses the Bash command for the current event and caches it across
   * all rules within a single `evaluate()` invocation. Returns `null` for
   * non-Bash events, an empty/missing command, or an unparseable command
   * (Iron Law 3: fail open on infra errors).
   */
  getBashAst(): Promise<ShellFile | null>;
}

// === Modules ===

export interface HookModule {
  readonly id: string;
  readonly name: string;
  readonly events: readonly string[];
  readonly matchers?: readonly string[];
  readonly rules: readonly Rule[];
  readonly enabled?: boolean;
}

// === State ===

export interface StateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  delete(key: string): void;
  flush(): void | Promise<void>;
}
