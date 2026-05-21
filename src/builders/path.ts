// path() builder — file path pattern matching
// See docs/SPEC.md § Rule Builders

import {
  ask as askDecision,
  deny as denyDecision,
  note as noteDecision,
  warning as warningDecision,
} from "../core/decision.js";
import type { Decision, HookEvent, Rule } from "../core/types.js";

type EventType = "write" | "read" | "both";

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read"]);

/** @stable @since 1.0.0 */
export function path(pattern: RegExp): PathRuleBuilder {
  return new PathRuleBuilder(pattern);
}

class PathRuleBuilder {
  private eventType: EventType = "both";

  constructor(private readonly pattern: RegExp) {}

  onWrite(): this {
    this.eventType = "write";
    return this;
  }
  onRead(): this {
    this.eventType = "read";
    return this;
  }

  deny(reason: string, label?: string): Rule {
    return this.buildRule(denyDecision(reason, label));
  }

  ask(reason: string, label?: string): Rule {
    return this.buildRule(askDecision(reason, label));
  }

  warning(message: string, label?: string): Rule {
    return this.buildRule(warningDecision(message, label));
  }

  note(message: string, label?: string): Rule {
    return this.buildRule(noteDecision(message, label));
  }

  private buildRule(decision: NonNullable<Decision>): Rule {
    const pattern = this.pattern;
    const eventType = this.eventType;
    return {
      kind: "path",
      evaluate(event: HookEvent): Decision {
        const isWrite = WRITE_TOOLS.has(event.toolName);
        const isRead = READ_TOOLS.has(event.toolName);
        if (!isWrite && !isRead) return null;
        if (eventType === "write" && !isWrite) return null;
        if (eventType === "read" && !isRead) return null;

        const filePath = extractFilePath(event.toolInput);
        if (filePath === "") return null;

        return pattern.test(filePath) ? decision : null;
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
