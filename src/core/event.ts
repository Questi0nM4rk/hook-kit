import type { HookEvent, ToolEvent } from "./types.js";

/** Narrow a raw `HookEvent` into a discriminated `ToolEvent` so consumers can
 *  pattern-match on the tool kind without re-deriving the toolName→toolInput
 *  mapping every time.
 *  @stable @since 1.0.0 */
export function toToolEvent(event: HookEvent): ToolEvent {
  switch (event.toolName) {
    case "Bash":
      return { type: "bash", command: str(event.toolInput, "command") };
    case "Write": {
      const path = str(event.toolInput, "file_path");
      const content = strOpt(event.toolInput, "content");
      return content === undefined ? { type: "write", path } : { type: "write", path, content };
    }
    case "Edit": {
      const path = str(event.toolInput, "file_path");
      const oldStr = strOpt(event.toolInput, "old_string");
      const newStr = strOpt(event.toolInput, "new_string");
      const base = { type: "edit" as const, path };
      if (oldStr !== undefined && newStr !== undefined) {
        return { ...base, oldStr, newStr };
      }
      if (oldStr !== undefined) {
        return { ...base, oldStr };
      }
      if (newStr !== undefined) {
        return { ...base, newStr };
      }
      return base;
    }
    case "Read":
      return { type: "read", path: str(event.toolInput, "file_path") };
    default:
      return { type: "other", toolName: event.toolName, toolInput: event.toolInput };
  }
}

function str(obj: Readonly<Record<string, unknown>>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function strOpt(obj: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
