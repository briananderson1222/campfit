/**
 * tests/integration/review-apply.test.ts — AC5 integration suite for
 * `lib/admin/review-apply.ts`'s `applyProposalReview`, against a real
 * throwaway Postgres (never mocked `pg`) so the SQL itself (relation
 * replace-all, `SELECT ... FOR UPDATE`, real concurrent commits) is proven,
 * not just the TypeScript control flow. Supersedes
 * `tests/integration/_infra-smoke.test.ts` (deleted alongside this file).
 *
 * Seeding strategy: each test builds its own Camp + CampChangeProposal via
 * direct SQL (the "Current Value" / "Proposal" CONTEXT.md vocabulary), then
 * builds its Survey review session/events through the *real* production
 * helpers (`getOrCreateSurveyReviewSessionForProposal`,
 * `buildReviewSessionEvents`, `replaceSurveyReviewEvents`) rather than
 * hand-rolling `SurveyReviewSession`/`SurveyReviewEvent` row shapes — this
 * guarantees the seeded rows are exactly what the real review workbench
 * would have persisted. `applyProposalReview` is called directly (no HTTP
 * layer). `afterEach` truncates per the Test DB Provisioning Plan.
 *
 * F1 defense-in-depth: every seed/truncate/assert query in this file goes
 * through `./test-db`'s `getTestPool()` — a pool built directly from
 * `TEST_DATABASE_URL`, independent of `global-setup.ts`'s env remap — and
 * `beforeAll` awaits `assertTestDatabase()` first, which throws loudly if the
 * sentinel table `resetTestDatabase()` writes is missing. See
 * `tests/integration/test-db.ts` for the full rationale. `applyProposalReview`
 * itself (the module under test) is unaffected: it keeps using `@/lib/db`'s
 * shared pool exactly as it does in production, via `global-setup.ts`'s
 * env-var remap.
 *
 * Previously-discovered schema gap (not part of this module): the
 * `"appliedFields"`/`"priority"` columns on `"CampChangeProposal"` that
 * `lib/admin/review-repository.ts`'s `partialApprove` (pre-existing code,
 * not touched by this task) reads/writes are now tracked by
 * `prisma/migrations/011_proposal_applied_fields.sql` (an idempotent `ADD
 * COLUMN IF NOT EXISTS`), wired into `scripts/test-db-reset.ts`'s schema-file
 * order — no ad-hoc `ALTER TABLE` in this file anymore.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildReviewSessionEvents } from "@kontourai/survey/review-workbench";
import type { ReviewQueueSessionState } from "@kontourai/survey/review-workbench";

import { getPool as getProductionPool } from "@/lib/db";
import {
  applyProposalReview,
  ReviewApplyConflictError,
  SurveyReviewSessionStaleError,
} from "@/lib/admin/review-apply";
import { getProposal } from "@/lib/admin/review-repository";
import {
  getOrCreateSurveyReviewSessionForProposal,
  type SurveyReviewSessionRecord,
} from "@/lib/admin/survey-review-sessions";
import { replaceSurveyReviewEvents } from "@/lib/admin/survey-review-events";
import type { CampChangeProposal, FieldDiff, ProposedChanges } from "@/lib/admin/types";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

const REVIEWER = "reviewer@campfit.test";

type SurveyDecision = "accept-proposed" | "keep-current" | "reject-proposed";

function fieldDiff(old: unknown, next: unknown, overrides: Partial<FieldDiff> = {}): FieldDiff {
  return {
    old,
    new: next,
    confidence: 0.9,
    excerpt: "Verbatim excerpt from the source page.",
    sourceUrl: "https://example.test/camp",
    mode: "update",
    ...overrides,
  };
}

async function insertCamp(
  pool: Pool,
  overrides: {
    description?: string;
    contactPhone?: string | null;
    websiteUrl?: string;
  } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description, "contactPhone", "websiteUrl")
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', $3, $4, $5)
     RETURNING id`,
    [
      `test-camp-${randomUUID()}`,
      "Test Camp",
      overrides.description ?? "",
      overrides.contactPhone ?? null,
      overrides.websiteUrl ?? "",
    ],
  );
  return result.rows[0]!.id;
}

async function insertProposal(
  pool: Pool,
  opts: {
    campId: string;
    proposedChanges: ProposedChanges;
    status?: "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED";
    crawlRunId?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "CampChangeProposal" ("campId", "crawlRunId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel", status)
     VALUES ($1, $2, 'https://example.test/camp', $3::jsonb, 0.9, 'test-extraction-model', $4)
     RETURNING id`,
    [opts.campId, opts.crawlRunId ?? null, JSON.stringify(opts.proposedChanges), opts.status ?? "PENDING"],
  );
  return result.rows[0]!.id;
}

/** Seed a Camp + CampChangeProposal, then load a real Survey review session for it. */
async function seedReview(opts: {
  proposedChanges: ProposedChanges;
  campOverrides?: Parameters<typeof insertCamp>[1];
  proposalStatus?: "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED";
}): Promise<{
  campId: string;
  proposalId: string;
  proposal: CampChangeProposal;
  session: SurveyReviewSessionRecord;
}> {
  const pool = getTestPool();
  const campId = await insertCamp(pool, opts.campOverrides);
  const proposalId = await insertProposal(pool, {
    campId,
    proposedChanges: opts.proposedChanges,
    status: opts.proposalStatus,
  });
  const proposal = await getProposal(proposalId);
  if (!proposal) throw new Error("seedReview: proposal not found immediately after insert");
  const session = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: REVIEWER });
  return { campId, proposalId, proposal, session };
}

