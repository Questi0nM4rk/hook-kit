/**
 * Shared annotation render + partition helpers used by both rendering paths
 * (shell wrapper `runShell` and CC adapter `decideCcOutput` / `resolveCcOutput`).
 *
 * `error` annotations are kept separate from `warning` / `note` because they
 * always route to stderr regardless of terminal decision, and they survive
 * `deny` (per the v0.5 merge policy). The two rendering paths previously
 * inlined identical partition + format logic — this module is the single
 * source of truth.
 *
 * Formatters return lines WITHOUT a trailing newline. Callers append `\n`
 * when writing to a line-oriented stream (stdout/stderr), or join with `\n`
 * when bundling into a structured payload (CC's `additionalContext`).
 */

import type { Annotation } from "./types.js";

export type ErrorAnnotation = Extract<Annotation, { kind: "error" }>;
export type NonErrorAnnotation = Exclude<Annotation, { kind: "error" }>;

export function partitionAnnotations(anns: readonly Annotation[]): {
  others: NonErrorAnnotation[];
  errors: ErrorAnnotation[];
} {
  const others: NonErrorAnnotation[] = [];
  const errors: ErrorAnnotation[] = [];
  for (const a of anns) {
    if (a.kind === "error") {
      errors.push(a);
    } else {
      others.push(a);
    }
  }
  return { others, errors };
}

export function formatNonErrorAnnotation(a: NonErrorAnnotation): string {
  return `${a.label ?? "[hook-kit]"} ${a.kind}: ${a.message}`;
}

export function formatErrorAnnotation(a: ErrorAnnotation): string {
  return `${a.label ?? "[hook-kit]"} error: ${a.errorCode}: ${a.message}`;
}
