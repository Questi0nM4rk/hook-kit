import { describe, expect, test } from "bun:test";
import { protectPath } from "../../src/builders/protect-path.js";
import { type SecurityOptions, STRICT_DENY } from "../../src/core/security.js";
import type { EvaluationOutcome, Rule } from "../../src/core/types.js";
import { runModule } from "../../src/engine/index.js";
import { moduleWith } from "../_helpers.js";

// SA-06 (#20): protectPath gates shell-side file access to protected paths —
// the half path() can't reach under the shell wrapper. Two channels: shell
// redirects (read/write ops) and a curated file-command table over u.args
// (cp/mv/install last=write, tee/rm all=write, cat all=read, dd if=/of=).
// Dynamic targets ($OUT, $DST) escalate per uncertaintyDecision (terminal
// rules only). Pattern is required; mode defaults to "write".

const ETC = /^\/etc\//;

function run(command: string, rule: Rule, security?: SecurityOptions): Promise<EvaluationOutcome> {
  return runModule({
    module: moduleWith([rule]),
    command,
    ...(security === undefined ? {} : { security }),
  });
}

describe("protectPath — redirects", () => {
  test("denies a write redirect into a protected path", async () => {
    const o = await run("echo x > /etc/passwd", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("ignores a write redirect outside the pattern", async () => {
    const o = await run("echo x > /tmp/ok", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal).toBeNull();
  });

  test("write mode ignores a read redirect", async () => {
    const o = await run("cat < /etc/shadow", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal).toBeNull();
  });

  test("read mode denies a read redirect from a protected path", async () => {
    const o = await run("cat < /etc/shadow", protectPath(ETC, { mode: "read" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("both mode catches read and write redirects", async () => {
    const r = await run("cat < /etc/shadow", protectPath(ETC, { mode: "both" }).deny("no"));
    const w = await run("echo x > /etc/p", protectPath(ETC, { mode: "both" }).deny("no"));
    expect(r.terminal?.kind).toBe("deny");
    expect(w.terminal?.kind).toBe("deny");
  });

  test("mode defaults to write", async () => {
    const o = await run("echo x > /etc/passwd", protectPath(ETC).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });
});

describe("protectPath — command table", () => {
  test("denies cp into a protected path (last arg = write)", async () => {
    const o = await run("cp foo /etc/passwd", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("cp source (read) ignored under write mode", async () => {
    const o = await run("cp /etc/secret /tmp/x", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal).toBeNull();
  });

  test("read mode denies cp FROM a protected path (source = read)", async () => {
    const o = await run("cp /etc/secret /tmp/x", protectPath(ETC, { mode: "read" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("denies tee into a protected path (all args = write)", async () => {
    const o = await run("tee /etc/hosts", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("read mode denies cat of a protected path", async () => {
    const o = await run("cat /etc/shadow", protectPath(ETC, { mode: "read" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("denies dd of= into a protected path", async () => {
    const o = await run(
      "dd if=/dev/zero of=/etc/x",
      protectPath(ETC, { mode: "write" }).deny("no"),
    );
    expect(o.terminal?.kind).toBe("deny");
  });

  test("denies rm of a protected path (destructive = write)", async () => {
    const o = await run("rm /etc/passwd", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("fires through a sudo wrapper (basename match)", async () => {
    const o = await run("sudo cp foo /etc/passwd", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("deny");
  });

  test("ignores an unlisted command (tail escalates only on dynamics)", async () => {
    const o = await run("frobnicate /etc/passwd", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal).toBeNull();
  });
});

describe("protectPath — dynamic targets escalate", () => {
  test("dynamic write-redirect target escalates to ask (default)", async () => {
    const o = await run("echo x > $OUT", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("dynamic cp dest escalates to ask", async () => {
    const o = await run("cp foo $DST", protectPath(ETC, { mode: "write" }).deny("no"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("dynamic target denies under STRICT_DENY", async () => {
    const o = await run("cp foo $DST", protectPath(ETC, { mode: "write" }).deny("no"), STRICT_DENY);
    expect(o.terminal?.kind).toBe("deny");
  });

  test("annotation rule stays silent on a dynamic target", async () => {
    const o = await run("cp foo $DST", protectPath(ETC, { mode: "write" }).warning("heads up"));
    expect(o.terminal).toBeNull();
    expect(o.annotations).toHaveLength(0);
  });

  test("a resolved match still fires for an annotation rule", async () => {
    const o = await run(
      "cp foo /etc/passwd",
      protectPath(ETC, { mode: "write" }).warning("heads up"),
    );
    expect(o.annotations.some((a) => a.kind === "warning")).toBe(true);
  });
});

describe("protectPath — chainable verbs", () => {
  test("ask() surfaces a resolved match as an ask", async () => {
    const o = await run("echo x > /etc/passwd", protectPath(ETC, { mode: "write" }).ask("review"));
    expect(o.terminal?.kind).toBe("ask");
  });

  test("note() annotates a resolved match", async () => {
    const o = await run("cp foo /etc/passwd", protectPath(ETC, { mode: "write" }).note("fyi"));
    expect(o.annotations.some((a) => a.kind === "note")).toBe(true);
  });
});
