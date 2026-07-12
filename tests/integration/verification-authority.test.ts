/**
 * tests/integration/verification-authority.test.ts — full integration suite
 * for the verification-authority slice (AC2-AC7), against a real throwaway
 * Postgres (never mocked `pg`), following `tests/integration/review-apply.
 * test.ts`'s exact structure (F1 defense-in-depth: `getTestPool()`/
 * `assertTestDatabase()`, `afterEach` truncation via `./test-db`).
 *
 * Wave 1 laid down seed helpers for a Camp + multiple `CampSchedule` rows plus
 * one `it()` smoke case, and an `it.todo(...)` placeholder for every AC2-AC7
 * scenario named in the Definition Of Done (`.kontourai/flow-agents/
 * verification-authority/verification-authority--deliver-plan.md`). Waves
 * 2-4 filled in AC2-AC4/AC6 real assertions as their modules landed
 * (`lib/admin/claim-store.ts`, `lib/admin/session-identity.ts`,
 * `lib/admin/verification-authority.ts`, `scripts/backfill-claim-store.ts`).
 * Wave 5 (this file's current state) replaced the LAST remaining `it.todo`s
 * (AC5's session-claims case, AC7's TrustStatus-mapping table + disputed-
 * session-caps-camp case) with real assertions, and added an explicit
 * backfill→evaluate proof (AC3 describe block) — every scenario named in the
 * Definition Of Done now has a real, non-`it.todo` assertion against a live
 * Postgres. Zero `it.todo` placeholders remain in this file.
 *
 * Dependency note (coordination with the "Migration 012 + test-db-reset
 * wiring" Wave 1 task, which owns `scripts/test-db-reset.ts`): this file's
 * seed helpers only touch `Camp`/`CampSchedule` columns that already exist
 * pre-012 (`id`, `campId`, `label`, `startDate`, `endDate`, `startTime`,
 * `endTime`); `CampSchedule.archivedAt`/`SurfaceClaim*` reads/writes go
 * through the Wave 2/3 modules imported below, never raw SQL here.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildHumanAttestationEvidence,
  deriveClaimStatus,
  validateClaimStore,
  validateTrustBundle,
  type ClaimDefinitionDraft,
  type TrustStatus,
  type VerificationPolicy,
} from "@kontourai/surface";

import { getPool as getProductionPool } from "@/lib/db";
import {
  applyScheduleReconciliation,
  SESSION_SUBJECT_TYPE,
  type ExistingScheduleRow,
  type IncomingScheduleSnapshot,
} from "@/lib/admin/session-identity";
import { addFieldAttestation, recordCampAttestationEvidence } from "@/lib/admin/entity-admin-repository";
import {
  appendEvent,
  appendEvidence,
  createPostgresClaimStoreAdapter,
  loadClaimBundle,
  persistClaim,
  recordEvidence,
  upsertPolicy,
} from "@/lib/admin/claim-store";
import { backfillClaimStore, buildDowngradeImpactReport } from "@/lib/admin/claim-store-backfill";
import { bulkAttestCamp } from "@/lib/admin/bulk-attestation";
import { campCanonicalClaimId } from "@/lib/admin/trust-projection";
import {
  buildInheritedSessionClaims,
  deriveCampVerification,
  deriveSessionVerification,
  refreshCampVerificationCache,
  revokeArchivedSessionClaims,
} from "@/lib/admin/verification-authority";
import {
  INHERITED_SESSION_ATTRIBUTES,
  projectTrustStatusToDataConfidence,
  VERIFIED_CAMP_FIELDS,
  VERIFIED_CAMP_SESSION_POLICIES,
  VERIFIED_SESSION_ATTRIBUTES,
  sessionClaimId,
} from "@/lib/admin/verification-policy";
import { campfitSessionVocabulary, campfitVocabulary } from "@/lib/trust-vocabulary";

import { assertTestDatabase, closeTestPool, getTestPool } from "./test-db";

/** Minimal Camp seed — mirrors `review-apply.test.ts`'s `insertCamp`, trimmed to the columns this file's scaffolding needs. */
async function insertCamp(
  pool: Pool,
  overrides: { name?: string; description?: string } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "Camp" (slug, name, "campType", category, description)
     VALUES ($1, $2, 'SUMMER_DAY', 'SPORTS', $3)
     RETURNING id`,
    [
      `test-camp-${randomUUID()}`,
      overrides.name ?? "Test Camp",
      overrides.description ?? "",
    ],
  );
  return result.rows[0]!.id;
}

interface CampScheduleSeed {
  label: string;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
}

/** Seed multiple `CampSchedule` rows for a Camp, returning their ids in insertion order. */
async function insertCampSchedules(
  pool: Pool,
  campId: string,
  schedules: CampScheduleSeed[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const schedule of schedules) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        campId,
        schedule.label,
        schedule.startDate,
        schedule.endDate,
        schedule.startTime ?? null,
        schedule.endTime ?? null,
      ],
    );
    ids.push(result.rows[0]!.id);
  }
  return ids;
}

/** Seed a Camp with N `CampSchedule` rows in one call — the shared fixture Wave 5's AC5/AC6/AC7 cases build on. */
async function seedCampWithSchedules(
  pool: Pool,
  schedules: CampScheduleSeed[],
  campOverrides: Parameters<typeof insertCamp>[1] = {},
): Promise<{ campId: string; scheduleIds: string[] }> {
  const campId = await insertCamp(pool, campOverrides);
  const scheduleIds = await insertCampSchedules(pool, campId, schedules);
  return { campId, scheduleIds };
}

interface FieldAttestationSeed {
  fieldKey: string;
  status?: "ACTIVE" | "STALE" | "INVALIDATED";
  excerpt?: string | null;
  sourceUrl?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  invalidatedAt?: string | null;
  invalidationReason?: string | null;
  notes?: string | null;
}

/**
 * Seeds one `FieldAttestation` row directly via SQL — the AC3 backfill
 * fixture named in this plan's "Test DB notes" (Wave 5). Bypasses
 * `addFieldAttestation` (`lib/admin/entity-admin-repository.ts`) deliberately:
 * that helper always inserts `status: 'ACTIVE'` and stamps `approvedAt: now()`,
 * with no way to seed a `STALE`/`INVALIDATED` row for AC3's backfill mapping
 * test, which needs exact control over `status`/`invalidatedAt`/
 * `invalidationReason`.
 */
async function insertFieldAttestation(pool: Pool, campId: string, seed: FieldAttestationSeed): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "FieldAttestation"
       ("entityType", "entityId", "fieldKey", excerpt, "sourceUrl", "approvedAt", "approvedBy",
        status, "invalidatedAt", "invalidationReason", notes)
     VALUES ('CAMP', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      campId,
      seed.fieldKey,
      seed.excerpt ?? null,
      seed.sourceUrl ?? null,
      seed.approvedAt ?? new Date().toISOString(),
      seed.approvedBy ?? null,
      seed.status ?? "ACTIVE",
      seed.invalidatedAt ?? null,
      seed.invalidationReason ?? null,
      seed.notes ?? null,
    ],
  );
  return result.rows[0]!.id;
}

/**
 * Persists one Claim + crawl_observation/human_attestation Evidence pair +
 * `verified` Event for a Camp field, satisfying the PRODUCTION
 * `policy.camp.scalar-field`/`policy.camp.repeated-field` policies
 * (`requiredEvidence: ['crawl_observation', 'human_attestation']`) —
 * `deriveCampVerification`/`deriveSessionVerification` always merge in
 * `VERIFIED_CAMP_SESSION_POLICIES` (see verification-authority.ts's
 * `mergePolicies`), so a test claim with no explicit `verificationPolicyId`
 * still resolves against these exact policies by `claimType`, same as
 * production. Shared by the "Wave 3 core" describe block and AC5/AC7 (Wave 5)
 * — every case that needs a genuinely `verified` Camp-level claim (whether to
 * prove the Camp itself evaluates VERIFIED, or so a Session's 4 inherited
 * attributes have something real to inherit `verified` from) goes through
 * this one helper rather than re-deriving the two-evidence-type shape ad hoc.
 */
async function verifyCampField(pool: Pool, campId: string, field: (typeof VERIFIED_CAMP_FIELDS)[number], now: string): Promise<void> {
  const claimId = campCanonicalClaimId(campId, field);
  const claimType = field === "ageGroups" || field === "pricing"
    ? campfitVocabulary.claimTypes.repeatedField
    : campfitVocabulary.claimTypes.scalarField;

  await persistClaim(pool, {
    id: claimId,
    subjectType: campfitVocabulary.subjectType,
    subjectId: campId,
    facet: campfitVocabulary.facet,
    claimType,
    fieldOrBehavior: field,
  });

  const evidenceIds: string[] = [];
  for (const evidenceType of ["crawl_observation", "human_attestation"] as const) {
    const evidenceId = `${claimId}.evidence.${evidenceType}`;
    await appendEvidence(pool, {
      id: evidenceId,
      claimId,
      evidenceType,
      method: evidenceType === "crawl_observation" ? "observation" : "attestation",
      sourceRef: "https://example.com/camp",
      excerptOrSummary: `${field} sourced from the provider's own page.`,
      observedAt: now,
      collectedBy: evidenceType === "crawl_observation" ? "campfit-crawler" : "reviewer@campfit.test",
    });
    evidenceIds.push(evidenceId);
  }

  await appendEvent(pool, {
    id: `${claimId}.event.verified`,
    claimId,
    status: "verified",
    type: "verification",
    actor: "reviewer@campfit.test",
    method: "attestation",
    evidenceIds,
    createdAt: now,
  });
}

beforeAll(async () => {
  // F1 layer (b): see tests/integration/test-db.ts and
  // review-apply.test.ts's file-header note for the full rationale.
  await assertTestDatabase();
});

