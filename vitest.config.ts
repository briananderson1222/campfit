import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
  },
  resolve: {
    alias: {
      // Matches tsconfig.json's "@/*": ["./*"] so test files can import
      // repo modules the same way the rest of the codebase does.
      "@": rootDir,
    },
  },
});
