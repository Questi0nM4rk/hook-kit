# Security Policy

## Supported versions

`@questi0nm4rk/hook-kit` is pre-1.0. Security fixes land on the latest
published minor; older `0.x` lines are not back-patched. Pin to a range you
can move forward (`^0.x`) so a fix reaches you on the next install.

| Version | Supported |
|---------|-----------|
| latest `0.x` | yes |
| older `0.x` | no — upgrade to the latest minor |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub Security Advisories:

1. Go to the [Security tab](https://github.com/Questi0nM4rk/hook-kit/security/advisories) of the repository.
2. Click **Report a vulnerability** to open a private advisory draft.

Please include:

- the affected version(s) and platform,
- a minimal reproduction (a rule definition + the command/event that triggers it, where applicable),
- the impact you observed (e.g. a deny that should have fired but didn't, an
  unexpected exec, a path/redirect bypass),
- any suggested remediation.

You will get an acknowledgement within a few days. Once a fix is ready, a
patched release is published and the advisory is disclosed with credit to the
reporter unless you ask to remain anonymous.

## Scope and threat model

hook-kit is a **defense-in-depth** layer, not a sandbox. Iron Law 4 is
fail-open: a bug in the framework must not block a user, so the engine returns
silent (`null`) on its own internal errors rather than denying. The single
fail-closed exception is an `ask` decision whose escalation infrastructure is
configured but broken.

Because of this, **security-critical denials should also exist in the
harness's own deny list** — hook-kit raises the cost of a mistake, it does not
replace a hard sandbox boundary. The classes of report most relevant here:

- a rule that should match a command/redirect/pipe but is silently bypassed
  (e.g. a wrapper, alias, or inline-shell form the AST traversal misses),
- an escalation path that resolves to `allow` when no responder actually
  decided,
- a typed-error path that swallows a failure instead of surfacing it as an
  `error` annotation or stderr line (a zero-silent-fails violation).

Shell-parsing fidelity issues (a command form that parses wrong) usually
belong upstream in [`@questi0nm4rk/shell-ast`](https://github.com/Questi0nM4rk/shell-ast);
report them there if the root cause is parsing rather than hook-kit's rule
evaluation. When in doubt, report here and we will route it.