afterEach(async () => {
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  // The Surface* tables carry no FK to "Camp" (subjectId is a plain TEXT
  // column, not a real foreign key — a claim subject can be a Camp OR a
  // CampSchedule OR, eventually, other subject types), so truncating "Camp"
  // above does not cascade into them. Truncating "SurfaceClaimDefinition"
  // cascades (ON DELETE CASCADE, migration 012) into "SurfaceEvidence"/
  // "SurfaceVerificationEvent"; "SurfaceVerificationPolicy"/
  // "SurfaceClaimGroup" are truncated explicitly since claims only carry an
  // optional FK to the former and no FK to the latter at all.
  await pool.query(
    `TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`,
  );
});

afterAll(async () => {
  await closeTestPool();
  await getProductionPool().end();
});

describe("verification-authority scaffolding", () => {
  it("seeds a Camp with multiple CampSchedule rows and reads them back (scaffolding smoke test)", async () => {
    const pool = getTestPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(pool, [
      { label: "Session A", startDate: "2026-07-06", endDate: "2026-07-10", startTime: "09:00", endTime: "15:00" },
      { label: "Session B", startDate: "2026-07-13", endDate: "2026-07-17" },
    ]);

    expect(scheduleIds).toHaveLength(2);

    const rows = await pool.query<{ id: string; label: string; campId: string }>(
      `SELECT id, label, "campId" FROM "CampSchedule" WHERE "campId" = $1 ORDER BY label`,
      [campId],
    );
    expect(rows.rows.map((r) => r.label)).toEqual(["Session A", "Session B"]);
    expect(rows.rows.every((r) => r.campId === campId)).toBe(true);
  });
});

describe("AC2 claim-store-adapter", () => {
  it("constructs a Claim + Evidence row + Event via claim-store.ts's Postgres ClaimStoreAdapter, reads it back, and derives 'verified' via deriveClaimStatus", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "AC2 recordEvidence Camp" });

    // A minimal, self-contained policy for this test (rather than reusing
    // `VERIFIED_CAMP_SESSION_POLICIES`'s production `policy.camp.scalar-field`,
    // which requires BOTH `crawl_observation` AND `human_attestation`
    // entailing evidence — a two-evidence-type bar this single-evidence smoke
    // test isn't trying to prove; that policy's own acceptance criteria are
    // Wave 1/3/4's concern, not this adapter-plumbing test's). `requiredEvidence:
    // ['attestation']` matches exactly what `buildHumanAttestationEvidence`
    // (below) actually produces (`evidenceType: 'attestation'`, distinct from
    // the `'human_attestation'` enum member).
    const policy: VerificationPolicy = {
      id: "policy.ac2-test.scalar-field",
      claimType: campfitVocabulary.claimTypes.scalarField,
      requiredEvidence: ["attestation"],
      acceptanceCriteria: ["A human attested the current value is correct."],
      reviewAuthority: "campfit-admin",
      validityRule: { kind: "duration", durationDays: 365 },
      stalenessTriggers: [],
      conflictRules: [],
      impactLevel: "medium",
    };
    await upsertPolicy(pool, policy);

    const claimId = campCanonicalClaimId(campId, "description");
    const claim: ClaimDefinitionDraft = {
      id: claimId,
      subjectType: campfitVocabulary.subjectType,
      subjectId: campId,
      facet: campfitVocabulary.facet,
      claimType: campfitVocabulary.claimTypes.scalarField,
      fieldOrBehavior: "description",
      verificationPolicyId: policy.id,
    };

    const evidence = buildHumanAttestationEvidence({
      subject: { claimId, sourceRef: "admin:reviewer@campfit.test" },
      actor: { id: "reviewer@campfit.test", displayName: "Test Reviewer" },
      attestedAt: new Date().toISOString(),
      contentHash: "sha256-test-content-hash",
    });

    await recordEvidence(pool, { claim, evidence });

    // DB rows match: one ClaimDefinition, one Evidence, one VerificationEvent.
    const claimRows = await testPool.query<{ id: string; subjectId: string; verificationPolicyId: string }>(
      `SELECT id, "subjectId", "verificationPolicyId" FROM "SurfaceClaimDefinition" WHERE id = $1`,
      [claimId],
    );
    expect(claimRows.rows).toEqual([{ id: claimId, subjectId: campId, verificationPolicyId: policy.id }]);

    const evidenceRows = await testPool.query<{ id: string; claimId: string; evidenceType: string }>(
      `SELECT id, "claimId", "evidenceType" FROM "SurfaceEvidence" WHERE "claimId" = $1`,
      [claimId],
    );
    expect(evidenceRows.rows).toEqual([{ id: evidence.id, claimId, evidenceType: "attestation" }]);

    const eventRows = await testPool.query<{ claimId: string; status: string; evidenceIds: string[] }>(
      `SELECT "claimId", status, "evidenceIds" FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`,
      [claimId],
    );
    expect(eventRows.rows).toEqual([{ claimId, status: "verified", evidenceIds: [evidence.id] }]);

    // Reads back through loadClaimBundle (the TrustBundle-shaped assembly
    // deriveTrustSnapshot/deriveClaimStatus consume) and derives 'verified'.
    const bundle = await loadClaimBundle(pool, [{ subjectType: campfitVocabulary.subjectType, subjectId: campId }]);
    expect(() => validateTrustBundle(bundle)).not.toThrow();

    const reconstructedClaim = bundle.claims.find((candidate) => candidate.id === claimId);
    expect(reconstructedClaim).toBeDefined();

    const { status } = deriveClaimStatus({
      claim: reconstructedClaim!,
      evidence: bundle.evidence.filter((item) => item.claimId === claimId),
      events: bundle.events.filter((item) => item.claimId === claimId),
      policies: bundle.policies,
    });
    expect(status).toBe("verified");
  });

  it("round-trips a ClaimStore (claims + policy) through createPostgresClaimStoreAdapter's load()/save(), preserving producer, passing validateClaimStore, and matching the underlying rows", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "AC2 adapter round-trip Camp" });

    const adapter = createPostgresClaimStoreAdapter({
      pool,
      subjectType: campfitVocabulary.subjectType,
      subjectId: campId,
      producer: "campfit-test",
    });

    // Empty-store bootstrap: no rows yet for this subject, so the adapter's
    // configured `producer` option is the default (see claim-store.ts's
    // header comment gap 1).
    const empty = await adapter.load();
    expect(empty).toEqual({ schemaVersion: 1, producer: "campfit-test", claims: [], policies: [] });

    const policy = VERIFIED_CAMP_SESSION_POLICIES.find(
      (candidate) => candidate.claimType === campfitVocabulary.claimTypes.scalarField,
    )!;
    // Policies must be authored before a claim referencing them is
    // persisted — `persistClaim` fails loud (see claim-store.ts) if the
    // referenced `verificationPolicyId` doesn't already exist.
    await upsertPolicy(pool, policy);

    const claimId = campCanonicalClaimId(campId, "campType");
    const persisted = await persistClaim(
      pool,
      {
        id: claimId,
        subjectType: campfitVocabulary.subjectType,
        subjectId: campId,
        facet: campfitVocabulary.facet,
        claimType: campfitVocabulary.claimTypes.scalarField,
        fieldOrBehavior: "campType",
        verificationPolicyId: policy.id,
      },
      // Matches the producer the adapter above was constructed with — a
      // fresh call to `persistClaim` constructs its own adapter internally
      // (see claim-store.ts) and would otherwise stamp this row with ITS
      // OWN default producer ("campfit"), which would then win as "the
      // first row's stashed producer" on the next `load()` below regardless
      // of what producer the adapter instance above was configured with.
      { producer: "campfit-test" },
    );
    expect(persisted.id).toBe(claimId);

    const reloaded = await adapter.load();
    expect(validateClaimStore(reloaded)).toEqual(reloaded);
    expect(reloaded.producer).toBe("campfit-test");
    expect(reloaded.claims.map((claim) => claim.id)).toEqual([claimId]);
    expect(reloaded.policies.map((candidate) => candidate.id)).toEqual([policy.id]);

    // save() round-trips producer back onto the row exactly as loaded —
    // proving the adapter's own load()/save() cycle (not just persistClaim)
    // is what this task's AC2 asks for.
    await adapter.save(reloaded);
    const rows = await testPool.query<{ id: string; subjectId: string }>(
      `SELECT id, "subjectId" FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1`,
      [campId],
    );
    expect(rows.rows).toEqual([{ id: claimId, subjectId: campId }]);

    const policyRows = await testPool.query<{ id: string }>(`SELECT id FROM "SurfaceVerificationPolicy" WHERE id = $1`, [policy.id]);
    expect(policyRows.rows).toEqual([{ id: policy.id }]);
  });

  it("appendEvidence fails loud (does not silently drop data) when Evidence sets a field migration 012's SurfaceEvidence table has no column for", async () => {
    const pool = getProductionPool();
    await expect(
      appendEvidence(pool, {
        id: `evidence.${campCanonicalClaimId("unsupported-field-probe", "description")}`,
        claimId: campCanonicalClaimId("unsupported-field-probe", "description"),
        evidenceType: "attestation",
        method: "attestation",
        sourceRef: "admin:test",
        excerptOrSummary: "probe",
        observedAt: new Date().toISOString(),
        collectedBy: "test",
        passing: true,
      }),
    ).rejects.toThrow(/has no column for/);
  });
});

