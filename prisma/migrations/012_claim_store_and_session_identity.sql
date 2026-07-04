-- Camp Fit Migration 012: ClaimStore materialization + stable Session identity
--
-- New tables normalize @kontourai/surface's typed shapes 1:1 into Postgres
-- (one row per ClaimDefinition, one row per VerificationPolicy, one row per
-- Evidence, one row per VerificationEvent (append-only), one row per
-- ClaimGroup) so `lib/admin/claim-store.ts` (a later wave) can reconstruct
-- in-memory objects satisfying Surface's exact TS interfaces at read time,
-- rather than persisting one big JSONB blob mirroring the file-based
-- ClaimStore/TrustBundle shapes. See the "ClaimStore Postgres
-- materialization" narrative in
-- .kontourai/flow-agents/verification-authority/verification-authority--deliver-plan.md
-- for the full rationale.
--
-- Also adds the two additive columns backing stable CampSchedule ("Session")
-- identity and per-schedule pricing (decision 5 + decision 4's price-options
-- evidence path): "CampSchedule"."archivedAt" (soft-archive instead of
-- delete-and-recreate on a relation-field diff) and
-- "CampPricing"."scheduleId" (nullable FK, existing rows stay NULL /
-- camp-wide, zero behavior change).
--
-- Idempotent throughout (`CREATE TYPE IF NOT EXISTS` via the DO $$ guard
-- established in migration 005, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX
-- IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — matches migration 011's
-- idiom exactly. Safe to re-run and safe to apply to production once
-- ratified for real deploy (see the plan's "Sandbox mode" note: in this
-- delivery, this migration only runs against the throwaway
-- TEST_DATABASE_URL Postgres via scripts/test-db-reset.ts).

-- ─── Enums (closed vocabularies Surface's kernel defines) ─────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceImpactLevel') THEN
    CREATE TYPE "SurfaceImpactLevel" AS ENUM ('low', 'medium', 'high', 'critical');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceMateriality') THEN
    CREATE TYPE "SurfaceMateriality" AS ENUM ('low', 'medium', 'high');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceTrustStatus') THEN
    CREATE TYPE "SurfaceTrustStatus" AS ENUM (
      'unknown', 'proposed', 'assumed', 'verified', 'stale', 'disputed',
      'superseded', 'rejected', 'revoked'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceEvidenceType') THEN
    CREATE TYPE "SurfaceEvidenceType" AS ENUM (
      'source_excerpt', 'test_output', 'human_attestation', 'attestation',
      'calculation_trace', 'document_citation', 'crawl_observation', 'policy_rule'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceEvidenceMethod') THEN
    CREATE TYPE "SurfaceEvidenceMethod" AS ENUM (
      'observation', 'extraction', 'validation', 'corroboration',
      'attestation', 'auditability', 'anchoring', 'monitoring'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceVerificationEventType') THEN
    CREATE TYPE "SurfaceVerificationEventType" AS ENUM ('verification', 'invalidation');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SurfaceClaimGroupKind') THEN
    CREATE TYPE "SurfaceClaimGroupKind" AS ENUM ('claimGroup', 'framework', 'requirement-set');
  END IF;
END $$;

-- ─── SurfaceVerificationPolicy ─────────────────────────────────────────────
-- Mirrors Surface's `VerificationPolicy` interface (types.d.ts). Created
-- before "SurfaceClaimDefinition" so the latter's optional
-- "verificationPolicyId" FK can reference it inline.

CREATE TABLE IF NOT EXISTS "SurfaceVerificationPolicy" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "claimType"          TEXT NOT NULL,
  "parentType"         TEXT,
  "requiredEvidence"   TEXT[] NOT NULL DEFAULT '{}',
  "acceptanceCriteria" TEXT[] NOT NULL DEFAULT '{}',
  "reviewAuthority"    TEXT NOT NULL,
  "validityRule"       JSONB NOT NULL,
  "stalenessTriggers"  TEXT[] NOT NULL DEFAULT '{}',
  "conflictRules"      TEXT[] NOT NULL DEFAULT '{}',
  "impactLevel"        "SurfaceImpactLevel" NOT NULL,

  CONSTRAINT "SurfaceVerificationPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SurfaceVerificationPolicy_claimType_idx"
  ON "SurfaceVerificationPolicy"("claimType");

-- ─── SurfaceClaimDefinition ─────────────────────────────────────────────
-- Mirrors Surface's `ClaimDefinition` interface — identity only (no
-- value/status/evidence/events; those live in SurfaceEvidence/
-- SurfaceVerificationEvent below and are folded at read time).

CREATE TABLE IF NOT EXISTS "SurfaceClaimDefinition" (
  "id"                   TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "subjectType"          TEXT NOT NULL,
  "subjectId"            TEXT NOT NULL,
  "facet"                TEXT,
  "claimType"            TEXT NOT NULL,
  "fieldOrBehavior"      TEXT NOT NULL,
  "qualifiers"           JSONB,
  "impactLevel"          "SurfaceImpactLevel",
  "materiality"          "SurfaceMateriality",
  "verificationPolicyId" TEXT,
  "metadata"             JSONB,
  "createdAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "SurfaceClaimDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SurfaceClaimDefinition_verificationPolicyId_fkey"
    FOREIGN KEY ("verificationPolicyId") REFERENCES "SurfaceVerificationPolicy"("id")
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "SurfaceClaimDefinition_subject_idx"
  ON "SurfaceClaimDefinition"("subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "SurfaceClaimDefinition_claimType_idx"
  ON "SurfaceClaimDefinition"("claimType");
CREATE INDEX IF NOT EXISTS "SurfaceClaimDefinition_verificationPolicyId_idx"
  ON "SurfaceClaimDefinition"("verificationPolicyId");

-- ─── SurfaceEvidence ─────────────────────────────────────────────────────
-- Append-only: mirrors Surface's `Evidence` interface. No UPDATE/DELETE path
-- is exposed by lib/admin/claim-store.ts (a later wave) — corrections are
-- new Evidence rows, not mutations of existing ones.

CREATE TABLE IF NOT EXISTS "SurfaceEvidence" (
  "id"               TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "claimId"          TEXT NOT NULL,
  "evidenceType"     "SurfaceEvidenceType" NOT NULL,
  "method"           "SurfaceEvidenceMethod" NOT NULL,
  "sourceRef"        TEXT NOT NULL,
  "sourceLocator"    TEXT,
  "excerptOrSummary" TEXT NOT NULL,
  "observedAt"       TIMESTAMPTZ NOT NULL,
  "collectedBy"      TEXT NOT NULL,
  "integrityRef"     TEXT,
  "metadata"         JSONB,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "SurfaceEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SurfaceEvidence_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "SurfaceClaimDefinition"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "SurfaceEvidence_claimId_idx" ON "SurfaceEvidence"("claimId");

-- ─── SurfaceVerificationEvent ────────────────────────────────────────────
-- Append-only: mirrors Surface's `VerificationEvent` interface (the
-- status-bearing ledger `foldClaim`/`deriveClaimStatus` evaluate). Note
-- `method` here is Surface's free-text `string` (not the `EvidenceMethod`
-- closed vocabulary used by SurfaceEvidence.method above).

CREATE TABLE IF NOT EXISTS "SurfaceVerificationEvent" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "claimId"         TEXT NOT NULL,
  "status"          "SurfaceTrustStatus" NOT NULL,
  "type"            "SurfaceVerificationEventType",
  "actor"           TEXT NOT NULL,
  "method"          TEXT NOT NULL,
  "evidenceIds"     TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "verifiedAt"      TIMESTAMPTZ,
  "notes"           TEXT,
  "resolvesDispute" BOOLEAN,
  "authorityRef"    TEXT,

  CONSTRAINT "SurfaceVerificationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SurfaceVerificationEvent_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "SurfaceClaimDefinition"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "SurfaceVerificationEvent_claimId_idx"
  ON "SurfaceVerificationEvent"("claimId");
CREATE INDEX IF NOT EXISTS "SurfaceVerificationEvent_status_idx"
  ON "SurfaceVerificationEvent"("status");

-- ─── SurfaceClaimGroup ───────────────────────────────────────────────────
-- Mirrors Surface's `ClaimGroup` interface (Verified Camp / Verified
-- Session claim sets land here as policy data in a later wave).

CREATE TABLE IF NOT EXISTS "SurfaceClaimGroup" (
  "id"           TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "title"        TEXT NOT NULL,
  "kind"         "SurfaceClaimGroupKind" NOT NULL,
  "requirements" JSONB,
  "rollupPolicy" JSONB,
  "metadata"     JSONB,

  CONSTRAINT "SurfaceClaimGroup_pkey" PRIMARY KEY ("id")
);

-- ─── Stable Session identity + per-schedule pricing ─────────────────────
-- Both additive/nullable; existing rows are unaffected (decision 5's
-- soft-archive-instead-of-delete matcher, decision 4's price-options
-- evidence path). Idempotent — matches migration 011's idiom.

ALTER TABLE "CampSchedule"
  ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMPTZ;

ALTER TABLE "CampPricing"
  ADD COLUMN IF NOT EXISTS "scheduleId" TEXT REFERENCES "CampSchedule"("id");
