Feature: hook-kit run() pipeline through the raw adapter

  The run() function reads a HookEvent via the adapter, evaluates it
  against the configured modules, and writes the resulting decision
  back through the adapter. This feature exercises the end-to-end
  shape that compiled binaries use in production.

  Scenario: a Bash hook denies a forbidden command
    Given a hook module that denies "git push --force" with reason "no force pushes"
    When the runner processes a Bash event with command "git push --force"
    Then the captured decision is a deny with reason "no force pushes"

  Scenario: a Bash hook allows non-matching commands
    Given a hook module that denies "git push --force" with reason "no force"
    When the runner processes a Bash event with command "git pull"
    Then the captured decision is silent

  Scenario: a Write hook protects generated files
    Given a hook module that denies writes to ".g.cs" with reason "edit the generator"
    When the runner processes a Write event with file "/tmp/x.g.cs"
    Then the captured decision is a deny with reason "edit the generator"

  Scenario: a Bash event whose command is not parseable does not block
    Given a hook module that denies "rm" with reason "blocked"
    When the runner processes a Bash event with command "if; then"
    Then the captured decision is silent
