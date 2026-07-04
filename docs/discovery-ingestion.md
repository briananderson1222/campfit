# Provider discovery — Denver-metro candidate queue (I22 / #52)

Status: **NEW** intake step. Discovery finds *new providers* for the Denver
metro and lands them as candidates in a human review queue. It is the
ingestion-side complement to the traverse crawl pipeline
([`docs/traverse-ingestion.md`](./traverse-ingestion.md)): traverse extracts
camp *fields* for providers that already exist; discovery finds the providers in
the first place. A discovered provider, once a human approves the candidate,
becomes a real `Provider` row that the crawl pipeline then picks up (the
"feeds #50 / I20" edge).

Scope is **Denver metro only** — a hard boundary. New metros and auto-onboarding
without review are explicit non-goals.

## Pipeline

```
lib/ingestion/discovery/sources/*         — a DiscoverySource yields raw candidates + provenance
        │
        ▼
lib/ingestion/discovery/denver-metro.ts   — Denver-metro boundary filter (out-of-metro excluded)
        │
        ▼
lib/ingestion/discovery/dedupe.ts         — classify vs onboarded Providers + queued candidates
        │                                     (exact → skip; near → surface "possible duplicate of X")
        ▼
lib/ingestion/discovery/candidate-repository.ts — enqueueCandidate() into "ProviderCandidate"
        │
        ▼
human review → approveProviderCandidate() — the ONLY path that creates a Provider
```

- **`sources/denver-rec-centers.ts`** — the shipped source: a curated seed of
  Denver-metro rec-center / municipal / school-district program providers
  (`data/discovery/denver-rec-centers.json`). This is the "curated seed query"
  flavor named in the issue's thinnest slice — deterministic and key-free so the
  job is reproducible in CI with no network/model dependency. A live-page source
  (a rec-center program-listing SPA needing fetch+extraction; issue I23)
  implements the same `DiscoverySource` interface and can drive the traverse
  pipeline inside its own `discover()`; nothing downstream changes.
- **`denver-metro.ts`** — a curated allowlist of Denver-Aurora-Lakewood MSA
  municipalities. Boulder County is intentionally excluded (separate MSA).
- **`dedupe.ts`** — normalized name (`&`→`and`, punctuation-stripped) + website
  domain matching. Exact match against an onboarded provider OR an already-queued
  candidate → skipped. High name similarity (Dice ≥ 0.8) to an onboarded provider
  → queued with a `possibleDuplicateOf` pointer for a human to adjudicate (never
  auto-merged).
- **`candidate-repository.ts`** — the `ProviderCandidate` queue. `enqueueCandidate`
  never creates a Provider; `approveProviderCandidate` (transactional, row-locked,
  single-use) is the only path that does.

## Running it

```sh
npm run discover           # run the default source, write candidates to the queue
npm run discover:dry        # classify + report, write nothing
npx tsx scripts/discover.ts --source denver-rec-centers
```

The job reads the `Provider` table + existing queue to dedupe (even in dry-run)
and creates the `ProviderCandidate` table on first run via
`ensureProviderCandidateSchema()` (idempotent) if the additive migration has not
been applied yet.

## Schema / migration

`prisma/migrations/013_provider_candidates.sql` is **additive** — one new
self-contained `ProviderCandidate` table, no foreign keys into existing models.
It is not yet wired into `scripts/test-db-reset.ts`'s `SCHEMA_FILES` (that file
was being modified on a concurrent branch); the CLI and the integration test
provision the table at runtime via the identical `ensureProviderCandidateSchema`
DDL. After merge, append the migration to `SCHEMA_FILES` ordered after 012.

## Tests

- `tests/integration/provider-discovery.test.ts` (vitest, throwaway Postgres) —
  AC1 metro boundary, AC2 dedupe (re-run idempotency, domain match, name match,
  near-duplicate surfacing, intra-run dedupe), AC3 approval gate (no Provider
  without approval; single-use approve; reject), AC4 provenance.
