import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_TABLE = "pgmigrations";
export const MIGRATIONS_SCHEMA = "public";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(
  scriptsDirectory,
  "../prisma/migrations"
);

function numericPrefix(name: string): number {
  const prefix = name.split("_", 1)[0];
  return /^\d+$/.test(prefix) ? Number(prefix) : 0;
}

export async function discoverMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".sql")
    )
    .map((entry) => entry.name.slice(0, -".sql".length))
    .sort(
      (left, right) =>
        numericPrefix(left) - numericPrefix(right) ||
        left.localeCompare(right, undefined, {
          numeric: true,
          sensitivity: "variant",
          ignorePunctuation: true,
        })
    );
}
