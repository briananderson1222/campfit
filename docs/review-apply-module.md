# Review Apply module

This is CampFit's durable architecture note for extracting the Camp-Proposal
apply path out of `app/api/admin/review/[id]/approve/route.ts` and into a
deep, HTTP-independent module: `lib/admin/review-apply.ts`. It uses the
domain vocabulary defined in
[`docs/contexts/data-stewardship/CONTEXT.md`](./contexts/data-stewardship/CONTEXT.md)
(**Proposal**, **Review**, **Review Decision**, **Review Apply**, **Proposed
Value**, **Current Value**) throughout. Full delivery history — design
decisions, wave-by-wave execution notes, and the two findings called out
below — lives in
[`.kontourai/flow-agents/review-apply-module/`](../.kontourai/flow-agents/review-apply-module/)
(`review-apply-module--deliver.md` is the session record;
`review-apply-module--deliver-plan.md` is the plan).

## Why

Before this slice, `app/api/admin/review/[id]/approve/route.ts` was a
344-line HTTP handler containing ~230 lines of inline transaction/SQL logic:
loading the Survey review session, deriving the Review Decision, running the
apply transaction (scalar `UPDATE`s, relation replace-all for
`ageGroups`/`schedules`/`pricing`, `fieldSources` patching, verification
re-evaluation), and writing provenance. None of that was reachable or
testable without going through Next.js's route-handler runtime, and a
"proves it works" check for it was a brittle regex scan of the route's
*source text* (see below). The route also still accepted a legacy
client-submitted apply path that Survey review sessions had already made
redundant.

## Module interface

`lib/admin/review-apply.ts` exports:

```ts
applyProposalReview(opts: {
  proposalId: string;
  reviewSessionId: string;
  reviewer: string;
  notes?: string;
  feedbackTags?: string[];
  keepPending?: boolean;         // true = partial Review Apply
}): Promise<AppliedReview>
```

`AppliedReview` is `{ proposalId, campId, status: 'APPROVED' | 'PENDING',
appliedFields, rejectedFields, kept, provenanceErrors }`. Typed errors, all
thrown (matching the throw-based convention already used by adjacent
survey-apply modules rather than adopting `@kontourai/survey`'s
discriminated `{ ok }` result unions — CampFit's apply-transaction *outcome*
is a domain-specific mutation result with no existing `@kontourai/survey`/
`@kontourai/surface` export that fits):

| Error | Route mapping |
| --- | --- |
| `ReviewApplyProposalNotFoundError` | 404 |
| `ReviewApplySessionNotFoundError` | 404 |
| `SurveyReviewSessionStaleError` (re-exported from `survey-review-sessions.ts`) | 409 |
| `ReviewApplyConflictError` (Proposal no longer PENDING) | 409 |
| `SurveyReviewApplyError` (re-exported from `survey-review-apply.ts`) | 400 |
| anything else | 500 (unchanged catch-all, e.g. a `buildCampReviewTrustInput` validation throw) |

The module has no dependency on `next/server` or anything HTTP-specific — it
is a plain Node/`pg` module, directly importable and callable from a vitest
test (or any other caller) without a Next.js runtime.
`app/api/admin/review/[id]/approve/route.ts` is now a thin HTTP adapter:
auth → parse `{ reviewSessionId, reviewerNotes?, feedbackTags?, keepPending?
}` → one call to `applyProposalReview` → map the result/typed errors above to
an HTTP response. It contains zero `client.query`/`pool.query` calls and zero
inline SQL.

`buildCampReviewTrustInput` (from `@kontourai/surface`/`@kontourai/survey`
via `lib/admin/trust-projection.ts`) stays exactly where the route called it
before — inside the transaction, before the writes, as a validation-only
side effect whose result is intentionally discarded (see Accepted gaps
below).

## The double-apply race fix, and why the status transition had to move inside the transaction

The Review Apply transaction now does, immediately after `BEGIN` and before
any write:

```sql
SELECT status FROM "CampChangeProposal" WHERE id = $1 FOR UPDATE
```

