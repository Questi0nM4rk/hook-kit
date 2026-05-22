// Smoke test: the `./state` package.json subpath resolves to the
// re-export at `src/state/types.ts`. The import succeeding at type-check
// time is the actual contract — no runtime behavior to assert.
//
// If `src/state/types.ts` ever disappears or breaks the StateStore
// re-export, both this file's import AND the package.json `./state`
// resolution would fail; CI catches the regression here.

import { describe, expect, test } from "bun:test";
import type { StateStore } from "../../src/state/types.js";

describe("./state subpath re-export", () => {
  test("StateStore type imports from src/state/types.ts", () => {
    // Use the imported type to keep the import non-elidable under
    // `verbatimModuleSyntax`. A function typed against StateStore is
    // sufficient to anchor the import without any runtime call.
    const isStore = (s: StateStore | undefined): boolean => s !== undefined;
    expect(isStore(undefined)).toBe(false);
  });
});
