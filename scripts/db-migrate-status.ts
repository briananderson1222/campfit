import { Client } from "pg";
import { discoverMigrations, MIGRATIONS_TABLE } from "./db-migrations.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required.");
  return url;
}

async function main() {
  const migrations = await discoverMigrations();
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    const table = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('public.pgmigrations')::text AS exists"
    );
    const applied = new Set<string>();
    if (table.rows[0]?.exists) {
      const result = await client.query<{ name: string }>(
        `SELECT name FROM public.${MIGRATIONS_TABLE} ORDER BY run_on, id`
      );
      for (const row of result.rows) applied.add(row.name);
    }

    for (const name of migrations) {
      console.log(`${applied.has(name) ? "applied" : "pending"}\t${name}`);
    }
    const missing = [...applied].filter((name) => !migrations.includes(name));
    for (const name of missing) console.error(`missing\t${name}`);
    console.log(
      `Total: ${migrations.length}; applied: ${applied.size - missing.length}; pending: ${migrations.filter((name) => !applied.has(name)).length}`
    );
    if (missing.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