describe("AC3 backfill", () => {
  it("skips unapproved discovery observations while still projecting an approved fieldSource control", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "C2 unapproved observation Camp" });
    const approvedAt = new Date().toISOString();
    await testPool.query(
      `UPDATE "Camp" SET "fieldSources" = $1::jsonb WHERE id = $2`,
      [
        JSON.stringify({
          websiteUrl: {
            excerpt: "[Program details](https://example.com/camp)",
            locator: "chars:0-30",
            sourceUrl: "https://example.com/programs",
            sourceRef: `traverse-snapshot:campfit-discovery%3Ahttps%3A%2F%2Fexample.com%2Fprograms?url=https%3A%2F%2Fexample.com%2Fprograms&sha256=${"a".repeat(64)}&fetchedAt=2026-07-10T00%3A00%3A00.000Z`,
          },
          description: {
            excerpt: "Approved description.",
            sourceUrl: "https://example.com/camp",
            approvedAt,
            attestedBy: "reviewer@campfit.test",
          },
        }),
        campId,
      ],
    );

    const summary = await backfillClaimStore(pool, { dryRun: false });
    expect(summary.fieldSourcesProjected).toBe(1);
    expect(summary.fieldSourcesSkipped).toBe(1);
    expect(summary.evidenceInserted).toBe(1);
    expect(summary.eventsInserted).toBe(1);

    const claims = await testPool.query<{ fieldOrBehavior: string }>(
      `SELECT "fieldOrBehavior" FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY "fieldOrBehavior"`,
      [campId],
    );
    expect(claims.rows).toEqual([{ fieldOrBehavior: "description" }]);
    const events = await testPool.query<{ status: string }>(
      `SELECT status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`,
      [campCanonicalClaimId(campId, "description")],
    );
    expect(events.rows).toEqual([{ status: "verified" }]);
  });

  it("projects fieldSources + FieldAttestation (ACTIVE and INVALIDATED) into Claim/Evidence/VerificationEvent rows, dry-run writes nothing, and re-running is idempotent", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "AC3 backfill Camp" });

    // `description`: crawl-sourced fieldSources entry (no `attestedBy`) — the
    // "campfit-crawler"/`crawl_observation` leg of the mapping.
    // `campType`: ALSO present in fieldSources (admin-attested, `attestedBy`
    // set) AND has its own `FieldAttestation` row below — proves the plan's
    // "both legacy stores project into the ClaimStore" dual-source
    // reconciliation lands on the SAME Claim id (one row, two Evidence/Event
    // rows), not two competing claims.
    const now = new Date().toISOString();
    await testPool.query(
      `UPDATE "Camp" SET "fieldSources" = $1::jsonb WHERE id = $2`,
      [
        JSON.stringify({
          description: { excerpt: "A great day camp downtown.", sourceUrl: "https://example.com/camp", approvedAt: now },
          campType: { excerpt: null, sourceUrl: "admin:reviewer@campfit.test", approvedAt: now, attestedBy: "reviewer@campfit.test", notes: "Confirmed by phone" },
        }),
        campId,
      ],
    );

    const activeAttestationId = await insertFieldAttestation(testPool, campId, {
      fieldKey: "campType",
      status: "ACTIVE",
      excerpt: "Provider site confirms day camp.",
      sourceUrl: "https://example.com/camp",
      approvedBy: "reviewer@campfit.test",
      approvedAt: now,
    });
    const invalidatedAttestationId = await insertFieldAttestation(testPool, campId, {
      fieldKey: "ageGroups",
      status: "INVALIDATED",
      approvedBy: "reviewer@campfit.test",
      approvedAt: now,
      invalidatedAt: now,
      invalidationReason: "Provider changed age bands; re-crawl required.",
    });

    const descriptionClaimId = campCanonicalClaimId(campId, "description");
    const campTypeClaimId = campCanonicalClaimId(campId, "campType");
    const ageGroupsClaimId = campCanonicalClaimId(campId, "ageGroups");

    // --- Dry run: counts what WOULD be projected, writes nothing. ---
    const dryRunSummary = await backfillClaimStore(pool, { dryRun: true });
    expect(dryRunSummary.dryRun).toBe(true);
    expect(dryRunSummary.fieldSourcesProjected).toBeGreaterThanOrEqual(2);
    expect(dryRunSummary.fieldAttestationRowsProjected).toBeGreaterThanOrEqual(2);
    expect(dryRunSummary.evidenceInserted).toBe(0);
    expect(dryRunSummary.eventsInserted).toBe(0);

    const claimsAfterDryRun = await testPool.query(
      `SELECT 1 FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1`,
      [campId],
    );
    expect(claimsAfterDryRun.rows).toHaveLength(0);

    // --- Real run: projects fieldSources + FieldAttestation rows. ---
    const summary = await backfillClaimStore(pool, { dryRun: false });
    expect(summary.dryRun).toBe(false);
    expect(summary.evidenceInserted).toBe(4); // description(1) + campType-fieldSources(1) + campType-attestation(1) + ageGroups-attestation(1)
    expect(summary.eventsInserted).toBe(4);

    const claimRows = await testPool.query<{ id: string; claimType: string; verificationPolicyId: string | null }>(
      `SELECT id, "claimType", "verificationPolicyId" FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY id`,
      [campId],
    );
    expect(claimRows.rows.map((row) => row.id).sort()).toEqual(
      [ageGroupsClaimId, campTypeClaimId, descriptionClaimId].sort(),
    );
    const campTypeClaim = claimRows.rows.find((row) => row.id === campTypeClaimId)!;
    expect(campTypeClaim.claimType).toBe(campfitVocabulary.claimTypes.scalarField);
    expect(campTypeClaim.verificationPolicyId).toBe("policy.camp.scalar-field");
    const ageGroupsClaim = claimRows.rows.find((row) => row.id === ageGroupsClaimId)!;
    expect(ageGroupsClaim.claimType).toBe(campfitVocabulary.claimTypes.repeatedField);
    expect(ageGroupsClaim.verificationPolicyId).toBe("policy.camp.repeated-field");

    // Dual source: campType's Claim carries evidence from BOTH fieldSources
    // (evidenceType 'crawl_observation'/'attestation' per attestedBy) and the
    // FieldAttestation row keyed by the row's own id — two distinct Evidence
    // rows for one Claim.
    const campTypeEvidence = await testPool.query<{ id: string; evidenceType: string; collectedBy: string }>(
      `SELECT id, "evidenceType", "collectedBy" FROM "SurfaceEvidence" WHERE "claimId" = $1 ORDER BY id`,
      [campTypeClaimId],
    );
    expect(campTypeEvidence.rows).toEqual([
      { id: `evidence.${campTypeClaimId}.field-attestation.${activeAttestationId}`, evidenceType: "attestation", collectedBy: "reviewer@campfit.test" },
      { id: `evidence.${campTypeClaimId}.legacy-field-source`, evidenceType: "attestation", collectedBy: "reviewer@campfit.test" },
    ]);

    const descriptionEvidence = await testPool.query<{ evidenceType: string; method: string; sourceRef: string }>(
      `SELECT "evidenceType", method, "sourceRef" FROM "SurfaceEvidence" WHERE "claimId" = $1`,
      [descriptionClaimId],
    );
    expect(descriptionEvidence.rows).toEqual([
      { evidenceType: "crawl_observation", method: "observation", sourceRef: "https://example.com/camp" },
    ]);

    // INVALIDATED -> 'revoked' (non-verified) status, 'invalidation' event
    // type, invalidationReason carried into the event's notes — the plan's
    // FieldAttestation.status -> TrustStatus mapping.
    const ageGroupsEvents = await testPool.query<{ id: string; status: string; type: string | null; notes: string | null }>(
      `SELECT id, status, type, notes FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`,
      [ageGroupsClaimId],
    );
    expect(ageGroupsEvents.rows).toEqual([
      {
        id: `event.${ageGroupsClaimId}.field-attestation.${invalidatedAttestationId}`,
        status: "revoked",
        type: "invalidation",
        notes: "Provider changed age bands; re-crawl required.",
      },
    ]);

    // ACTIVE -> 'verified'.
    const campTypeAttestationEvent = await testPool.query<{ status: string; type: string | null }>(
      `SELECT status, type FROM "SurfaceVerificationEvent" WHERE id = $1`,
      [`event.${campTypeClaimId}.field-attestation.${activeAttestationId}`],
    );
    expect(campTypeAttestationEvent.rows).toEqual([{ status: "verified", type: "verification" }]);

    // Legacy sources remain fully intact and readable post-backfill.
    const campRow = await testPool.query<{ fieldSources: Record<string, unknown> }>(
      `SELECT "fieldSources" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(Object.keys(campRow.rows[0]!.fieldSources).sort()).toEqual(["campType", "description"].sort());
    const attestationRows = await testPool.query(
      `SELECT id FROM "FieldAttestation" WHERE "entityId" = $1 ORDER BY id`,
      [campId],
    );
    expect(attestationRows.rows.map((row) => row.id).sort()).toEqual(
      [activeAttestationId, invalidatedAttestationId].sort(),
    );

    // --- Idempotency: re-running writes nothing new; row counts unchanged. ---
    const claimCountBefore = await testPool.query(`SELECT count(*)::int AS n FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1`, [campId]);
    const evidenceCountBefore = await testPool.query(
      `SELECT count(*)::int AS n FROM "SurfaceEvidence" WHERE "claimId" = ANY($1)`,
      [[descriptionClaimId, campTypeClaimId, ageGroupsClaimId]],
    );
    const eventCountBefore = await testPool.query(
      `SELECT count(*)::int AS n FROM "SurfaceVerificationEvent" WHERE "claimId" = ANY($1)`,
      [[descriptionClaimId, campTypeClaimId, ageGroupsClaimId]],
    );

    const rerunSummary = await backfillClaimStore(pool, { dryRun: false });
    expect(rerunSummary.evidenceInserted).toBe(0);
    expect(rerunSummary.eventsInserted).toBe(0);

    const claimCountAfter = await testPool.query(`SELECT count(*)::int AS n FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1`, [campId]);
    const evidenceCountAfter = await testPool.query(
      `SELECT count(*)::int AS n FROM "SurfaceEvidence" WHERE "claimId" = ANY($1)`,
      [[descriptionClaimId, campTypeClaimId, ageGroupsClaimId]],
    );
    const eventCountAfter = await testPool.query(
      `SELECT count(*)::int AS n FROM "SurfaceVerificationEvent" WHERE "claimId" = ANY($1)`,
      [[descriptionClaimId, campTypeClaimId, ageGroupsClaimId]],
    );
    expect(claimCountAfter.rows[0]!.n).toBe(claimCountBefore.rows[0]!.n);
    expect(evidenceCountAfter.rows[0]!.n).toBe(evidenceCountBefore.rows[0]!.n);
    expect(eventCountAfter.rows[0]!.n).toBe(eventCountBefore.rows[0]!.n);
  });

  it("V7 fix: buildDowngradeImpactReport flags a currently-VERIFIED Camp whose status rests on legacy-only backfilled evidence as a downgrade (VERIFIED -> PLACEHOLDER), and does not flag a genuinely-VERIFIED Camp", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const now = new Date().toISOString();

    // Camp A: currently marked VERIFIED in the Camp row itself, but its ONLY
    // backing evidence is legacy fieldSources across all 8 fields (never a
    // real crawl_observation + human_attestation pair) — exactly the
    // "legacy-VERIFIED -> PLACEHOLDER downgrade" scenario the Semantic
    // finding documents.
    const legacyVerifiedCampId = await insertCamp(testPool, { name: "V7 legacy-VERIFIED Camp" });
    const fieldSourcesPatch: Record<string, { excerpt: string | null; sourceUrl: string; approvedAt: string }> = {};
    for (const field of VERIFIED_CAMP_FIELDS) {
      fieldSourcesPatch[field] = { excerpt: `${field} value`, sourceUrl: "https://example.com/camp", approvedAt: now };
    }
    await testPool.query(
      `UPDATE "Camp" SET "fieldSources" = $1::jsonb, "dataConfidence" = 'VERIFIED' WHERE id = $2`,
      [JSON.stringify(fieldSourcesPatch), legacyVerifiedCampId],
    );

    // Camp B: genuinely VERIFIED — real crawl_observation + human_attestation
    // evidence for all 8 fields (verifyCampField), no Sessions. Its CURRENT
    // dataConfidence is set to VERIFIED directly here (this test is only
    // checking the report's comparison logic, not refreshCampVerificationCache
    // itself — that's covered by the "Wave 3 core" describe block).
    const genuinelyVerifiedCampId = await insertCamp(testPool, { name: "V7 genuinely-VERIFIED Camp" });
    for (const field of VERIFIED_CAMP_FIELDS) {
      await verifyCampField(pool, genuinelyVerifiedCampId, field, now);
    }
    await testPool.query(`UPDATE "Camp" SET "dataConfidence" = 'VERIFIED' WHERE id = $1`, [genuinelyVerifiedCampId]);

    // A third, non-VERIFIED Camp — the report only ever evaluates
    // currently-VERIFIED Camps, so this one must never appear either way.
    const placeholderCampId = await insertCamp(testPool, { name: "V7 PLACEHOLDER Camp" });

    await backfillClaimStore(pool, { dryRun: false });

    const report = await buildDowngradeImpactReport(pool);
    expect(report.campsEvaluated).toBe(2); // only the two currently-VERIFIED camps

    const downgradeCampIds = report.downgrades.map((d) => d.campId);
    expect(downgradeCampIds).toContain(legacyVerifiedCampId);
    expect(downgradeCampIds).not.toContain(genuinelyVerifiedCampId);
    expect(downgradeCampIds).not.toContain(placeholderCampId);

    const legacyDowngrade = report.downgrades.find((d) => d.campId === legacyVerifiedCampId)!;
    expect(legacyDowngrade.currentDataConfidence).toBe("VERIFIED");
    expect(legacyDowngrade.derivedDataConfidence).toBe("PLACEHOLDER");
  });

  it("backfill\u2192evaluate proof: backfilling a legacy-shaped Camp (all 8 Verified Camp Claim Set fields, via fieldSources + FieldAttestation, zero manual persistClaim/recordEvidence calls) then calling deriveCampVerification produces the expected, honest status \u2014 PLACEHOLDER, not a silently-fabricated VERIFIED, since legacy-sourced evidence alone never satisfies policy.camp.scalar-field/repeated-field's ['crawl_observation', 'human_attestation'] requirement", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "Backfill\u2192evaluate proof Camp" });
    const now = new Date().toISOString();

    // A realistic legacy shape across all 8 canonical fields: some via
    // fieldSources (crawl-sourced, no attestedBy -> 'crawl_observation'
    // Evidence), some via fieldSources with attestedBy (admin, ->
    // 'attestation' Evidence), some via an ACTIVE FieldAttestation row (->
    // 'attestation' Evidence). None of these legacy sources ever produce
    // 'human_attestation'-typed Evidence (only fresh crawl_observation/
    // human_attestation writer paths do, per verifyCampField above) \u2014 so
    // every field here is short of policy.camp.scalar-field/repeated-field's
    // two-required-evidence-type bar, by design of what "legacy" data means.
    const fieldSourcesPatch: Record<string, { excerpt: string | null; sourceUrl: string; approvedAt: string; attestedBy?: string }> = {
      description: { excerpt: "A great day camp downtown.", sourceUrl: "https://example.com/camp", approvedAt: now },
      campType: { excerpt: "Day camp confirmed on provider site.", sourceUrl: "https://example.com/camp", approvedAt: now },
      category: { excerpt: null, sourceUrl: "admin:reviewer@campfit.test", approvedAt: now, attestedBy: "reviewer@campfit.test" },
      city: { excerpt: null, sourceUrl: "admin:reviewer@campfit.test", approvedAt: now, attestedBy: "reviewer@campfit.test" },
      websiteUrl: { excerpt: "https://example.com/camp", sourceUrl: "https://example.com/camp", approvedAt: now },
      pricing: { excerpt: "$100/week", sourceUrl: "https://example.com/camp", approvedAt: now },
    };
    await testPool.query(`UPDATE "Camp" SET "fieldSources" = $1::jsonb WHERE id = $2`, [JSON.stringify(fieldSourcesPatch), campId]);
    await insertFieldAttestation(testPool, campId, { fieldKey: "registrationStatus", status: "ACTIVE", approvedBy: "reviewer@campfit.test", approvedAt: now });
    await insertFieldAttestation(testPool, campId, { fieldKey: "ageGroups", status: "ACTIVE", approvedBy: "reviewer@campfit.test", approvedAt: now });

    const summary = await backfillClaimStore(pool, { dryRun: false });
    expect(summary.evidenceInserted).toBeGreaterThanOrEqual(8);

    // Zero manual claim writes from here on \u2014 only the read-only evaluator.
    const rollup = await deriveCampVerification(campId);
    expect(rollup.requirements.map((requirement) => requirement.id).sort()).toEqual(
      [...VERIFIED_CAMP_FIELDS, "sessions-verified"].sort(),
    );
    for (const field of VERIFIED_CAMP_FIELDS) {
      const requirement = rollup.requirements.find((candidate) => candidate.id === field)!;
      expect(requirement.status).toBe("proposed");
    }
    // No Sessions -> sessions-verified is trivially verified (documented
    // default), but it cannot lift the other 8 under an all-required rollup.
    const sessionsRequirement = rollup.requirements.find((requirement) => requirement.id === "sessions-verified")!;
    expect(sessionsRequirement.status).toBe("verified");
    expect(rollup.status).toBe("proposed");

    const cacheResult = await refreshCampVerificationCache(campId);
    expect(cacheResult.dataConfidence).toBe("PLACEHOLDER");
    const campRow = await testPool.query<{ dataConfidence: string }>(
      `SELECT "dataConfidence" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRow.rows[0]!.dataConfidence).toBe("PLACEHOLDER");
  });
});

