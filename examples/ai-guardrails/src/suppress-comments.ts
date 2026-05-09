// suppress-comments — port of ai-guardrails' suppression-pattern detector.
// Scans edited files for linter-disable comments (# noqa, // @ts-ignore,
// #[allow(...)], // nolint, etc.) and escalates so the user can review.
//
// Inline `... ai-guardrails-allow: <rule> "<reason>"` markers on the same
// line silence specific findings (escape hatch for justified suppressions).

import { custom } from "@questi0nm4rk/hook-kit";
import { extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Decision, Rule } from "@questi0nm4rk/hook-kit";

const SUPPRESSION_PATTERNS: Record<string, RegExp[]> = {
  python: [/# noqa/, /# type:\s*ignore/, /# pragma:\s*no cover/, /# pylint:\s*disable/],
  typescript: [
    /\/\/\s*@ts-ignore/,
    /\/\/\s*@ts-nocheck/,
    /eslint-disable/, // ai-guardrails-allow: suppress-comments/eslint-disable "pattern definition"
    /\/\*\s*tslint:disable/,
  ],
  rust: [/#\[allow\(/, /#!\[allow\(/],
  go: [/\/\/nolint/, /\/\/\s*nolint/],
  csharp: [/#pragma warning disable/, /\[SuppressMessage/],
  lua: [/--\s*luacheck:\s*ignore/, /--\s*luacheck:\s*disable/],
  shell: [/# shellcheck disable/],
  cpp: [/\/\/ NOLINT/, /#pragma diagnostic ignored/],
};

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".rs": "rust",
  ".go": "go",
  ".cs": "csharp",
  ".lua": "lua",
  ".sh": "shell",
  ".bash": "shell",
  ".c": "cpp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
};

// Inline justification markers — same line as the suppression silences it.
//   # noqa  // ai-guardrails-allow: noqa "false positive on dynamic import"
const ALLOW_PATTERN = /(?:#|\/\/|--)[ \t]*ai-guardrails-allow:[ \t]*[\w/-]+[ \t]+"[^"]+"/;

function detectLang(filePath: string): string | undefined {
  return EXT_TO_LANG[extname(filePath).toLowerCase()];
}

function findSuppressions(body: string, lang: string): Array<{ line: number; pattern: string }> {
  const patterns = SUPPRESSION_PATTERNS[lang];
  if (!patterns) return [];
  const lines = body.split("\n");
  const findings: Array<{ line: number; pattern: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (ALLOW_PATTERN.test(line)) continue; // justified — skip
    for (const pat of patterns) {
      if (pat.test(line)) {
        findings.push({ line: i + 1, pattern: pat.source });
        break;
      }
    }
  }
  return findings;
}

/** Custom rule: PostToolUse, reads file from disk, escalates if any
 *  unjustified suppression-style comment was added. */
export function suppressCommentsRule(): Rule {
  return custom("suppress-comments", async (event): Promise<Decision> => {
    if (event.eventName !== "PostToolUse") return null;
    const rawPath = event.toolInput.file_path ?? event.toolInput.notebook_path;
    if (typeof rawPath !== "string" || rawPath === "") return null;
    const lang = detectLang(rawPath);
    if (lang === undefined) return null;
    if (!existsSync(rawPath)) return null;
    let body: string;
    try {
      body = readFileSync(rawPath, "utf8");
    } catch {
      return null;
    }
    const findings = findSuppressions(body, lang);
    if (findings.length === 0) return null;
    const summary = findings
      .slice(0, 5)
      .map((f) => `  L${f.line}: ${f.pattern}`)
      .join("\n");
    const more = findings.length > 5 ? `\n  …and ${findings.length - 5} more` : "";
    return {
      kind: "escalate",
      reason: `unjustified linter suppression(s) added to ${rawPath}:\n${summary}${more}\n\nIf intentional, add an inline justification:\n  # ai-guardrails-allow: <rule> "<reason>"`,
      label: "[suppress-comments]",
    };
  });
}
