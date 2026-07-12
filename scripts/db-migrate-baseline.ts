import { runner } from "node-pg-migrate";
import {
  discoverMigrations,
  MIGRATIONS_DIR,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from "./db-migrations.js";

function usage(): never {
  throw new Error(
    "Usage: npm run db:migrate:baseline -- --confirm (--all | <migration> ...)"
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const args = process.argv.slice(2);
  if (!args.includes("--confirm")) {
    throw new Error(
      "Refusing to baseline without --confirm. Verify the selected migrations' schema effects first."
    );
  }
  const requested = args.filter((arg) => arg !== "--confirm");
  if (!requested.length || (requested.includes("--all") && requested.length > 1)) {
    usage();
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error("Duplicate migration names are not allowed.");
  }

  const available = await discoverMigrations();
  const selected = requested[0] === "--all" ? available : requested;
  const unknown = selected.filter((name) => !available.includes(name));
  if (unknown.length) throw new Error(`Unknown migration(s): ${unknown.join(", ")}`);

  console.log("FAKE baseline only; migration SQL will not run:");
  for (const name of selected) console.log(`  ${name}`);

  for (const file of selected) {
    await runner({
      databaseUrl,
      dir: MIGRATIONS_DIR,
      migrationsTable: MIGRATIONS_TABLE,
      migrationsSchema: MIGRATIONS_SCHEMA,
      schema: MIGRATIONS_SCHEMA,
      direction: "up",
      checkOrder: false,
      fake: true,
      file,
      verbose: false,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