describe("AC4 writers-recordEvidence", () => {
  /**
   * `mark_verified` (app/api/admin/camps/[campId]/route.ts POST) and the
   * assistant tool's `mark_camp_verified` case (app/api/admin/assistant/
   * route.ts) both replace their old unconditional `UPDATE "Camp" SET
   * "dataConfidence" = 'VERIFIED'` with the SAME shared helper,
   * `bulkAttestCamp` (lib/admin/bulk-attestation.ts) — exercised directly
   * below rather than through the Next.js route handlers themselves (which
   * need a live request/auth context not worth standing up here; both call
   * sites are thin wrappers — an auth check, then
   * `bulkAttestCamp(campId, actorEmail)`, then a response built from its
   * result — with no additional logic of their own to exercise separately).
   */
  it("mark_verified route's shared bulkAttestCamp helper records human-attestation Evidence + an Event for every required Camp Attribute, and derives VERIFIED for a fully-attested, zero-Session Camp", async () => {
    const testPool = getTestPool();
    const campId = await insertCamp(testPool, { name: "AC4 mark_verified bulk-attestation Camp" });

    const result = await bulkAttestCamp(campId, "reviewer@campfit.test");

    expect(result.attestedFieldCount).toBe(VERIFIED_CAMP_FIELDS.length);
    expect(result.gapRequirementIds).toEqual([]);
    expect(result.dataConfidence).toBe("VERIFIED");

    // One human-attestation Evidence row + one Event row per field.
    for (const field of VERIFIED_CAMP_FIELDS) {
      const claimId = campCanonicalClaimId(campId, field);
      const evidenceRows = await testPool.query<{ evidenceType: string; collectedBy: string }>(
        `SELECT "evidenceType", "collectedBy" FROM "SurfaceEvidence" WHERE "claimId" = $1`,
        [claimId],
      );
      expect(evidenceRows.rows).toEqual([{ evidenceType: "attestation", collectedBy: "reviewer@campfit.test" }]);

      const eventRows = await testPool.query<{ status: string; actor: string }>(
        `SELECT status, actor FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`,
        [claimId],
      );
      expect(eventRows.rows).toEqual([{ status: "assumed", actor: "reviewer@campfit.test" }]);
    }

    // refreshCampVerificationCache (the sole writer, AC1) was invoked — the
    // Camp row itself now reflects the derived outcome.
    const campRow = await testPool.query<{ dataConfidence: string; lastVerifiedAt: string | null }>(
      `SELECT "dataConfidence", "lastVerifiedAt" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRow.rows[0]!.dataConfidence).toBe("VERIFIED");
    expect(campRow.rows[0]!.lastVerifiedAt).not.toBeNull();
  });

  it("assistant tool's mark_camp_verified case's shared bulkAttestCamp helper still records attestation Evidence for every required Camp Attribute, but derives a non-VERIFIED outcome — reporting the gap rather than pretending success — when a Session has a verification gap", async () => {
    const testPool = getTestPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(
      testPool,
      [{ label: "Session A", startDate: "2026-08-03", endDate: "2026-08-07" }],
      { name: "AC4 mark_camp_verified gap Camp" },
    );
    // Deliberately: no Claim/Evidence is ever persisted for this Session's
    // `dates`/`time` — the same Verification Gap the "Wave 3 core" suite
    // proves below, exercised here through the bulk-attestation writer path.

    const result = await bulkAttestCamp(campId, "reviewer@campfit.test");

    // The bulk attestation still ran for every Camp field — this is not a
    // partial/aborted attestation, just a Camp whose Sessions aren't fully
    // verified yet.
    expect(result.attestedFieldCount).toBe(VERIFIED_CAMP_FIELDS.length);
    for (const field of VERIFIED_CAMP_FIELDS) {
      const claimId = campCanonicalClaimId(campId, field);
      const evidenceRows = await testPool.query<{ evidenceType: string }>(
        `SELECT "evidenceType" FROM "SurfaceEvidence" WHERE "claimId" = $1`,
        [claimId],
      );
      expect(evidenceRows.rows).toHaveLength(1);
    }

    // The gap surfaces honestly rather than an unconditional "verified" flip.
    expect(result.gapRequirementIds).toContain("sessions-verified");
    expect(result.dataConfidence).not.toBe("VERIFIED");

    const campRow = await testPool.query<{ dataConfidence: string }>(
      `SELECT "dataConfidence" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRow.rows[0]!.dataConfidence).not.toBe("VERIFIED");

    // Sanity: the Session itself is the reason — its own rollup is capped by
    // the missing dates/time Claims (an explicit Verification Gap), not this
    // Camp's field attestations being incomplete.
    const sessionRollup = await deriveSessionVerification(scheduleIds[0]!);
    expect(sessionRollup.status).not.toBe("verified");
  });
  it("/attest route's reconciled path (recordCampAttestationEvidence, lib/admin/entity-admin-repository.ts) creates a Claim + Evidence + Event row per attested field and drives refreshCampVerificationCache to VERIFIED for a fully-attested, session-less Camp", async () => {
    const testPool = getTestPool();
    const campId = await insertCamp(testPool, { name: "AC4 /attest reconciliation Camp" });
    const attestedAt = new Date().toISOString();

    // Exercises the exact function `app/api/admin/camps/[campId]/attest/
    // route.ts`'s POST handler calls (bulk multi-field case) — see this
    // task's plan wording ("buildCampAttestationTrustInput's Claims/Evidence
    // go through recordEvidence(...), then refreshCampVerificationCache").
    await recordCampAttestationEvidence({
      mode: 'override',
      campId,
      fields: [...VERIFIED_CAMP_FIELDS],
      actor: "reviewer@campfit.test",
      attestedAt,
      notes: "Reviewed and attested all required fields.",
    });

    const claimIds = VERIFIED_CAMP_FIELDS.map((field) => campCanonicalClaimId(campId, field));

    const claimRows = await testPool.query<{ id: string }>(
      `SELECT id FROM "SurfaceClaimDefinition" WHERE id = ANY($1)`,
      [claimIds],
    );
    expect(claimRows.rows.map((row) => row.id).sort()).toEqual([...claimIds].sort());

    const evidenceRows = await testPool.query<{ claimId: string; evidenceType: string }>(
      `SELECT "claimId", "evidenceType" FROM "SurfaceEvidence" WHERE "claimId" = ANY($1)`,
      [claimIds],
    );
    expect(evidenceRows.rows).toHaveLength(claimIds.length);
    expect(evidenceRows.rows.every((row) => row.evidenceType === "attestation")).toBe(true);

    const eventRows = await testPool.query<{ claimId: string; status: string }>(
      `SELECT "claimId", status FROM "SurfaceVerificationEvent" WHERE "claimId" = ANY($1)`,
      [claimIds],
    );
    expect(eventRows.rows).toHaveLength(claimIds.length);
    expect(eventRows.rows.every((row) => row.status === "assumed")).toBe(true);

    // refreshCampVerificationCache ran as part of recordCampAttestationEvidence:
    // every Verified Camp Claim Set field is attested and there are no
    // Sessions to fail sessions-verified, so the Camp evaluates VERIFIED
    // end-to-end (an "assumed" claim's requirement is promoted to "verified"
    // at the requirement-rollup level — claim-groups.js's
    // deriveRequirementStatus — exactly like a direct human attestation; see
    // the analogous fully-verified-Camp case in the "Wave 3 core" describe
    // block above).
    const campRow = await testPool.query<{ dataConfidence: string; lastVerifiedAt: string | null }>(
      `SELECT "dataConfidence", "lastVerifiedAt" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRow.rows[0]!.dataConfidence).toBe("VERIFIED");
    expect(campRow.rows[0]!.lastVerifiedAt).not.toBeNull();
  });

  it("addFieldAttestation (lib/admin/entity-admin-repository.ts) dual-writes for CAMP + claim-set fields (Claim/Evidence/Event rows + cache refresh, ALONGSIDE the FieldAttestation row) and stays FieldAttestation-only for a non-claim-set field", async () => {
    const testPool = getTestPool();
    const campId = await insertCamp(testPool, { name: "AC4 addFieldAttestation dual-write Camp" });

    // Claim-set field ('description', a Verified Camp Claim Set member per
    // verification-policy.ts's VERIFIED_CAMP_FIELDS): both stores get written.
    const descriptionAttestation = await addFieldAttestation({
      entityType: "CAMP",
      entityId: campId,
      fieldKey: "description",
      actor: "reviewer@campfit.test",
      mode: "source",
      sourceUrl: "https://example.com/camp",
      excerpt: "A great day camp downtown.",
    });
    expect(descriptionAttestation.fieldKey).toBe("description");

    const descriptionClaimId = campCanonicalClaimId(campId, "description");
    const descriptionClaimRows = await testPool.query<{ id: string }>(
      `SELECT id FROM "SurfaceClaimDefinition" WHERE id = $1`,
      [descriptionClaimId],
    );
    expect(descriptionClaimRows.rows).toEqual([{ id: descriptionClaimId }]);

    const descriptionEvidenceRows = await testPool.query<{ claimId: string }>(
      `SELECT "claimId" FROM "SurfaceEvidence" WHERE "claimId" = $1`,
      [descriptionClaimId],
    );
    expect(descriptionEvidenceRows.rows).toHaveLength(1);

    const descriptionEventRows = await testPool.query<{ claimId: string; status: string }>(
      `SELECT "claimId", status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1`,
      [descriptionClaimId],
    );
    expect(descriptionEventRows.rows).toEqual([{ claimId: descriptionClaimId, status: "assumed" }]);

    // refreshCampVerificationCache ran (lastVerifiedAt moved off its NULL
    // default), even though the Camp as a whole isn't fully verified yet —
    // only one of the Verified Camp Claim Set's 8 fields is attested.
    const campRowAfterFirst = await testPool.query<{ lastVerifiedAt: string | null }>(
      `SELECT "lastVerifiedAt" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRowAfterFirst.rows[0]!.lastVerifiedAt).not.toBeNull();

    // Non-claim-set field ('organizationName' — one of the ~20
    // ENTITY_ATTESTATION_FIELDS keys outside the Verified Camp Claim Set, per
    // this task's plan): the FieldAttestation row is still written (legacy
    // store unaffected), but NO recordEvidence call happens for it — proving
    // the reconciliation is scoped exactly to claim-set fields, not silently
    // applied everywhere.
    const orgNameAttestation = await addFieldAttestation({
      entityType: "CAMP",
      entityId: campId,
      fieldKey: "organizationName",
      actor: "reviewer@campfit.test",
      mode: "override",
      notes: "Confirmed verbally with the provider.",
    });
    expect(orgNameAttestation.fieldKey).toBe("organizationName");

    const orgNameClaimId = campCanonicalClaimId(campId, "organizationName");
    const orgNameClaimRows = await testPool.query(
      `SELECT id FROM "SurfaceClaimDefinition" WHERE id = $1`,
      [orgNameClaimId],
    );
    expect(orgNameClaimRows.rows).toHaveLength(0);

    const fieldAttestationRows = await testPool.query<{ fieldKey: string }>(
      `SELECT "fieldKey" FROM "FieldAttestation" WHERE "entityId" = $1 ORDER BY "fieldKey"`,
      [campId],
    );
    expect(fieldAttestationRows.rows.map((row) => row.fieldKey).sort()).toEqual(["description", "organizationName"]);
  });
});

