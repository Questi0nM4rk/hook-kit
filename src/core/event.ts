import type { HookEvent, ToolEvent } from "./types.js";

export function toToolEvent(event: HookEvent): ToolEvent {
  switch (event.toolName) {
    case "Bash":
      return { type: "bash", command: str(event.toolInput, "command") };
    case "Write":
      return {
        type: "write",
        path: str(event.toolInput, "file_path"),
        content: strOpt(event.toolInput, "content"),
      };
    case "Edit":
      return {
        type: "edit",
        path: str(event.toolInput, "file_path"),
        oldStr: strOpt(event.toolInput, "old_string"),
        newStr: strOpt(event.toolInput, "new_string"),
      };
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
