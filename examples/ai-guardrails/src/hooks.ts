// Faithful port of ai-guardrails (https://github.com/.../ai-guardrails) using
// @questi0nm4rk/hook-kit. One compiled binary covers what AG's check engine
// did via 4 separate hooks (dangerous-cmd, protect-configs, protect-reads,
// suppress-comments) plus its custom call/pipe/redirect/recurse logic.
//
// Build:   hook-kit build src/hooks.ts --out dist/hooks --adapter claude-code
// Wire it: ${CLAUDE_PLUGIN_ROOT}/dist/hooks in your hooks.json

import { cmd, createModule, path, pipe, redirect } from "@questi0nm4rk/hook-kit";
import { suppressCommentsRule } from "./suppress-comments.js";

// ─── Command rules — one module per AG rule group ──────────────────────────

const destructiveRm = createModule(
  { id: "destructive-rm", name: "Destructive rm", events: ["PreToolUse"], matchers: ["Bash"] },
  [
    cmd("rm")
      .withFlag("--recursive")
      .withFlag("--force")
      .escalate("rm with --recursive and --force flags", "[destructive-rm]"),
  ],
);

const gitForcePush = createModule(
  { id: "git-force-push", name: "Git force push", events: ["PreToolUse"], matchers: ["Bash"] },
  [
    cmd("git", "push")
      .withFlag("--force")
      .withoutFlag("--force-with-lease")
      .escalate("git push --force (use --force-with-lease)", "[git-force-push]"),
  ],
);

const gitDestructive = createModule(
  {
    id: "git-destructive",
    name: "Git destructive operations",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [
    cmd("git", "reset").withFlag("--hard").escalate("git reset --hard", "[git-destructive]"),
    cmd("git", "checkout")
      .withDdash()
      .escalate("git checkout -- (discard working tree)", "[git-destructive]"),
    cmd("git", "restore")
      .withDdash()
      .escalate("git restore -- (discard working tree)", "[git-destructive]"),
    cmd("git", "clean").withFlag("--force").escalate("git clean --force", "[git-destructive]"),
    cmd("git", "branch")
      .withFlag("--delete")
      .withFlag("--force")
      .escalate("git branch -D (force delete)", "[git-destructive]"),
  ],
);

const gitBypassHooks = createModule(
  { id: "git-bypass-hooks", name: "Git bypass hooks", events: ["PreToolUse"], matchers: ["Bash"] },
  [
    cmd("git", "commit")
      .withFlag("--no-verify")
      .escalate("git commit --no-verify (bypasses hooks)", "[git-bypass-hooks]"),
    // -n is NOT aliased globally (means --dry-run for git push, --no-checkout for git clone).
    cmd("git", "commit")
      .withFlag("-n")
      .escalate("git commit -n (bypasses hooks)", "[git-bypass-hooks]"),
  ],
);

const chmodWorldWritable = createModule(
  {
    id: "chmod-world-writable",
    name: "Chmod world-writable",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [
    cmd("chmod")
      .withFlag("--recursive")
      .argIncludes("777")
      .escalate("chmod -R 777 (world-writable recursive)", "[chmod-world-writable]"),
    cmd("chmod")
      .withFlag("--recursive")
      .argIncludes("a+rwx")
      .escalate("chmod -R a+rwx (world-writable recursive)", "[chmod-world-writable]"),
  ],
);

const PIPE_SHELLS = ["bash", "sh", "dash", "zsh", "ksh", "csh", "tcsh", "fish"];
const PIPE_FETCHERS = ["curl", "wget"];

const remoteCodeExec = createModule(
  {
    id: "remote-code-exec",
    name: "Remote code execution",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [
    pipe(PIPE_FETCHERS, PIPE_SHELLS).escalate(
      "curl/wget piped into a shell (RCE risk)",
      "[remote-code-exec]",
    ),
  ],
);

// ─── Path rules — Edit/Write/NotebookEdit + Read protection ────────────────

const protectConfigs = createModule(
  {
    id: "protect-configs",
    name: "Protect config files from writes",
    events: ["PreToolUse"],
    matchers: ["Edit", "Write", "NotebookEdit"],
  },
  [
    path(/\.(env|env\.\w+)$/).onWrite().escalate("writing to .env (secrets)", "[protect-configs]"),
    path(/biome\.jsonc?$/).onWrite().escalate("writing to biome config", "[protect-configs]"),
    path(/\.claude\/settings(\.local)?\.json$/)
      .onWrite()
      .escalate("writing to Claude settings", "[protect-configs]"),
    path(/\.(github|gitlab)\/(workflows|ci)\//)
      .onWrite()
      .escalate("writing to CI pipeline config", "[protect-configs]"),
    path(/package\.json$/).onWrite().escalate("writing to package.json", "[protect-configs]"),
    path(/Cargo\.toml$/).onWrite().escalate("writing to Cargo.toml", "[protect-configs]"),
    path(/pyproject\.toml$/).onWrite().escalate("writing to pyproject.toml", "[protect-configs]"),
    path(/tsconfig(\.\w+)?\.json$/)
      .onWrite()
      .escalate("writing to tsconfig", "[protect-configs]"),
    path(/(?:^|\/)\.gitignore$/)
      .onWrite()
      .escalate("writing to .gitignore", "[protect-configs]"),
    path(/(?:^|\/)lefthook\.yml$/)
      .onWrite()
      .escalate("writing to lefthook config", "[protect-configs]"),
  ],
);

const protectReads = createModule(
  {
    id: "protect-reads",
    name: "Protect secrets from reads",
    events: ["PreToolUse"],
    matchers: ["Read"],
  },
  [
    path(/\.(env|env\.\w+)$/).onRead().escalate("reading .env (secrets)", "[protect-reads]"),
    path(/\/\.ssh\//).onRead().escalate("reading SSH directory", "[protect-reads]"),
    path(/\/\.gnupg\//).onRead().escalate("reading GPG directory", "[protect-reads]"),
  ],
);

// ─── Bash redirect protection — closes the `cmd > /protected` bypass ──────

const protectFromRedirects = createModule(
  {
    id: "protect-from-redirects",
    name: "Block shell redirects to protected paths",
    events: ["PreToolUse"],
    matchers: ["Bash"],
  },
  [
    redirect(/\.(env|env\.\w+)$/).escalate("redirect into .env", "[protect-from-redirects]"),
    redirect(/\.claude\/settings(\.local)?\.json$/).escalate(
      "redirect into Claude settings",
      "[protect-from-redirects]",
    ),
    redirect(/(?:^|\/)\.gitignore$/).escalate(
      "redirect into .gitignore",
      "[protect-from-redirects]",
    ),
  ],
);

// ─── Suppress-comments — content() rule fires PostToolUse on edited files ──

const suppressComments = createModule(
  {
    id: "suppress-comments",
    name: "Block linter-suppression comments without justification",
    events: ["PostToolUse"],
    matchers: ["Edit", "Write", "NotebookEdit"],
  },
  [suppressCommentsRule()],
);

export default [
  destructiveRm,
  gitForcePush,
  gitDestructive,
  gitBypassHooks,
  chmodWorldWritable,
  remoteCodeExec,
  protectConfigs,
  protectReads,
  protectFromRedirects,
  suppressComments,
];