and throws `ReviewApplyConflictError` if the row's status is no longer
`PENDING`. On its own, this row lock does **not** close the double-apply
race: before this slice, `updateProposalStatus`/`partialApprove` ran as
separate, un-transactioned `pool.query()` calls *after* `COMMIT`. Two
concurrent full-approve requests could both pass the `FOR UPDATE` re-check
while status was still `PENDING`, because the first request hadn't yet
reached its post-commit status-flip call — the lock would buy nothing, since
the thing it needs to serialize against (the status flip) hadn't happened
yet and wasn't covered by the same transaction anyway.

So this slice also gave `updateProposalStatus` and `partialApprove`
(`lib/admin/review-repository.ts`) an optional trailing `client?: PoolClient`
parameter (mirroring the existing optional-client pattern in
`survey-review-sessions.ts`'s `findSurveyReviewSession`), and
`applyProposalReview` calls them with the apply transaction's own client,
**before `COMMIT`**. Now a second concurrent Review Apply's `FOR UPDATE`
re-check cannot observe `PENDING` once the first has written its Review
Decision, because both the row lock and the status flip live inside the same
transaction. This also fixes a latent pre-existing inconsistency: previously,
if the post-commit status-transition call threw, the field writes were
already committed but the Proposal's status never flipped (the route
returned 500 with Camp data already mutated but the Proposal still showing
PENDING/unreviewed). Folding the status transition into the transaction
makes the whole Review Apply atomic.

Provenance writes (`writeChangeLogs`, `recordReviewDecision`) still happen
**after** `COMMIT`, unchanged in position — they are non-fatal by design
(the Review Apply itself has already committed by the time they run). A
failure there is no longer only `console.error`-ed: it is also collected
into `AppliedReview.provenanceErrors` so a caller can see it instead of it
being silently swallowed.

**Fix-pass hardening (fast-fail + keepPending idempotency).** A code review
noted that dropping the early "already reviewed" check changed a rare edge
case's HTTP status from 409 to 400: a stale/foreign `reviewSessionId`
submitted for an already-resolved Proposal could reach a survey-derivation
error before the `FOR UPDATE` re-check ever ran. `applyProposalReview` now
throws `ReviewApplyConflictError` immediately after loading the Proposal, if
its status isn't `PENDING` — before any session/derivation work — restoring
the old fast-fail. The `FOR UPDATE` re-check remains the authoritative guard
against a race between this snapshot and the transaction; the fast-fail is
purely a cheaper, more specific short-circuit for the non-racing case.

Separately, a security review found the row lock didn't cover `keepPending`
(partial Review Apply): two concurrent partial applies for the same field
both pass the `FOR UPDATE` re-check (a partial apply leaves status
`PENDING`), so both could write the same Camp fields and duplicate
`CampChangeLog`/metric rows. `applyProposalReview` now re-reads the locked
row's `"appliedFields"` immediately after acquiring the lock and re-filters
the derived approved fields against it before doing any write — whichever
concurrent apply acquires the lock second sees the fields the first already
committed and treats them as no-ops (no duplicate Camp writes, changelogs,
or metrics), completing cleanly with an empty `appliedFields` for those
fields instead of re-applying them.

**Fix-pass hardening (provenance-skip discriminator, F13-corrected).** The
under-lock re-filter above means a `keepPending` call's own post-transaction
provenance write (`writeChangeLogs`/`recordReviewDecision`) needs to be
skipped for the genuine duplicate-retry no-op case above (concurrent
requests where a whole non-empty derived approved-field set got emptied by
the re-filter) — otherwise that call would re-report the same
`rejectedFields` metrics a prior/concurrent call already recorded. An
earlier version of this skip gated purely on `appliedFields.length === 0`
under `keepPending`, which also (incorrectly) suppressed provenance for a
*legitimate* round that never had anything to approve in the first place —
a reviewer resolving a batch of items as reject/keep-current, approving
nothing new but rejecting a real, previously-undecided field, silently lost
that field's `field_rejected` metric with no signal in `provenanceErrors`.
The corrected discriminator captures the derived approved-field count
*before* the under-lock re-filter runs and only skips provenance when
`keepPending && derivedApprovedCount > 0 && appliedFields.length === 0` —
i.e. the re-filter emptied a set that was non-empty going in. A round whose
derived approved set was empty from the start records provenance exactly as
a full apply would, including its `rejectedFields` metrics.

