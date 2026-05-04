// content() builder — PostToolUse body inspection from disk
// See docs/SPEC.md § Rule Builders

import { existsSync, readFileSync } from "node:fs";
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

        if (!existsSync(filePath)) return null; // fail open: file vanished
        let body: string;
        try {
          body = readFileSync(filePath, "utf8");
        } catch {
          return null;
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
