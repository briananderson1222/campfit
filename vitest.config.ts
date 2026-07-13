import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/unit/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // Every integration file shares the one throwaway Postgres and truncates
    // "Camp" between tests (e.g. review-apply.test.ts, verified-coverage-metric.test.ts).
    // Running files in parallel workers would let one file's TRUNCATE/seed clobber
    // another's rows mid-run, so integration files must execute serially.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // Matches tsconfig.json's "@/*": ["./*"] so test files can import
      // repo modules the same way the rest of the codebase does.
      "@": rootDir,
    },
  },
});