**Accepted residual.** This discriminator only protects the fully-emptied-
by-the-lock case. Two *concurrent* `keepPending` calls that both
legitimately derive zero approved fields and an identical non-empty
`rejectedFields` set (both resolving the same items as rejected/
keep-current) both pass the check as non-duplicates — there is nothing for
the lock to filter, so neither call's `appliedFields` gets forced to empty —
so both record provenance, and `rejectedFields` metrics can be
double-recorded for that vanishingly rare race. There is no
rejection-tracking column mirroring `"appliedFields"` to de-duplicate
against; this is audit-only (no Camp/Proposal state corruption) and accepted
rather than fixed here.

## Legacy-path deletion

The client-submitted apply path (`approvedFields`, `overrides`,
`applyFromSurvey`) is gone from the route's request type/destructuring and
from `app/admin/review/[id]/review-panel.tsx`'s `callApprove` fetch body,
which now sends only `{ reviewerNotes, keepPending, reviewSessionId }`. The
Actions-sidebar "Apply source" radio toggle (`useSurveyApply` state + its
two-radio block) is deleted from the panel, along with the per-field
checkbox list and "Select all"/"Deselect all" controls that only mattered
for the legacy path — the fields list itself is kept as a read-only
proposed-vs-current display, since it is still useful for a reviewer to see
what a Proposal contains. This is safe because
`getOrCreateSurveyReviewSessionForProposal` already runs unconditionally for
every Proposal in `app/admin/review/[id]/page.tsx`, so a Survey review
session always exists by the time a reviewer reaches the panel — Survey
review is the only Review Decision producer left. (A *separate*, unrelated
"Apply source" chip label inside the Survey Review Workbench header —
`data-testid="real-proposal-survey-workbench"` — is untouched; do not
confuse the two.)

## Test-DB approach

`npm run test` (vitest) exercises `applyProposalReview` directly against a
real, throwaway `postgres:16` instance — never a mock of `pg` — because the
required test cases (relation replace-all, the `FOR UPDATE` lock, real
concurrent commits) are only provable against real SQL semantics.

**Schema provisioning.** `prisma/schema.prisma` is *not* a complete schema —
see Accepted gaps below — so `scripts/test-db-reset.ts` (`npm run
test:db:reset`) provisions the throwaway database by running the
hand-written SQL files directly, in this exact order (empirically verified
during planning against a throwaway container; the one `NOTICE: relation
"CampChangeLog" already exists, skipping` from step 9 is expected — it
confirms the ordering matches how these files were historically applied to
the real Supabase instance):

1. `prisma/migrations/001_initial_schema.sql`
2. `scripts/sql/admin-schema.sql`
3. `prisma/migrations/002_provider_and_field_sources.sql`
4. `prisma/migrations/003_camp_reports.sql`
5. `prisma/migrations/004_array_types_and_address.sql`
6. `prisma/migrations/005_admin_trust_platform.sql`
7. `prisma/migrations/006_provider_change_proposals.sql`
8. `prisma/migrations/007_moderator_roles.sql`
9. `prisma/migrations/008_provider_person_change_logs.sql`
10. `prisma/migrations/009_survey_review_events.sql`
11. `prisma/migrations/010_survey_review_sessions.sql`
12. `prisma/migrations/011_proposal_applied_fields.sql`

**Isolation.** `tests/integration/global-setup.ts` runs once per `vitest run`
invocation, reads `TEST_DATABASE_URL` (throws loudly if unset — it never
falls back to `DATABASE_URL`/`PGHOST`, so it can never touch the shared
Supabase instance), and — before any test file imports `@/lib/db` — sets
`process.env.DATABASE_URL = process.env.TEST_DATABASE_URL` and deletes
`PGHOST`/`PGUSER`/`PGPASSWORD`/`PGPORT`/`PGDATABASE` if present, so
`resolvePgConfig()` (`lib/db-config.ts`) falls through to `DATABASE_URL`
instead of a developer's local `.env.local` pointing at the real instance.
No production file is modified to support this beyond the `sslmode=disable`
support described next.