/** Build decision events for the given `{ field: decision }` map and persist them as the real review workbench would. */
async function decide(
  session: SurveyReviewSessionRecord,
  decisionsByField: Record<string, SurveyDecision>,
  opts: { proposal?: CampChangeProposal } = {},
): Promise<void> {
  const decisionsByItemName: Record<string, SurveyDecision> = {};
  for (const item of session.snapshot.items) {
    const decision = decisionsByField[item.spec.target];
    if (decision) decisionsByItemName[item.metadata.name] = decision;
  }
  const events = buildReviewSessionEvents({
    ...(session.snapshot as ReviewQueueSessionState),
    decisionsByItemName,
  });
  await replaceSurveyReviewEvents({
    proposalId: session.proposalId,
    reviewSessionId: session.id,
    proposal: opts.proposal,
    events,
    actorEmail: REVIEWER,
  });
}

async function queryCamp(pool: Pool, campId: string) {
  const result = await pool.query(
    `SELECT description, "contactPhone", "fieldSources" FROM "Camp" WHERE id = $1`,
    [campId],
  );
  return result.rows[0] as { description: string; contactPhone: string | null; fieldSources: Record<string, unknown> | null } | undefined;
}

async function queryProposal(pool: Pool, proposalId: string) {
  const result = await pool.query(
    `SELECT status, "appliedFields", priority FROM "CampChangeProposal" WHERE id = $1`,
    [proposalId],
  );
  return result.rows[0] as { status: string; appliedFields: string[] | null; priority: number } | undefined;
}

beforeAll(async () => {
  // F1 layer (b): refuse to run any seed/truncate query below until the
  // sentinel table confirms TEST_DATABASE_URL points at a database that was
  // actually provisioned by resetTestDatabase(). See tests/integration/
  // test-db.ts and the file-header note above.
  await assertTestDatabase();
});

