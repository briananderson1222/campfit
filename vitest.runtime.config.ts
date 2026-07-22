import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Network-, credential-, and database-free runtime composition tests. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/resolve-extraction-provider.test.ts"],
  },
  resolve: { alias: { "@": rootDir } },
});