**Per-test isolation** is `TRUNCATE`, not rollback-per-test: the existing
`verify-admin-platform.ts` pattern (`BEGIN` → inserts → `ROLLBACK` on one
client) does not work here, because the concurrent-double-apply test needs
two separate connections making real, independently-committed writes so the
second connection's `SELECT ... FOR UPDATE` can observe the first
connection's committed status change, and the provenance-after-commit test
needs a real `COMMIT` to have happened before it can prove the apply's
writes survive a later non-fatal failure. So each test seeds its own rows in
`beforeEach` and `afterEach` runs `TRUNCATE "Camp" RESTART IDENTITY CASCADE;`
(cascading through the FK-linked tables) plus `TRUNCATE "CrawlMetric";`
(not FK-cascaded from `Camp`).

**Local developer workflow:**

```sh
docker run -d --name campfit-test-db -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=campfit_test -p 5433:5432 --tmpfs /var/lib/postgresql/data postgres:16
export TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/campfit_test?sslmode=disable"
npm run test:db:reset
npm run test
```

**The `sslmode=disable` deviation.** The plan's original assumption was that
no `lib/db.ts`/`lib/db-config.ts` change would be needed — isolation would be
purely the env-var remap above. Execution found that `lib/db.ts` hardcodes
`ssl: { rejectUnauthorized: false }` unconditionally, so the pool could not
connect to a throwaway Postgres at all (plain Postgres has no SSL listener;
the connection fails with "The server does not support SSL connections").
This was a real blocker, not a preference, so the resolution (approved as an
in-scope production change, not a silent workaround) was: `lib/db-config.ts`
parses `sslmode=disable` out of a `postgres://` connection string's query
string into `{ ssl: false }`, and `lib/db.ts` honors it
(`ssl: config.ssl === false ? false : { rejectUnauthorized: false }`).

**Fix-pass hardening (loopback-only).** A security review flagged that the
original implementation honored `sslmode=disable` for *any* host in the
connection string — an operator who accidentally carried the flag into a real
`DATABASE_URL` (e.g. copy-pasting a local `.env` snippet) would silently
downgrade a connection to the real Supabase instance to plaintext. `lib/db-
config.ts` now only honors `sslmode=disable` (case-insensitively) when the
parsed host is loopback (`localhost`, `127.0.0.1`, or unbracketed `::1`); it
logs `console.warn('[db] SSL disabled for loopback connection to <host>')`
when applied. Note: the bracketed IPv6 form `[::1]` (as it appears in a
`postgres://user:pass@[::1]:5432/db` connection string) does not match this
check — the brackets are never stripped before comparison — so it falls
through to the non-loopback branch and stays SSL-required (fail-safe, not a
downgrade); use `127.0.0.1` or `localhost` for a local loopback setup instead.
For any non-loopback host, the flag is ignored — SSL-required
behavior is kept — and a `console.warn` says the flag was ignored. Every
connection string *without* `sslmode=disable` at all — i.e. every real
environment including the production Supabase instance — behaves exactly as
before either way. `TEST_DATABASE_URL` gained `?sslmode=disable` against a
loopback host (`127.0.0.1`/`localhost`) in both the local workflow above and
`.github/workflows/ci.yml`'s new `review_apply_unit_tests` job (a
`postgres:16` service container, gated `needs: validate`, running `npm run
test:db:reset && npm run test`, additive alongside the existing
`validate`/`build`/`survey_review_proof`/`verify_admin` jobs) — no change was
needed there since it already used `localhost`.

## Accepted gaps

- **`prisma/schema.prisma` is incomplete.** It has no `CampChangeProposal`,
  `CrawlRun`, `CrawlMetric`, `ProviderChangeProposal`, or
  `CommunityModeratorAssignment` models — confirmed via `grep -n "^model "
  prisma/schema.prisma` — even though the Review Apply path writes to
  several of these. The real schema source of truth is the ordered SQL file
  set above. **Do not run `npx prisma db push`** for local dev or test
  provisioning: it would produce a database missing tables this module
  depends on. This is a pre-existing gap this slice works around, not one it
  fixes.