afterEach(async () => {
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "CrawlMetric";`);
});

afterAll(async () => {
  await closeTestPool();
  // Also end the production-pool singleton the module under test
  // (applyProposalReview et al.) built via @/lib/db's env-remapped
  // TEST_DATABASE_URL, so the test process can exit cleanly.
  await getProductionPool().end();
});

describe("applyProposalReview", () => {
  it("case 1: full apply resolves APPROVED, applies fields, and patches fieldSources", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "", contactPhone: null },
      proposedChanges: {
        description: fieldDiff("", "A vibrant outdoor summer day camp.", { mode: "populate" }),
        contactPhone: fieldDiff(null, "303-555-0142", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed", contactPhone: "accept-proposed" });

    const result = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: false,
    });

    expect(result.status).toBe("APPROVED");
    expect(result.kept).toBe(false);
    expect(result.appliedFields.slice().sort()).toEqual(["contactPhone", "description"]);
    expect(result.rejectedFields).toEqual([]);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe("APPROVED");

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.description).toBe("A vibrant outdoor summer day camp.");
    expect(campRow?.contactPhone).toBe("303-555-0142");
    expect(campRow?.fieldSources).toMatchObject({
      description: { sourceUrl: "https://example.test/camp" },
      contactPhone: { sourceUrl: "https://example.test/camp" },
    });
  });

  it("case 2: keepPending applies fields, keeps proposal PENDING at priority -1, and merges appliedFields", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "", contactPhone: null },
      proposedChanges: {
        description: fieldDiff("", "Outdoor day camp for ages 7-12.", { mode: "populate" }),
        contactPhone: fieldDiff(null, "303-555-0199", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed" });

    const firstResult = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: true,
    });

    expect(firstResult.status).toBe("PENDING");
    expect(firstResult.kept).toBe(true);
    expect(firstResult.appliedFields).toEqual(["description"]);

    const afterFirst = await queryProposal(pool, proposalId);
    expect(afterFirst?.status).toBe("PENDING");
    expect(afterFirst?.priority).toBe(-1);
    expect(afterFirst?.appliedFields).toEqual(["description"]);

    const campAfterFirst = await queryCamp(pool, campId);
    expect(campAfterFirst?.description).toBe("Outdoor day camp for ages 7-12.");

    // Second partial approval against the same proposal / same review
    // session (still fresh — proposedChanges didn't change, only
    // appliedFields/priority metadata did) must merge into the prior
    // partial-approval fields rather than overwrite them.
    const proposalAfterFirst = await getProposal(proposalId);
    expect(proposalAfterFirst).not.toBeNull();
    await decide(session, { contactPhone: "accept-proposed" }, { proposal: proposalAfterFirst! });

    const secondResult = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: true,
    });

    expect(secondResult.status).toBe("PENDING");
    expect(secondResult.kept).toBe(true);
    expect(secondResult.appliedFields).toEqual(["contactPhone"]);

    const afterSecond = await queryProposal(pool, proposalId);
    expect(afterSecond?.status).toBe("PENDING");
    expect(afterSecond?.priority).toBe(-1);
    expect(afterSecond?.appliedFields?.slice().sort()).toEqual(["contactPhone", "description"]);

    const campAfterSecond = await queryCamp(pool, campId);
    expect(campAfterSecond?.contactPhone).toBe("303-555-0199");
  });

  it("case 2b: concurrent keepPending applies for the same field set — the second becomes a no-op for the already-applied field, exactly one CampChangeLog row is written, and exactly one field_rejected metric row is recorded (F10)", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "", contactPhone: null },
      proposedChanges: {
        description: fieldDiff("", "Concurrent keepPending candidate description.", { mode: "populate" }),
        // A contested rejected field alongside the contested approved field
        // above: both requests derive the same rejectedFields (F10 —
        // rejectedFields isn't re-filtered under the lock the way
        // appliedFields is, so this is what proves the second (no-op)
        // request skips provenance recording entirely rather than
        // re-reporting a duplicate `field_rejected` metric row).
        contactPhone: fieldDiff(null, "303-555-0199", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed", contactPhone: "reject-proposed" });

    // Both requests derive the same approvedFields (["description"]) from
    // the same fresh review session. keepPending leaves status PENDING
    // after each commit, so — unlike the full-apply case (case 4b) — both
    // requests pass lockAndCheckProposal's PENDING re-check; the race this
    // proves closed is at the appliedFields re-filter under the lock
    // (F4), not the status check.
    const outcomes = await Promise.allSettled([
      applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: "reviewer-a@campfit.test", keepPending: true }),
      applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: "reviewer-b@campfit.test", keepPending: true }),
    ]);

    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof applyProposalReview>>> => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");

    // Neither request conflicts — both are legitimate keepPending applies;
    // whichever acquires the row lock second just finds nothing new to do.
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(2);
    for (const outcome of fulfilled) {
      expect(outcome.value.status).toBe("PENDING");
      expect(outcome.value.kept).toBe(true);
    }
    // Exactly one of the two applied the field for real; the other's
    // appliedFields is empty (idempotent no-op under the lock).
    const appliedFieldsResults = fulfilled.map((o) => o.value.appliedFields);
    expect(appliedFieldsResults.filter((f) => f.length === 1)).toHaveLength(1);
    expect(appliedFieldsResults.filter((f) => f.length === 0)).toHaveLength(1);

    const afterBoth = await queryProposal(pool, proposalId);
    expect(afterBoth?.status).toBe("PENDING");
    expect(afterBoth?.appliedFields).toEqual(["description"]);

    const campAfterBoth = await queryCamp(pool, campId);
    expect(campAfterBoth?.description).toBe("Concurrent keepPending candidate description.");

    // The core assertion: no duplicate CampChangeLog row for the field —
    // the second (no-op) apply must not have written a second entry.
    const changeLogRows = await pool.query(
      `SELECT id FROM "CampChangeLog" WHERE "campId" = $1 AND "fieldName" = 'description'`,
      [campId],
    );
    expect(changeLogRows.rows).toHaveLength(1);

    // F10: the no-op (appliedFields: []) request must skip provenance
    // recording entirely — including recordReviewDecision — so the
    // contested rejectedFields entry (`contactPhone`, derived identically by
    // both requests from the same fresh review session) is recorded exactly
    // once, not once per request.
    const rejectedMetricRows = await pool.query<{ dimensions: { field: string; proposalId: string } }>(
      `SELECT dimensions FROM "CrawlMetric" WHERE "metricName" = 'field_rejected' AND dimensions->>'field' = 'contactPhone' AND dimensions->>'proposalId' = $1`,
      [proposalId],
    );
    expect(rejectedMetricRows.rows).toHaveLength(1);
  });

  it("case 2c: F13 regression — round 2 keepPending approves nothing but rejects a newly-decided field records that field's rejection provenance (not skipped)", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "", contactPhone: null },
      proposedChanges: {
        description: fieldDiff("", "Round 1 approved description.", { mode: "populate" }),
        contactPhone: fieldDiff(null, "303-555-0111", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed" });

    const firstResult = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: true,
    });

    expect(firstResult.status).toBe("PENDING");
    expect(firstResult.appliedFields).toEqual(["description"]);
    expect(firstResult.provenanceErrors).toEqual([]);

    // Round 2 is a legitimate, non-duplicate round: it approves nothing new
    // (decision.approvedFields is empty *from deriveDecision itself*, not
    // emptied by the under-lock re-filter) and rejects contactPhone, a field
    // never previously decided. Per F13 this must NOT be treated as the
    // duplicate-retry no-op — provenance (including the field_rejected
    // metric for contactPhone) must be recorded.
    const proposalAfterFirst = await getProposal(proposalId);
    expect(proposalAfterFirst).not.toBeNull();
    await decide(session, { contactPhone: "reject-proposed" }, { proposal: proposalAfterFirst! });

    const secondResult = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: true,
    });

    expect(secondResult.status).toBe("PENDING");
    expect(secondResult.kept).toBe(true);
    expect(secondResult.appliedFields).toEqual([]);
    expect(secondResult.rejectedFields).toEqual(["contactPhone"]);
    expect(secondResult.provenanceErrors).toEqual([]);

    const proposalAfterSecond = await queryProposal(pool, proposalId);
    expect(proposalAfterSecond?.status).toBe("PENDING");
    expect(proposalAfterSecond?.appliedFields).toEqual(["description"]);

    const campAfterSecond = await queryCamp(pool, campId);
    expect(campAfterSecond?.contactPhone).toBeNull();

    const rejectedMetricRows = await pool.query<{ dimensions: { field: string; proposalId: string } }>(
      `SELECT dimensions FROM "CrawlMetric" WHERE "metricName" = 'field_rejected' AND dimensions->>'field' = 'contactPhone' AND dimensions->>'proposalId' = $1`,
      [proposalId],
    );
    expect(rejectedMetricRows.rows).toHaveLength(1);
  });

  it("case 2d: F14 regression — the very first keepPending call on a fresh proposal, approving nothing and rejecting one field, does not throw a NOT NULL violation on appliedFields", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "" },
      proposedChanges: {
        description: fieldDiff("", "Some proposed description.", { mode: "populate" }),
      },
    });

    await decide(session, { description: "reject-proposed" });

    // Before F14's fix, this was the very first keepPending call on this
    // proposal (its "appliedFields" column still at its column default,
    // '{}') approving nothing, so partialApprove's array_agg-over-empty-
    // unnest merge produced NULL and violated the NOT NULL constraint added
    // by migration 011 — this call must succeed instead.
    const result = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: true,
    });

    expect(result.status).toBe("PENDING");
    expect(result.kept).toBe(true);
    expect(result.appliedFields).toEqual([]);
    expect(result.rejectedFields).toEqual(["description"]);
    expect(result.provenanceErrors).toEqual([]);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe("PENDING");
    expect(proposalRow?.priority).toBe(-1);
    expect(proposalRow?.appliedFields).toEqual([]);

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.description).toBe("");

    const rejectedMetricRows = await pool.query<{ dimensions: { field: string; proposalId: string } }>(
      `SELECT dimensions FROM "CrawlMetric" WHERE "metricName" = 'field_rejected' AND dimensions->>'field' = 'description' AND dimensions->>'proposalId' = $1`,
      [proposalId],
    );
    expect(rejectedMetricRows.rows).toHaveLength(1);
  });

  it("case 3: a stale survey session rejects with SurveyReviewSessionStaleError and writes nothing", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "" },
      proposedChanges: {
        description: fieldDiff("", "Original proposed description.", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed" });

    // Mutate the proposal's proposedChanges out from under the already-built
    // session snapshot — the next freshness re-derivation
    // (assertSurveyReviewSessionFreshForProposal) will hash a different
    // candidate value and detect staleness.
    await pool.query(
      `UPDATE "CampChangeProposal" SET "proposedChanges" = $1::jsonb WHERE id = $2`,
      [
        JSON.stringify({
          description: fieldDiff("", "A different extracted description.", { mode: "populate" }),
        }),
        proposalId,
      ],
    );

    await expect(
      applyProposalReview({
        proposalId,
        reviewSessionId: session.id,
        reviewer: REVIEWER,
        keepPending: false,
      }),
    ).rejects.toBeInstanceOf(SurveyReviewSessionStaleError);

    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe("PENDING");

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.description).toBe("");
  });

  it("case 4: a non-PENDING proposal rejects with ReviewApplyConflictError", async () => {
    const pool = getTestPool();
    // Seed the proposal as already-resolved (APPROVED) from the start, with
    // a session whose captured proposalStatus matches — this reaches the
    // module's own row-locked PENDING re-check (rather than being rejected
    // earlier as a "stale" session, which is what would happen if the
    // session had been built while status was still PENDING).
    const { proposalId, session } = await seedReview({
      proposedChanges: {
        description: fieldDiff("", "Some proposed description.", { mode: "populate" }),
      },
      proposalStatus: "APPROVED",
    });

    await decide(session, { description: "accept-proposed" });

    await expect(
      applyProposalReview({
        proposalId,
        reviewSessionId: session.id,
        reviewer: REVIEWER,
        keepPending: false,
      }),
    ).rejects.toBeInstanceOf(ReviewApplyConflictError);
  });

  it("case 4b: concurrent double-apply against the same PENDING proposal — exactly one fulfills, one rejects with ReviewApplyConflictError", async () => {
    const { proposalId, session } = await seedReview({
      proposedChanges: {
        description: fieldDiff("", "Concurrent apply candidate description.", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed" });

    const outcomes = await Promise.allSettled([
      applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: "reviewer-a@campfit.test", keepPending: false }),
      applyProposalReview({ proposalId, reviewSessionId: session.id, reviewer: "reviewer-b@campfit.test", keepPending: false }),
    ]);

    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof applyProposalReview>>> => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ReviewApplyConflictError);
    expect(fulfilled[0]!.value.status).toBe("APPROVED");
  });

  it("case 4c: a non-PENDING proposal with a fresh-looking session rejects with ReviewApplyConflictError, not a derivation error", async () => {
    // Seed the proposal as already-resolved (APPROVED) from the start, with
    // a session whose captured proposalStatus matches (so it reads as
    // "fresh" per isSurveyReviewSessionFresh) — but deliberately skip
    // decide(), so no SurveyReviewEvent rows exist for this session. In
    // 'full' mode, deriveCampApplyFromSurveySession requires every item
    // resolved and would throw SurveyReviewApplyError (mapped to 400) for
    // this session on its own. The fast-fail immediately after getProposal
    // must reject with ReviewApplyConflictError before ever reaching that
    // derivation step, proving the 409 wins over the 400 for a proposal
    // that is already resolved.
    const { proposalId, session } = await seedReview({
      proposedChanges: {
        description: fieldDiff("", "Some other proposed description.", { mode: "populate" }),
      },
      proposalStatus: "APPROVED",
    });

    await expect(
      applyProposalReview({
        proposalId,
        reviewSessionId: session.id,
        reviewer: REVIEWER,
        keepPending: false,
      }),
    ).rejects.toBeInstanceOf(ReviewApplyConflictError);
  });

  it("case 5: relation replace-all deletes prior ageGroups/schedules/pricing rows and inserts exactly the new set", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      proposedChanges: {
        ageGroups: fieldDiff(
          [{ label: "Old Age Group", minAge: 5, maxAge: 8, minGrade: null, maxGrade: null }],
          [{ label: "New Age Group", minAge: 6, maxAge: 10, minGrade: null, maxGrade: null }],
        ),
        schedules: fieldDiff(
          [{ label: "Old Schedule", startDate: "2026-06-01", endDate: "2026-06-05", startTime: null, endTime: null, earlyDropOff: null, latePickup: null }],
          [{ label: "New Schedule", startDate: "2026-07-01", endDate: "2026-07-05", startTime: "09:00", endTime: "15:00", earlyDropOff: null, latePickup: null }],
        ),
        pricing: fieldDiff(
          [{ label: "Old Price", amount: 100, unit: "PER_WEEK", durationWeeks: 1, ageQualifier: null, discountNotes: null }],
          [{ label: "New Price", amount: 150, unit: "PER_WEEK", durationWeeks: 1, ageQualifier: null, discountNotes: null }],
        ),
      },
    });

    await pool.query(
      `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge") VALUES (gen_random_uuid()::text, $1, 'Old Age Group', 5, 8)`,
      [campId],
    );
    await pool.query(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate") VALUES (gen_random_uuid()::text, $1, 'Old Schedule', '2026-06-01', '2026-06-05')`,
      [campId],
    );
    await pool.query(
      `INSERT INTO "CampPricing" (id, "campId", label, amount, unit) VALUES (gen_random_uuid()::text, $1, 'Old Price', 100, 'PER_WEEK')`,
      [campId],
    );

    await decide(session, { ageGroups: "accept-proposed", schedules: "accept-proposed", pricing: "accept-proposed" });

    const result = await applyProposalReview({
      proposalId,
      reviewSessionId: session.id,
      reviewer: REVIEWER,
      keepPending: false,
    });

    expect(result.status).toBe("APPROVED");
    expect(result.appliedFields.slice().sort()).toEqual(["ageGroups", "pricing", "schedules"]);

    const ageGroups = await pool.query(`SELECT label, "minAge", "maxAge" FROM "CampAgeGroup" WHERE "campId" = $1`, [campId]);
    expect(ageGroups.rows).toEqual([{ label: "New Age Group", minAge: 6, maxAge: 10 }]);

    const schedules = await pool.query(`SELECT label, "startTime", "endTime" FROM "CampSchedule" WHERE "campId" = $1`, [campId]);
    expect(schedules.rows).toEqual([{ label: "New Schedule", startTime: "09:00", endTime: "15:00" }]);

    const pricing = await pool.query(`SELECT label, amount, unit FROM "CampPricing" WHERE "campId" = $1`, [campId]);
    expect(pricing.rows).toEqual([{ label: "New Price", amount: "150.00", unit: "PER_WEEK" }]);
  });

  it("case 6: a post-commit provenance failure (recordReviewDecision) is tolerated and surfaced, not thrown, and the apply is still committed", async () => {
    const pool = getTestPool();
    const { campId, proposalId, session } = await seedReview({
      campOverrides: { description: "" },
      proposedChanges: {
        description: fieldDiff("", "Description that should still be committed.", { mode: "populate" }),
      },
    });

    await decide(session, { description: "accept-proposed" });

    // Force recordReviewDecision's CrawlMetric insert to fail post-commit,
    // without touching lib/admin/review-apply.ts or metrics-repository.ts:
    // rename the table away for the duration of this call, then restore it.
    await pool.query(`ALTER TABLE "CrawlMetric" RENAME TO "CrawlMetric_disabled_for_case6"`);
    let result: Awaited<ReturnType<typeof applyProposalReview>>;
    try {
      result = await applyProposalReview({
        proposalId,
        reviewSessionId: session.id,
        reviewer: REVIEWER,
        keepPending: false,
      });
    } finally {
      await pool.query(`ALTER TABLE "CrawlMetric_disabled_for_case6" RENAME TO "CrawlMetric"`);
    }

    expect(result.status).toBe("APPROVED");
    expect(result.provenanceErrors).toHaveLength(1);
    expect(result.provenanceErrors[0]!.step).toBe("recordReviewDecision");
    expect(result.provenanceErrors[0]!.message).toBeTruthy();

    // The apply's own writes (Camp fields + proposal status) already
    // committed before the post-commit provenance step ran — re-query to
    // prove they survive the provenance failure.
    const proposalRow = await queryProposal(pool, proposalId);
    expect(proposalRow?.status).toBe("APPROVED");

    const campRow = await queryCamp(pool, campId);
    expect(campRow?.description).toBe("Description that should still be committed.");
  });
});
