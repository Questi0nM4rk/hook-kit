// Single source of truth for the package version. Read from package.json at
// import time so a release only needs `npm version <bump>` + republish — no
// hand-edits scattered across CLI/wrapper sources.
//
// Bun (and tsc with resolveJsonModule) inline the JSON at compile time, so
// the compiled bytecode binary carries the correct version literal.

import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
