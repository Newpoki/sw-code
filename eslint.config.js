//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"
import reactPlugin from "eslint-plugin-react"

export default [
  ...tanstackConfig,
  {
    // Upstream `retMsg` values contain HTML fragments (e.g. `<br/>`) and must render
    // as literal text (Requirement 6.2). Banning `dangerouslySetInnerHTML` is the
    // enforcement mechanism for that, and the injection defence at the same time.
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: { react: reactPlugin },
    rules: {
      "react/no-danger": "error",
    },
  },
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    /*
     * Build output is not source. Flat config does not read `.gitignore`, so
     * these have to be named here even though they are ignored by git: the
     * Nitro/Vercel target emits `.output/`, the node-server target emits
     * `dist/`, and linting either one fails with a parser error, because the
     * emitted `.js` files are not part of any tsconfig project.
     */
    ignores: [
      "eslint.config.js",
      ".prettierrc",
      ".output/**",
      "dist/**",
      "dist-ssr/**",
      ".tanstack/**",
    ],
  },
]