describe("AC5 session-claims", () => {
  it("derives a Session's ClaimGroupRollup and asserts all 6 Verified Session Claim Set requirement ids are present with the expected verified/inherited status (dates/time from schedules diff; eligibility/registration-status/registration-path/price-options derivedFrom the Camp-level claim with metadata.inherited: 'camp-level')", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(
      testPool,
      [{ label: "Session A", startDate: "2026-08-10", endDate: "2026-08-14", startTime: "09:00", endTime: "15:00" }],
      { name: "AC5 session claim set Camp" },
    );
    const scheduleId = scheduleIds[0]!;
    const now = new Date().toISOString();

    // Verify all 8 Camp field Claims first — the 4 inherited Session
    // Attributes (eligibility/registration-status/price-options/
    // registration-path) fall back to these when no per-Session data source
    // exists yet (decision 4).
    for (const field of VERIFIED_CAMP_FIELDS) {
      await verifyCampField(pool, campId, field, now);
    }

    // Real, per-Session evidence for dates/time — the `schedules`
    // relation-field diff's equivalent (crawl_observation + human_attestation
    // Evidence, a `verified` Event), NOT inherited from the Camp. Mirrors
    // `verifyCampField`'s two-evidence-type shape since `policy.session.dates`/
    // `policy.session.time` require the same `['crawl_observation',
    // 'human_attestation']` evidence set.
    const sessionAttributeClaimType: Record<"dates" | "time", string> = {
      dates: campfitSessionVocabulary.claimTypes.dates,
      time: campfitSessionVocabulary.claimTypes.time,
    };
    for (const attribute of ["dates", "time"] as const) {
      const claimId = sessionClaimId(scheduleId, attribute);
      await persistClaim(pool, {
        id: claimId,
        subjectType: SESSION_SUBJECT_TYPE,
        subjectId: scheduleId,
        facet: campfitSessionVocabulary.facet,
        claimType: sessionAttributeClaimType[attribute],
        fieldOrBehavior: attribute,
      });

      const evidenceIds: string[] = [];
      for (const evidenceType of ["crawl_observation", "human_attestation"] as const) {
        const evidenceId = `${claimId}.evidence.${evidenceType}`;
        await appendEvidence(pool, {
          id: evidenceId,
          claimId,
          evidenceType,
          method: evidenceType === "crawl_observation" ? "observation" : "attestation",
          sourceRef: "https://example.com/camp",
          excerptOrSummary: `Session A ${attribute} sourced from the provider's own schedule listing.`,
          observedAt: now,
          collectedBy: evidenceType === "crawl_observation" ? "campfit-crawler" : "reviewer@campfit.test",
        });
        evidenceIds.push(evidenceId);
      }

      await appendEvent(pool, {
        id: `${claimId}.event.verified`,
        claimId,
        status: "verified",
        type: "verification",
        actor: "reviewer@campfit.test",
        method: "attestation",
        evidenceIds,
        createdAt: now,
      });
    }

    const rollup = await deriveSessionVerification(scheduleId);

    // All 6 Verified Session Claim Set requirement ids are present.
    expect(rollup.requirements.map((requirement) => requirement.id).sort()).toEqual(
      [...VERIFIED_SESSION_ATTRIBUTES].sort(),
    );

    // dates/time: real per-Session evidence -> verified.
    const datesRequirement = rollup.requirements.find((requirement) => requirement.id === "dates")!;
    const timeRequirement = rollup.requirements.find((requirement) => requirement.id === "time")!;
    expect(datesRequirement.status).toBe("verified");
    expect(timeRequirement.status).toBe("verified");

    // The 4 inherited attributes: no per-Session Claim was ever persisted for
    // them, yet they resolve verified because the Camp-level claim they fall
    // back to is itself verified.
    for (const attribute of INHERITED_SESSION_ATTRIBUTES) {
      const requirement = rollup.requirements.find((candidate) => candidate.id === attribute)!;
      expect(requirement.status).toBe("verified");
    }

    expect(rollup.status).toBe("verified");

    // Confirms the inherited requirements are genuinely `derivedFrom` the
    // Camp-level claim (not independently sourced) via
    // `buildInheritedSessionClaims` directly — the exact synthesis
    // `deriveSessionVerification` layers in for these 4 attributes.
    const inherited = buildInheritedSessionClaims({
      campId,
      scheduleId,
      existingClaimIds: new Set([sessionClaimId(scheduleId, "dates"), sessionClaimId(scheduleId, "time")]),
    });
    expect(inherited.claims).toHaveLength(INHERITED_SESSION_ATTRIBUTES.length);
    for (const claim of inherited.claims) {
      expect(claim.metadata).toEqual({ inherited: "camp-level" });
      expect(claim.derivedFrom).toHaveLength(1);
    }
    const eligibilityClaim = inherited.claims.find((claim) => claim.fieldOrBehavior === "eligibility")!;
    expect(eligibilityClaim.derivedFrom).toEqual([campCanonicalClaimId(campId, "ageGroups")]);
    const registrationStatusClaim = inherited.claims.find((claim) => claim.fieldOrBehavior === "registration-status")!;
    expect(registrationStatusClaim.derivedFrom).toEqual([campCanonicalClaimId(campId, "registrationStatus")]);
    const priceOptionsClaim = inherited.claims.find((claim) => claim.fieldOrBehavior === "price-options")!;
    expect(priceOptionsClaim.derivedFrom).toEqual([campCanonicalClaimId(campId, "pricing")]);
    const registrationPathClaim = inherited.claims.find((claim) => claim.fieldOrBehavior === "registration-path")!;
    expect(registrationPathClaim.derivedFrom).toEqual([campCanonicalClaimId(campId, "websiteUrl")]);
  });
});

