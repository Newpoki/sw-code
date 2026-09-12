import { defineConfig } from "vitest/config"
import viteReact from "@vitejs/plugin-react"

/**
 * Test runner configuration for shared-coupon-redemption.
 *
 * The `@/*` alias resolves exactly the way the application resolves it: through
 * the tsconfig `paths` entry, enabled with Vite's native `resolve.tsconfigPaths`
 * option, which is the same option `vite.config.ts` uses. The TanStack Start
 * plugin is deliberately left out of the test pipeline — tests import modules
 * directly rather than going through the dev server or the route generator.
 *
 * Two projects split the environments:
 *   - `node`  runs `*.test.ts`  — domain, server, store, and integration tests
 *   - `jsdom` runs `*.test.tsx` — component tests (@testing-library/react)
 *
 * Both projects cover `tests/unit`, `tests/property`, and `tests/integration`,
 * so the file extension alone decides which environment a test runs in.
 */
const config = defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // Property tests run at numRuns >= 100, so the 5s default is too tight.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/{unit,property,integration}/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [viteReact()],
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["tests/{unit,property,integration}/**/*.test.tsx"],
          setupFiles: ["./tests/setup/dom.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/routeTree.gen.ts", "src/components/ui/**"],
    },
  },
})

export default config
