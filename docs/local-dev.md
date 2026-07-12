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

## Migration workflow

CampFit uses `node-pg-migrate` to apply the raw SQL files in
`prisma/migrations` and record them in `public.pgmigrations`. The historical
`001_*.sql` through `020_*.sql` files remain the source of truth; they are not
Prisma migrations. `prisma/migrations/001_z_admin_schema.sql` is a relative
symlink to `scripts/sql/admin-schema.sql`, which places that existing SQL after
001 and before 002 without copying it or maintaining another list.

With `DATABASE_URL` set, use:

```sh
npm run db:migrate          # apply every pending migration
npm run db:migrate:status   # print applied and pending migrations
npm run db:migrate:new -- describe_the_change
npm run db:migrate:down     # revert the most recent reversible migration
```

New migrations are created as timestamp-prefixed SQL files in
`prisma/migrations`. Historical SQL files have no `-- Down Migration` section,
so they are intentionally not reversible with `db:migrate:down`; use a forward
fix or database restore rather than inventing destructive rollback SQL.

The runner may print `Can't determine timestamp` for the historical three-digit
prefixes. Version 8 then uses their numeric value, so the warning is harmless;
the order is 001, admin, 002 through 020.

### Baseline an existing database

Baselining writes history rows without executing migration SQL. First inspect
the target schema and identify only migrations whose effects are already
present. Then pass their basenames (no `.sql`) explicitly:

```sh
export DATABASE_URL='postgresql://...'
npm run db:migrate:baseline -- --confirm 001_initial_schema 003_camp_reports
npm run db:migrate:status
```

Sparse, non-contiguous selections are supported because production history may
contain gaps. Never infer presence from a migration number. The baseline command
rejects unknown or duplicate names and requires `--confirm`. It is idempotent
for names already recorded. Only after an owner reviews the status output
should pending production migrations be applied.

For a database independently verified to contain the complete current schema:

```sh
npm run db:migrate:baseline -- --confirm --all
```

`--all` is not a schema check; it only fakes all discovered migrations into
`pgmigrations`. Both baseline forms require `DATABASE_URL`. The destructive test
reset remains isolated to `TEST_DATABASE_URL` and internally runs the same
migration runner before creating its test sentinel.

## Portability note

Application database access is raw `pg`, configured by `DATABASE_URL` or the existing `PG*` variables. The only Supabase coupling is authentication behind `lib/supabase/*`; there is no Supabase storage, RLS, or extension dependency in this local database. Running CampFit's schema, ingestion, discovery, and DB-backed tests on plain Postgres demonstrates that the data layer remains portable to another managed PostgreSQL provider.

The local Compose configuration intentionally contains no Supabase URLs or keys and requires no Supabase CLI.