describe("AC6 stable-sessions", () => {
  // Wave 2 scope: these two cases exercise `lib/admin/session-identity.ts`'s
  // `applyScheduleReconciliation` directly against a real Postgres
  // transaction client (the same function `review-apply.ts`'s
  // `applyRelationField` schedules branch calls) — id preservation and
  // soft-archive-not-delete are provable now that `session-identity.ts`
  // exists. The claims/rollup-carries-a-'revoked'-VerificationEvent half of
  // the original todo is NOT covered here (no `SurfaceClaimDefinition` rows
  // exist for `public-directory.camp-session` subjects until Wave 3's
  // `claim-store.ts` persistence + `verification-authority.ts` exist) — see
  // the "verification-authority.ts (Wave 3 core)" describe block below,
  // `revokeArchivedSessionClaims appends a 'revoked' VerificationEvent for
  // every already-persisted Claim belonging to an archived Session...`, which
  // covers that half directly against `session-identity.ts`'s
  // `deriveArchivedSessionDisposition` wired into an actual claim
  // read+append round-trip.
  it("re-approving same-label+dates schedules preserves CampSchedule ids across two sequential reconciliations", async () => {
    const pool = getTestPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(pool, [
      { label: "Session A", startDate: "2026-07-06", endDate: "2026-07-10", startTime: "09:00", endTime: "15:00" },
    ]);

    const incoming: IncomingScheduleSnapshot[] = [
      { label: "Session A", startDate: "2026-07-06", endDate: "2026-07-10", startTime: "10:00", endTime: "16:00", earlyDropOff: null, latePickup: null },
    ];

    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof applyScheduleReconciliation>>;
    try {
      result = await applyScheduleReconciliation(client, campId, incoming);
    } finally {
      client.release();
    }

    expect(result.matchedIds).toEqual([scheduleIds[0]]);
    expect(result.createdIds).toEqual([]);
    expect(result.orphaned).toEqual([]);

    const rows = await pool.query<{ id: string; startTime: string | null; archivedAt: string | null }>(
      `SELECT id, "startTime", "archivedAt" FROM "CampSchedule" WHERE "campId" = $1`,
      [campId],
    );
    // Same id, updated startTime, not archived — a matched row is updated in
    // place, never rewritten with a fresh id.
    expect(rows.rows).toEqual([{ id: scheduleIds[0], startTime: "10:00", archivedAt: null }]);
  });

  it("removing a schedule in a new approval archives it (archivedAt set), doesn't delete it", async () => {
    const pool = getTestPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(pool, [
      { label: "Session A", startDate: "2026-07-06", endDate: "2026-07-10" },
      { label: "Session B", startDate: "2026-07-13", endDate: "2026-07-17" },
    ]);

    // Session B no longer appears in the incoming snapshot.
    const incoming: IncomingScheduleSnapshot[] = [
      { label: "Session A", startDate: "2026-07-06", endDate: "2026-07-10", startTime: null, endTime: null, earlyDropOff: null, latePickup: null },
    ];

    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof applyScheduleReconciliation>>;
    try {
      result = await applyScheduleReconciliation(client, campId, incoming);
    } finally {
      client.release();
    }

    expect(result.matchedIds).toEqual([scheduleIds[0]]);
    expect(result.createdIds).toEqual([]);
    expect(result.orphaned.map((row) => row.id)).toEqual([scheduleIds[1]]);

    const rows = await pool.query<{ id: string; archivedAt: string | null }>(
      `SELECT id, "archivedAt" FROM "CampSchedule" WHERE "campId" = $1`,
      [campId],
    );
    // Still 2 rows — the dropped session is archived, not deleted.
    expect(rows.rows).toHaveLength(2);
    const sessionBRow = rows.rows.find((row) => row.id === scheduleIds[1]);
    expect(sessionBRow?.archivedAt).not.toBeNull();
    const sessionARow = rows.rows.find((row) => row.id === scheduleIds[0]);
    expect(sessionARow?.archivedAt).toBeNull();
  });
});

