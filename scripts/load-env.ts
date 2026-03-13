import fs from "node:fs";
import path from "node:path";
import { config } from "dotenv";

const ENV_FILES = [".env.local", ".env"];

export function loadLocalEnv() {
  for (const file of ENV_FILES) {
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    config({ path: fullPath, override: false });
  }
}
