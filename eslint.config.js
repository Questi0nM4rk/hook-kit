// biome-ignore-all lint/style/noDefaultExport: ESLint flat-config files MUST export the config as the module default — that's the format ESLint v9+ resolves.
// hook-kit ESLint flat config — layered ON TOP of biome (S2). Biome covers most lint surface
// (style, complexity, correctness, security, performance, suspicious — see biome.jsonc). ESLint
// covers what biome can't: type-aware rules like no-floating-promises / no-misused-promises that
// require a TypeScript program. S3a is preset scaffolding; S3b will add rule-specific overrides.
//
// CP-1 (lessons L-CP-1): every rule MUST end up error-severity or off-with-reason. The two
// non-error severities (the W-word and I-word) are forbidden. typescript-eslint v8's
// strict-type-checked and stylistic-type-checked presets are 100% error-severity out of the
// box (verified by grep against node_modules/@typescript-eslint/eslint-plugin/dist/configs/);
// no per-rule severity overrides needed for CP-1 compliance. The lint script also passes
// `--max-warnings=0` as belt-and-braces (T11) so any rule that ever defaults to soft-severity
// fails CI immediately.

import tseslint from "typescript-eslint";

export default tseslint.config(
  // Global ignores. node_modules/dist are obvious. docs/ and examples/ excluded because
  // examples ship their own configs (per CLAUDE.md "examples/ai-guardrails has its own builds")
  // and docs/ is markdown handled by markdownlint (S1b).
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "docs/**",
      "examples/**",
      ".claude/**",
      "**/*.d.ts", // generated declaration files; type-aware lint of declarations adds nothing.
    ],
  },

  // typescript-eslint preset chain (strict + stylistic, both type-aware). spreading is the
  // documented pattern from typescript-eslint.io for flat config + tseslint.config helper.
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // Project-wide language options for type-aware rules.
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "tests-isolated/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // projectService=true is the modern (typescript-eslint 8.x) replacement for project=true.
        // Auto-discovers the nearest tsconfig.json per file; faster + handles multi-tsconfig setups
        // without per-glob config. Falls back via the typescript-eslint default project lookup.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Formatting rules biome owns — explicitly NOT enabling here even though the presets above
      // don't enable them either; documenting the boundary so future "add ESLint rule X" PRs
      // remember to check biome.jsonc first. The two tools must NEVER fight over formatting.
      //   biome owns: indent, quotes, semi, comma-dangle, line-width, trailing-commas, etc.
      //   ESLint owns: type-aware logic (no-floating-promises, no-misused-promises, etc.)
      //
      // `no-unused-vars` overlap: typescript-eslint preset already disables ESLint's core
      // `no-unused-vars` and enables `@typescript-eslint/no-unused-vars` (type-aware variant
      // that handles unused destructured fields + type-only imports correctly). Biome's
      // `noUnusedVariables` is broadly equivalent but non-type-aware; we keep both because the
      // type-aware ESLint variant catches a strict superset and the redundant biome catches
      // any drift if ESLint mis-parses a file. Both at error = first one to flag fails CI.
    },
  },
);
