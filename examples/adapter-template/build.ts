#!/usr/bin/env bun
// Compile the template into a single-file binary.
//
// We invoke `bun build --compile --bytecode` directly here (instead of
// `hook-kit build`) because the hook-kit CLI only knows the canonical
// `shell` and `cc-tools` adapter modes — a custom adapter is by definition
// not in that table. Downstream consumers shipping a custom adapter follow
// the same shape: a `main.ts` that wires `createMyAdapter` + `run()`, and a
// build invocation that compiles `main.ts` directly.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "src", "main.ts");
const outFile = resolve(here, "dist", "hk-template");

const proc = Bun.spawn(["bun", "build", entry, "--compile", "--bytecode", "--outfile", outFile], {
  cwd: here,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) {
  process.stderr.write(`build failed (exit ${String(code)})\n`);
  process.exit(code);
}
process.stdout.write(`built ${outFile}\n`);
