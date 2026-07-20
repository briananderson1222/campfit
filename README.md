# CampFit

CampFit is a Denver-focused platform that helps parents discover, compare,
save, and get notified about kids' summer and school-break camps. It's a
freemium Next.js app: free browsing/search/save, with a paid tier
(Stripe-billed) unlocking unlimited saves, richer notifications, and calendar
export. Camp data is ingested from public camp-provider sites via an
LLM-driven extraction pipeline and reviewed by an admin before it reaches the
public directory. The canonical production domain is **https://camp.fit**.

## Tech stack

- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **Styling**: Tailwind CSS v4
- **Database**: PostgreSQL, accessed with the raw [`pg`](https://www.npmjs.com/package/pg) driver — **not Prisma**. The `prisma/` directory only holds hand-written SQL migration files; schema changes are applied with [`node-pg-migrate`](https://www.npmjs.com/package/node-pg-migrate) (see `npm run db:migrate*` below and `docs/local-dev.md`).
- **Auth**: Supabase Auth (Google OAuth + email)
- **Payments**: Stripe (checkout, portal, webhooks)
- **Email**: Resend
- **Ingestion**: an LLM-driven, schema-directed extraction pipeline built on [`@kontourai/traverse`](https://www.npmjs.com/package/@kontourai/traverse) — there are no per-site CSS-selector scrapers. See `docs/traverse-ingestion.md`.
- **Testing**: Vitest (unit/integration) and Playwright (browser/E2E)
- **Hosting**: Vercel

## Getting started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env.local` and fill in the values you need. Not
   every variable is required for every workflow — see the comments in
   `.env.example` and the tiered setup below.

3. Follow `docs/local-dev.md` for local database setup. It's split into two
   tiers:
   - **Tier 1 — database-only development**: a local `postgres:16` container
     (via `docker compose`), no Supabase dependency. Covers ingestion, data
     scripts, and DB-backed Vitest suites.
   - **Tier 2 — full admin UI and authentication**: adds Supabase Auth for
     the authenticated admin browser flows. Not needed for data-layer work.

   `docs/local-dev.md` is the source of truth for exact commands, resets, and
   seeding — start there before running any DB or Docker command yourself.

## Key npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm run dev` | `next dev` | Start the local dev server |
| `npm run build` | `next build` | Production build |
| `npm test` | `vitest run` | Run the Vitest unit/integration suite |
| `npm run db:migrate` | `node-pg-migrate up ...` | Apply pending Postgres migrations (raw SQL in `prisma/migrations`) |
| `npm run lint` | typecheck + content-boundary/decision checks + ingestion test suites + `eslint` | Full local verification suite — mirrors most of CI's `validate` job |
| `npm run scrape` | `tsx scripts/scrape.ts` | Run the traverse ingestion pipeline (the same script CI runs weekly) |

See `package.json` for the full list — there are many more targeted
`test:*`, `verify:*`, and `db:*` scripts for specific subsystems.

## Architecture

Start with **`CONTEXT-MAP.md`**, which indexes the bounded contexts and how
they relate:

- [Camp Discovery](./docs/contexts/camp-discovery/CONTEXT.md) — the
  parent-facing directory, saves, calendars, and comparison.
- [Data Stewardship](./docs/contexts/data-stewardship/CONTEXT.md) — admin
  work for keeping camp/provider data current, reviewed, and actionable.
- [Trust & Review Provenance](./docs/contexts/trust-review-provenance/CONTEXT.md)
  — review decisions, provenance, evidence, and trust-export language.

The `docs/` directory also holds ADRs (`docs/adr/`), content decisions
(`docs/decisions/`), and design/cutover writeups for specific subsystems.

## Data ingestion

CampFit's camp data comes from a **traverse-based LLM ingestion pipeline** —
schema-directed extraction against a shared per-item schema, not per-site
CSS selectors. Every extraction is a provenance-bearing proposal that goes
through human review before it's applied. The current, primary pipeline is
documented in **`docs/traverse-ingestion.md`**; `docs/traverse-pilot.md`
describes an earlier pilot state and is marked superseded — don't use it as
a guide to the current architecture.

## CI & deploy

- **CI** (`.github/workflows/ci.yml`): on every push/PR, runs content-boundary
  and decision-registry checks, a TypeScript compile check, and traverse
  replay/crawl proofs; when the required secrets are present it also runs a
  production `next build`, the Survey review proof, and admin-platform
  verification (`verify:admin`), plus a Postgres-backed Vitest job.
- **Deploy** (`.github/workflows/deploy.yml`): on push to `main`, builds and
  deploys the production build to Vercel.
- **Scrape** (`.github/workflows/scrape.yml`): runs the traverse ingestion
  pipeline weekly (Mondays 6am UTC) and triggers a Vercel revalidation.

See `SETUP_CHECKLIST.md` for the manual one-time setup (OAuth, Stripe,
Resend, GitHub Actions secrets, etc.).

## Docs map

- **This README** — orientation for newcomers.
- **`PLAN.md`** — the original founding/design document. It's historical:
  useful for the product rationale and data-model thinking behind the
  original build, but several implementation details it describes (ORM
  choice, Next.js version, some phase status) are out of date. For current
  architecture, use this README, `CONTEXT-MAP.md`, and `docs/`.
- **`docs/local-dev.md`** — local environment setup (start here for anything
  DB/Docker-related).
- **`docs/traverse-ingestion.md`** — the current ingestion pipeline.
- **`docs/contexts/*/CONTEXT.md`** — per-context architecture and language.
- **`docs/adr/`**, **`docs/decisions/`** — architecture and content decision
  records.
