# Local development

CampFit's data layer runs on vanilla PostgreSQL. The local environment deliberately uses the same `postgres:16` image as CI and does not install or run Supabase, the Supabase CLI, Supabase extensions, or database-side auth emulation.

## Tier 1: database-only development

This tier covers ingestion and data work, including L4 recrawl proof, aggregator discovery, local scripts, and DB-backed Vitest suites.

Start Postgres and initialize the full schema:

```sh
npm run db:local:up
npm run db:local:schema
```

Use the local database for the app or data scripts:

```sh
export LOCAL_DATABASE_URL='postgresql://campfit:campfit_local@127.0.0.1:54329/campfit_local?sslmode=disable'
export DATABASE_URL="$LOCAL_DATABASE_URL"
```

Reset the Compose database and its named volume, then recreate the schema:

```sh
npm run db:local:reset
```

Seeding is optional because it loads the repository CSV fixtures. Enable it explicitly:

```sh
SEED_LOCAL_DB=1 npm run db:local:reset
```

Stop the container without deleting its volume:

```sh
npm run db:local:down
```

### DB-backed tests

Vitest's integration global setup destructively drops and recreates the `public` schema at `TEST_DATABASE_URL`. It never falls back to `DATABASE_URL` or the `PG*` variables. Point it only at disposable local data:

```sh
export TEST_DATABASE_URL="$LOCAL_DATABASE_URL"
npm test -- tests/integration/aggregator-source-schema.test.ts
```

Running a DB-backed test against `campfit_local` erases any seed data in that database. Run `SEED_LOCAL_DB=1 npm run db:local:reset` afterward if you need it restored.

## Tier 2: full admin UI and authentication

The complete admin browser flow still needs Supabase Auth, or a future compatible auth shim. Reproducing authentication is outside this DB-only environment. Data-layer jobs and tests that do not enter authenticated UI flows do not need Supabase credentials.

## Migration note

Application database access is raw `pg`, configured by `DATABASE_URL` or the existing `PG*` variables. The only Supabase coupling is authentication behind `lib/supabase/*`; there is no Supabase storage, RLS, or extension dependency in this local database. Running CampFit's schema, ingestion, discovery, and DB-backed tests on plain Postgres demonstrates that the data layer remains portable to another managed PostgreSQL provider.

The local Compose configuration intentionally contains no Supabase URLs or keys and requires no Supabase CLI.