describe("AC7 camp-session-rollup", () => {
  it("table covering all 9 TrustStatus inputs mapped to their expected DataConfidence output via projectTrustStatusToDataConfidence, including the PLACEHOLDER default for every non-verified/stale status", () => {
    // The full `TrustStatus` vocabulary (node_modules/@kontourai/surface/dist/
    // src/types.d.ts) — 9 values, matching AC7's plan wording exactly.
    const table: Array<{ status: TrustStatus; expected: "VERIFIED" | "STALE" | "PLACEHOLDER" }> = [
      { status: "verified", expected: "VERIFIED" },
      { status: "stale", expected: "STALE" },
      { status: "unknown", expected: "PLACEHOLDER" },
      { status: "proposed", expected: "PLACEHOLDER" },
      { status: "assumed", expected: "PLACEHOLDER" },
      { status: "disputed", expected: "PLACEHOLDER" },
      { status: "superseded", expected: "PLACEHOLDER" },
      { status: "rejected", expected: "PLACEHOLDER" },
      { status: "revoked", expected: "PLACEHOLDER" },
    ];

    expect(table).toHaveLength(9);
    for (const { status, expected } of table) {
      expect(projectTrustStatusToDataConfidence(status)).toBe(expected);
    }
  });

  it("a Camp with a disputed Session claim has its own ClaimGroupRollup capped below 'verified' (deriveCampVerification's sessions-verified ceiling via applyDerivation)", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(
      testPool,
      [{ label: "Session A", startDate: "2026-09-14", endDate: "2026-09-18", startTime: "09:00", endTime: "15:00" }],
      { name: "AC7 disputed-session-caps-camp Camp" },
    );
    const scheduleId = scheduleIds[0]!;
    const now = new Date().toISOString();

    for (const field of VERIFIED_CAMP_FIELDS) {
      await verifyCampField(pool, campId, field, now);
    }

    // `time` is fully, genuinely verified (real per-Session evidence) — the
    // ONLY reason this Camp's rollup won't reach `verified` is the disputed
    // `dates` claim below, not a missing/incomplete `time` claim.
    const timeClaimId = sessionClaimId(scheduleId, "time");
    await persistClaim(pool, {
      id: timeClaimId,
      subjectType: SESSION_SUBJECT_TYPE,
      subjectId: scheduleId,
      facet: campfitSessionVocabulary.facet,
      claimType: campfitSessionVocabulary.claimTypes.time,
      fieldOrBehavior: "time",
    });
    const timeEvidenceIds: string[] = [];
    for (const evidenceType of ["crawl_observation", "human_attestation"] as const) {
      const evidenceId = `${timeClaimId}.evidence.${evidenceType}`;
      await appendEvidence(pool, {
        id: evidenceId,
        claimId: timeClaimId,
        evidenceType,
        method: evidenceType === "crawl_observation" ? "observation" : "attestation",
        sourceRef: "https://example.com/camp",
        excerptOrSummary: "Session A time sourced from the provider's own schedule listing.",
        observedAt: now,
        collectedBy: evidenceType === "crawl_observation" ? "campfit-crawler" : "reviewer@campfit.test",
      });
      timeEvidenceIds.push(evidenceId);
    }
    await appendEvent(pool, {
      id: `${timeClaimId}.event.verified`,
      claimId: timeClaimId,
      status: "verified",
      type: "verification",
      actor: "reviewer@campfit.test",
      method: "attestation",
      evidenceIds: timeEvidenceIds,
      createdAt: now,
    });

    // `dates` is disputed: a Parent Correction (or re-Crawl) contradicted the
    // provider's own listing — a `disputed` status is a TERMINAL event status
    // (status-taxonomy.ts) that `deriveTrustStatus` returns directly,
    // regardless of the claim's evidence completeness.
    const datesClaimId = sessionClaimId(scheduleId, "dates");
    await persistClaim(pool, {
      id: datesClaimId,
      subjectType: SESSION_SUBJECT_TYPE,
      subjectId: scheduleId,
      facet: campfitSessionVocabulary.facet,
      claimType: campfitSessionVocabulary.claimTypes.dates,
      fieldOrBehavior: "dates",
    });
    const datesEvidenceId = `${datesClaimId}.evidence.parent-correction`;
    await appendEvidence(pool, {
      id: datesEvidenceId,
      claimId: datesClaimId,
      evidenceType: "source_excerpt",
      method: "observation",
      sourceRef: "parent-correction:reviewer@campfit.test",
      excerptOrSummary: "A parent reported Session A's dates no longer match the provider's page.",
      observedAt: now,
      collectedBy: "reviewer@campfit.test",
    });
    await appendEvent(pool, {
      id: `${datesClaimId}.event.disputed`,
      claimId: datesClaimId,
      status: "disputed",
      // `SurfaceVerificationEventType` (migration 012) only has 2 members,
      // 'verification'/'invalidation' \u2014 there is no dedicated 'dispute'
      // type. `deriveTrustStatus` (status.js) returns a TERMINAL event status
      // like 'disputed' as-is regardless of which of the 2 types is used, so
      // 'verification' (a plain ledger entry recording the dispute) is used
      // here rather than 'invalidation' (reserved for the stale/revoked
      // FieldAttestation mapping's semantics, per claim-store-backfill.ts).
      type: "verification",
      actor: "reviewer@campfit.test",
      method: "review",
      evidenceIds: [datesEvidenceId],
      createdAt: now,
    });

    const sessionRollup = await deriveSessionVerification(scheduleId);
    const datesRequirement = sessionRollup.requirements.find((requirement) => requirement.id === "dates")!;
    expect(datesRequirement.status).toBe("disputed");
    // The Session's own rollup is capped to the weakest member — disputed,
    // not the strongest (verified `time`) or a silent "verified".
    expect(sessionRollup.status).toBe("disputed");

    const campRollup = await deriveCampVerification(campId);
    const sessionsRequirement = campRollup.requirements.find((requirement) => requirement.id === "sessions-verified")!;
    expect(sessionsRequirement.status).toBe("disputed");
    expect(campRollup.status).toBe("disputed");
    expect(campRollup.status).not.toBe("verified");

    // The Camp-level cache reflects this honestly too: `disputed` maps to
    // `PLACEHOLDER` (projectTrustStatusToDataConfidence's default bucket),
    // never `VERIFIED`.
    const cacheResult = await refreshCampVerificationCache(campId);
    expect(cacheResult.dataConfidence).toBe("PLACEHOLDER");
  });
});

/**
 * Direct tests of `lib/admin/verification-authority.ts`'s own public
 * interface (Wave 3's "the module's core" task) — narrower and more direct
 * than AC5/AC7's full-rollup scenarios above, but enough to prove the
 * module's three load-bearing behaviors: a fully-verified Camp evaluates
 * VERIFIED end-to-end through `refreshCampVerificationCache`; a Session
 * missing real evidence surfaces an explicit Verification Gap
 * (`missingClaimIds`), never a silently-verified session; and an archived
 * Session's already-persisted Claims receive a `revoked` VerificationEvent
 * via `revokeArchivedSessionClaims`.
 */
