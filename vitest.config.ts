import os from "node:os";
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
    // Several suites write snapshots through the filesystem store and delete
    // its root afterwards. Keep that away from a developer's real local
    // snapshots under .kontourai/.
    env: { CAMPFIT_SNAPSHOT_STORE_ROOT: path.join(os.tmpdir(), "campfit-test-snapshots") },
  },
  resolve: {
    alias: {
      // Matches tsconfig.json's "@/*": ["./*"] so test files can import
      // repo modules the same way the rest of the codebase does.
      "@": rootDir,
    },
  },
});