- **Schema drift: resolved via tracked migration 011.** `lib/admin/review-
  repository.ts`'s `partialApprove` (pre-existing code, not touched by this
  slice) reads and writes `"CampChangeProposal"."appliedFields"`/`"priority"`,
  but until the fix pass no file under `prisma/migrations/*.sql` or
  `scripts/sql/admin-schema.sql` created them — this was very likely drift
  between the real Supabase instance (where the columns presumably existed
  out-of-band) and the committed migration history. This is now tracked as
  `prisma/migrations/011_proposal_applied_fields.sql`: an idempotent `ALTER
  TABLE "CampChangeProposal" ADD COLUMN IF NOT EXISTS "appliedFields" TEXT[]
  NOT NULL DEFAULT '{}', ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL
  DEFAULT 0`, wired into `scripts/test-db-reset.ts`'s ordered schema-file list
  (step 12) so the throwaway test database now gets these columns from the
  tracked migration, not an ad-hoc `ALTER TABLE` inside the test file.
  **Ops note: apply migration 011 to production.** It is a no-op if the
  columns already exist there (confirming the drift theory) and additive
  (safe to run) if they don't.
- **`partialApprove`'s empty-merge `array_agg` fix.** `lib/admin/review-
  repository.ts`'s `partialApprove` merges new applied fields into the row's
  existing `"appliedFields"` via `SELECT array_agg(DISTINCT f ORDER BY f)
  FROM unnest(...)`. When both the row's existing `"appliedFields"` and the
  newly-approved set are empty — the very first `keepPending` call on a
  proposal that approves nothing this round — `unnest()` over an empty array
  produces zero rows, and Postgres's `array_agg` over zero rows is `NULL`,
  not `'{}'`, which violated the `NOT NULL` constraint migration 011 added
  and rolled back the whole apply transaction (uncaught 500), before
  `applyProposalReview` ever reached the provenance-skip logic above. The
  query now wraps the `array_agg` in `COALESCE(..., '{}')`, so an empty merge
  writes an empty-but-valid array instead of crashing. No signature change.
- **`buildCampReviewTrustInput`'s result is still intentionally discarded.**
  The call is relocated unchanged from the route into the module's
  transaction, still running purely as a validation side effect (a throw
  here still rolls back the transaction and surfaces as an unmapped 500,
  matching pre-existing behavior). Wiring its result into an actual trust/
  verification-authority pipeline is explicitly deferred to a follow-up
  Verification-authority slice — not fixed here.

## Note: a pre-existing production bug fixed as a side effect

While wiring `buildCampReviewTrustInput`'s `proposalCreatedAt` input through
the module, testing surfaced that `getProposal()`
(`lib/admin/review-repository.ts`) returns `createdAt` as a JS `Date` object
from `node-postgres`, not the `string` the `CampChangeProposal` type declares.
That mismatch was previously invisible because every caller either
JSON-serialized the proposal (transparently coercing `Date` → ISO string) or
re-wrapped it in `new Date(...)`. It becomes visible once
`applyProposalReview` forwards `proposal.createdAt` unchanged into
`buildCampReviewTrustInput`, whose `@kontourai/surface` validation requires a
real string and throws `"Missing required string field: createdAt"`
otherwise — meaning **every real Review Apply likely 500'd before this fix**,
regardless of this slice's other changes. `getProposal()` now normalizes
`createdAt` to an ISO string when it comes back as a `Date`, mirroring the
same idiom already used by `survey-review-sessions.ts`'s `toIsoString`.

**Fix-pass follow-up.** A code review flagged that this was a narrow,
single-field patch: `getProposal()`'s query also selects `reviewedAt`,
`crawlStartedAt`, and `crawlCompletedAt` — all TIMESTAMPTZ columns subject to
the exact same `node-postgres` Date-parsing behavior, left un-normalized.
`getProposal()` now normalizes all four fields the same way (a small
`toIsoString`/`toIsoStringOrNull` pair local to the file), so the same
failure class can't resurface for a sibling field the moment a future caller
forwards one of them into a similarly strict validator.