describe("verification-authority.ts (Wave 3 core)", () => {
  it("a Camp whose 8 field Claims are all verified (and has no Sessions) evaluates VERIFIED end-to-end through refreshCampVerificationCache", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "Wave3 fully-verified Camp" });
    const now = new Date().toISOString();

    for (const field of VERIFIED_CAMP_FIELDS) {
      await verifyCampField(pool, campId, field, now);
    }

    const rollup = await deriveCampVerification(campId);
    expect(rollup.status).toBe("verified");
    expect(rollup.requirements.map((requirement) => requirement.id).sort()).toEqual(
      [...VERIFIED_CAMP_FIELDS, "sessions-verified"].sort(),
    );
    // No Sessions at all — sessions-verified has nothing to fail on, so it is
    // trivially verified (a deliberate default; see verification-authority.ts's
    // header comment).
    const sessionsRequirement = rollup.requirements.find((requirement) => requirement.id === "sessions-verified")!;
    expect(sessionsRequirement.status).toBe("verified");

    const cacheResult = await refreshCampVerificationCache(campId);
    expect(cacheResult.dataConfidence).toBe("VERIFIED");

    const campRow = await testPool.query<{ dataConfidence: string; lastVerifiedAt: string | null }>(
      `SELECT "dataConfidence", "lastVerifiedAt" FROM "Camp" WHERE id = $1`,
      [campId],
    );
    expect(campRow.rows[0]!.dataConfidence).toBe("VERIFIED");
    expect(campRow.rows[0]!.lastVerifiedAt).not.toBeNull();
  });

  it("a Session missing real dates/time evidence surfaces an explicit Verification Gap (missingClaimIds), not a silently-verified Session — while its inherited attributes correctly fall back to the verified Camp-level claims", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const { campId, scheduleIds } = await seedCampWithSchedules(
      testPool,
      [{ label: "Session A", startDate: "2026-08-03", endDate: "2026-08-07" }],
      { name: "Wave3 gap Camp" },
    );
    const scheduleId = scheduleIds[0]!;
    const now = new Date().toISOString();

    for (const field of VERIFIED_CAMP_FIELDS) {
      await verifyCampField(pool, campId, field, now);
    }
    // Deliberately: no Claim/Evidence is ever persisted for this Session's
    // `dates`/`time` — proving the gap surfaces explicitly rather than
    // defaulting to a false "verified".

    const sessionRollup = await deriveSessionVerification(scheduleId);
    const datesRequirement = sessionRollup.requirements.find((requirement) => requirement.id === "dates")!;
    const timeRequirement = sessionRollup.requirements.find((requirement) => requirement.id === "time")!;
    expect(datesRequirement.status).toBe("unknown");
    expect(datesRequirement.missingClaimIds).toEqual([sessionClaimId(scheduleId, "dates")]);
    expect(timeRequirement.status).toBe("unknown");
    expect(timeRequirement.missingClaimIds).toEqual([sessionClaimId(scheduleId, "time")]);

    // Inherited attributes (decision 4) fall back to the verified Camp-level
    // claims — a documented fallback, not the same kind of gap as above.
    const eligibilityRequirement = sessionRollup.requirements.find((requirement) => requirement.id === "eligibility")!;
    expect(eligibilityRequirement.status).toBe("verified");
    expect(eligibilityRequirement.missingClaimIds).toEqual([]);

    // The Session as a whole is therefore NOT verified — capped by the
    // dates/time gaps, not silently reported as verified.
    expect(sessionRollup.status).not.toBe("verified");

    // The Camp's own sessions-verified requirement inherits this Session's
    // gap through applyDerivation's ceiling — also not silently verified.
    const campRollup = await deriveCampVerification(campId);
    const sessionsRequirement = campRollup.requirements.find((requirement) => requirement.id === "sessions-verified")!;
    expect(sessionsRequirement.status).not.toBe("verified");
    expect(campRollup.status).not.toBe("verified");
  });

  it("revokeArchivedSessionClaims appends a 'revoked' VerificationEvent for every already-persisted Claim belonging to an archived Session, and is a safe no-op when no Claims were ever persisted for it", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const { scheduleIds } = await seedCampWithSchedules(
      testPool,
      [{ label: "Session A", startDate: "2026-09-01", endDate: "2026-09-05" }],
      { name: "Wave3 revoke Camp" },
    );
    const scheduleId = scheduleIds[0]!;
    const now = new Date().toISOString();

    const claimId = sessionClaimId(scheduleId, "dates");
    await persistClaim(pool, {
      id: claimId,
      subjectType: SESSION_SUBJECT_TYPE,
      subjectId: scheduleId,
      facet: campfitSessionVocabulary.facet,
      claimType: campfitSessionVocabulary.claimTypes.dates,
      fieldOrBehavior: "dates",
    });
    await appendEvidence(pool, {
      id: `${claimId}.evidence.crawl_observation`,
      claimId,
      evidenceType: "crawl_observation",
      method: "observation",
      sourceRef: "https://example.com/camp",
      excerptOrSummary: "Session A dates sourced from the provider's own schedule listing.",
      observedAt: now,
      collectedBy: "campfit-crawler",
    });

    // Simulates `applyScheduleReconciliation`'s `orphaned` output: this
    // Session's row is archived (soft-archive, not deleted) because a newer
    // Review's incoming schedules snapshot no longer includes it.
    await testPool.query(`UPDATE "CampSchedule" SET "archivedAt" = now() WHERE id = $1`, [scheduleId]);

    const orphaned: ExistingScheduleRow[] = [
      { id: scheduleId, label: "Session A", startDate: "2026-09-01", endDate: "2026-09-05" },
    ];
    const events = await revokeArchivedSessionClaims({ orphaned, actor: "reviewer@campfit.test", method: "review-apply" });

    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("revoked");
    expect(events[0]!.claimId).toBe(claimId);

    const eventRows = await testPool.query<{ claimId: string; status: string }>(
      `SELECT "claimId", status FROM "SurfaceVerificationEvent" WHERE "claimId" = $1 AND status = 'revoked'`,
      [claimId],
    );
    expect(eventRows.rows).toEqual([{ claimId, status: "revoked" }]);

    // A Session archived with no Claims ever persisted for it is a safe
    // no-op — nothing to revoke, not a thrown error or a silent failure.
    const noClaimsEvents = await revokeArchivedSessionClaims({
      orphaned: [{ id: "nonexistent-schedule-id", label: "Ghost Session", startDate: null, endDate: null }],
      actor: "reviewer@campfit.test",
      method: "review-apply",
    });
    expect(noClaimsEvents).toEqual([]);
  });
});

/**
 * V1 fix (CRITICAL, review-code.md) — `claim-store.ts`'s `save()` implements
 * "whole-subject-store replace" semantics: any Claim row for the subject not
 * in the given store's `claims` is DELETEd, and migration 012's `ON DELETE
 * CASCADE` then silently destroys that Claim's entire Evidence/
 * VerificationEvent history along with it. Before this fix, two concurrent
 * writers touching the SAME Camp/Session subject (e.g. two admins attesting
 * different fields on the same Camp at the same time — `mark_verified`,
 * `/attest`, `addFieldAttestation`, and `review-apply.ts` all share one
 * subject per Camp) could each `load()` before the other's `save()`
 * committed, so whichever committed second would compute its `keptIds` from
 * a STALE snapshot and delete the other's brand-new Claim — cascading away
 * its Evidence/VerificationEvent rows with zero error, zero retry signal.
 * `withSubjectLock` (a `pg_advisory_xact_lock` keyed on `(subjectType,
 * subjectId)`, held for the whole `load()`->modify->`save()` round trip)
 * closes this: this test proves it by racing two real, concurrent
 * `recordEvidence` calls — attesting two DIFFERENT fields on the SAME Camp
 * subject at the same time, via `Promise.allSettled` (mirroring
 * `review-apply.test.ts`'s real-concurrency pattern) — and asserting BOTH
 * Claims and BOTH of their Evidence/VerificationEvent rows survive. Without
 * the fix this is a genuine (if timing-dependent) data-loss race, not merely
 * a theoretical one; with the fix it is deterministic every run, since the
 * lock fully serializes the two `persistClaim` calls this exercises
 * underneath `recordEvidence`.
 */
describe("V1 concurrency fix — claim-store.ts's per-subject advisory lock", () => {
  it("two concurrent recordEvidence calls attesting DIFFERENT fields on the SAME Camp subject both survive intact — neither Claim's Evidence/VerificationEvent rows are lost to the other's save()", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "V1 concurrency Camp" });
    const now = new Date().toISOString();

    const fields = ["description", "campType"] as const;
    const claimIds = fields.map((field) => campCanonicalClaimId(campId, field));

    async function attestField(field: (typeof fields)[number]): Promise<void> {
      const claimId = campCanonicalClaimId(campId, field);
      const claim: ClaimDefinitionDraft = {
        id: claimId,
        subjectType: campfitVocabulary.subjectType,
        subjectId: campId,
        facet: campfitVocabulary.facet,
        claimType: campfitVocabulary.claimTypes.scalarField,
        fieldOrBehavior: field,
      };
      const evidence = buildHumanAttestationEvidence({
        subject: { claimId, sourceRef: "admin:reviewer@campfit.test" },
        actor: { id: "reviewer@campfit.test" },
        attestedAt: now,
        contentHash: `sha256-concurrency-test-${field}`,
      });
      await recordEvidence(pool, { claim, evidence });
    }

    // Real concurrency: both calls issue their load()/save() round trips on
    // separate pool connections at (as close to) the same time as possible —
    // Promise.allSettled (not sequential awaits) so neither is accidentally
    // serialized by test code itself, only by withSubjectLock's own lock.
    const outcomes = await Promise.allSettled(fields.map((field) => attestField(field)));

    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toEqual([]);
    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);

    // Both Claims exist — neither was cascade-deleted by the other's stale save().
    const claimRows = await testPool.query<{ id: string }>(
      `SELECT id FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY id`,
      [campId],
    );
    expect(claimRows.rows.map((row) => row.id).sort()).toEqual([...claimIds].sort());

    // Both Evidence rows exist — the CRITICAL finding's exact failure mode
    // (a stale delete cascading away a sibling claim's Evidence/Event rows).
    const evidenceRows = await testPool.query<{ claimId: string }>(
      `SELECT "claimId" FROM "SurfaceEvidence" WHERE "claimId" = ANY($1)`,
      [claimIds],
    );
    expect(evidenceRows.rows).toHaveLength(claimIds.length);

    const eventRows = await testPool.query<{ claimId: string }>(
      `SELECT "claimId" FROM "SurfaceVerificationEvent" WHERE "claimId" = ANY($1)`,
      [claimIds],
    );
    expect(eventRows.rows).toHaveLength(claimIds.length);
  });

  it("two concurrent persistClaim calls for claims with DIFFERENT ids on the SAME subject, issued back-to-back with no await between them, both persist — proves the lock serializes rather than deadlocking or dropping either writer", async () => {
    const testPool = getTestPool();
    const pool = getProductionPool();
    const campId = await insertCamp(testPool, { name: "V1 concurrency persistClaim Camp" });

    const claimIdA = campCanonicalClaimId(campId, "city");
    const claimIdB = campCanonicalClaimId(campId, "websiteUrl");

    const [resultA, resultB] = await Promise.all([
      persistClaim(pool, {
        id: claimIdA,
        subjectType: campfitVocabulary.subjectType,
        subjectId: campId,
        facet: campfitVocabulary.facet,
        claimType: campfitVocabulary.claimTypes.scalarField,
        fieldOrBehavior: "city",
      }),
      persistClaim(pool, {
        id: claimIdB,
        subjectType: campfitVocabulary.subjectType,
        subjectId: campId,
        facet: campfitVocabulary.facet,
        claimType: campfitVocabulary.claimTypes.scalarField,
        fieldOrBehavior: "websiteUrl",
      }),
    ]);

    expect(resultA.id).toBe(claimIdA);
    expect(resultB.id).toBe(claimIdB);

    const claimRows = await testPool.query<{ id: string }>(
      `SELECT id FROM "SurfaceClaimDefinition" WHERE "subjectId" = $1 ORDER BY id`,
      [campId],
    );
    expect(claimRows.rows.map((row) => row.id).sort()).toEqual([claimIdA, claimIdB].sort());
  });
});
