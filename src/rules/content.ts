// content() builder — PostToolUse body inspection from disk
// See docs/SPEC.md § Rule Builders

import { existsSync, readFileSync } from "node:fs";
import { FileReadError } from "../core/errors.js";
import type { Decision, HookEvent, Rule } from "../core/types.js";

export type ContentValidator = (filePath: string, body: string) => Decision | Promise<Decision>;

export function content(): ContentRuleBuilder {
  return new ContentRuleBuilder();
}

class ContentRuleBuilder {
  private pathPattern: RegExp | undefined;

  matchPath(pattern: RegExp): this {
    this.pathPattern = pattern;
    return this;
  }

  validate(fn: ContentValidator): Rule {
    const pathPattern = this.pathPattern;
    return {
      kind: "content",
      async evaluate(event: HookEvent): Promise<Decision> {
        // PostToolUse only — at PostToolUse the tool has already run, so the
        // file on disk reflects the final state.
        if (event.eventName !== "PostToolUse") return null;

        const filePath = extractFilePath(event.toolInput);
        if (filePath === "") return null;
        if (pathPattern !== undefined && !pathPattern.test(filePath)) return null;

        // File vanished between the tool call and the PostToolUse hook — no
        // decision to make, no error to surface. Distinct from an unreadable
        // file that DOES exist (permissions, IO failure), which is a real
        // FileReadError.
        if (!existsSync(filePath)) return null;
        let body: string;
        try {
          body = readFileSync(filePath, "utf8");
        } catch (cause) {
          // The engine catches HookKitErrors thrown from rule.evaluate() and
          // emits them as `error` annotations — the rule contributes no
          // decision, the failure surfaces to stderr, the user's tool call
          // is unaffected.
          throw new FileReadError(filePath, cause);
        }
        return fn(filePath, body);
      },
    };
  }
}

function extractFilePath(input: Readonly<Record<string, unknown>>): string {
  const candidates = [input.file_path, input.notebook_path, input.path];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}
