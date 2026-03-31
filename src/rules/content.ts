// content() builder — PostToolUse body inspection
// See SPEC-001 § Rule Builder API

import type { Decision, HookEvent, Rule } from "../core/types.js";

export function content(): ContentRuleBuilder {
  return new ContentRuleBuilder();
}

class ContentRuleBuilder {
  private pathPattern?: RegExp;

  matchPath(pattern: RegExp): this {
    this.pathPattern = pattern;
    return this;
  }

  validate(fn: (filePath: string, body: string) => Decision | Promise<Decision>): Rule {
    const _pathPattern = this.pathPattern;
    void fn;
    // TODO: implement in Phase 1
    return {
      kind: "content",
      async evaluate(_event: HookEvent): Promise<Decision> {
        return null;
      },
    };
  }
}
