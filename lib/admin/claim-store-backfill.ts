/**
 * lib/admin/claim-store-backfill.ts — one-time, idempotent projection of the
 * two legacy trust-provenance stores into migration 012's ClaimStore tables
 * (`lib/admin/claim-store.ts`), per this slice's AC3 ("cutover-with-backfill":
 * both legacy stores project into the ClaimStore; legacy stays readable for
 * rollback — see `.kontourai/flow-agents/verification-authority/
 * verification-authority--deliver-plan.md`, Wave 3 "Backfill script +
 * module").
 *
 * Legacy sources projected (both CAMP-scoped, both read-only — this module
 * never writes back to either):
 *
 * 1. `Camp.fieldSources` (JSONB, `prisma/migrations/002_provider_and_field_
 *    sources.sql`): one entry per field, LAST-WRITE-WINS (`review-apply.ts`'s
 *    `applyScalarField`/`applyRelationField` and the `/attest` route both
 *    `COALESCE(...) || $patch::jsonb` merge new keys over old — there is no
 *    history, only the current source). Shape actually written (a superset of
 *    `lib/types.ts`'s `FieldSource`, which is missing `attestedBy`/`notes`):
 *    `{ excerpt: string | null, sourceUrl: string, approvedAt: string,
 *    attestedBy?: string, notes?: string }`. Because there is exactly one
 *    entry per field, this projects to exactly one deterministic Evidence +
 *    one deterministic VerificationEvent per field.
 * 2. `FieldAttestation` (`prisma/migrations/005_admin_trust_platform.sql`):
 *    APPEND-ONLY — a Camp field can accumulate many rows over time (each a
 *    distinct real-world attestation/re-check event), so each row projects to
 *    its OWN Evidence + VerificationEvent, keyed by the row's own `id`
 *    (deterministic and stable across backfill re-runs).
 *
 * Scope: only `entityType: 'CAMP'` rows, and only the 8 `VERIFIED_CAMP_
 * FIELDS` (`lib/admin/verification-policy.ts`) — the only fields with a
 * ratified claim-identity/claim-type/policy convention in this slice
 * (`campCanonicalClaimId`, `campfitVocabulary.claimTypes.scalarField`/
 * `repeatedField`, `policy.camp.scalar-field`/`policy.camp.repeated-field`).
 * `PROVIDER`/`PERSON` `FieldAttestation` rows and non-canonical `fieldKey`
 * values (e.g. `schedules`, `ageGroups:<id>`, `pricing:<id>`, `provider`,
 * `people` — see `app/api/admin/entities/[entityType]/[entityId]/route.ts`'s
 * `ENTITY_ATTESTATION_FIELDS`) have no Surface claim subject/type/policy
 * defined anywhere in this slice; projecting them would mean inventing new
 * claim vocabulary outside this delivery's ratified decisions
 * (`docs/decisions/verified-camp-claim-set.md`). Skipped and counted
 * (`BackfillSummary.fieldSourcesSkipped`/`fieldAttestationsSkipped`), never
 * silently dropped — a future slice that ratifies claim vocabulary for those
 * fields can extend this module's scope.
 *
 * `Claim.value`/`FieldAttestation.valueSnapshot` are not projected anywhere:
 * `claim-store.ts`'s header comment (gap 5) already documents that Surface's
 * `Evidence`/`VerificationEvent` have no generic "asserted value" channel and
 * that `loadClaimBundle` always reconstructs `value: undefined` — there is
 * nowhere on the ClaimStore side to put it. The live application record
 * (`Camp`'s own column) remains the source of truth for the actual value,
 * exactly as `claim-store.ts` already establishes.
 *
 * Idempotency: `persistClaim` (`claim-store.ts`) already upserts
 * (`ON CONFLICT ("id") DO UPDATE`), so re-running never duplicates a Claim
 * row. `appendEvidence`/`appendEvent` are deliberately append-only INSERTs
 * with no `ON CONFLICT` path (migration 012's own design — corrections are
 * new rows, never mutations), so THIS module keys every Evidence/
 * VerificationEvent id deterministically off the legacy row it came from and
 * checks for that id's existence before inserting (`rowExists` below) —
 * matching this task's "checks for an existing claim/evidence before
 * inserting, keyed on the same `campCanonicalClaimId` convention" spec.
 */
import type { Pool } from 'pg';

import {
  type ClaimDefinitionDraft,
  type Evidence,
  type EvidenceMethod,
  type EvidenceType,
  type VerificationEvent,
  type VerificationEventType,
} from '@kontourai/surface';

import type { DataConfidence, FieldAttestation } from '@/lib/types';
import { appendEvent, appendEvidence, persistClaim, upsertPolicy } from './claim-store';
import { campCanonicalClaimId } from './trust-projection';
import { deriveCampVerification } from './verification-authority';
import {
  projectTrustStatusToDataConfidence,
  VERIFIED_CAMP_FIELDS,
  VERIFIED_CAMP_SESSION_POLICIES,
  type VerifiedCampField,
} from './verification-policy';
import { campfitVocabulary } from '../trust-vocabulary';

/** The two `VERIFIED_CAMP_FIELDS` whose claim type is `repeatedField`, not `scalarField`. */
const REPEATED_CAMP_FIELDS: ReadonlySet<string> = new Set<VerifiedCampField>(['ageGroups', 'pricing']);

const CAMP_SCALAR_POLICY_ID = 'policy.camp.scalar-field';
const CAMP_REPEATED_POLICY_ID = 'policy.camp.repeated-field';

/** Shape actually written by `review-apply.ts`/`/attest` (a superset of `lib/types.ts`'s `FieldSource`). */
interface LegacyFieldSource {
  excerpt: string | null;
  sourceUrl: string;
  approvedAt: string;
  attestedBy?: string;
  notes?: string;
}

export interface BackfillSummary {
  dryRun: boolean;
  campsScanned: number;
  fieldSourcesProjected: number;
  fieldSourcesSkipped: number;
  fieldAttestationRowsProjected: number;
  fieldAttestationRowsSkipped: number;
  evidenceInserted: number;
  eventsInserted: number;
}

function isVerifiedCampField(field: string): field is VerifiedCampField {
  return (VERIFIED_CAMP_FIELDS as readonly string[]).includes(field);
}

function policyIdForField(field: VerifiedCampField): string {
  return REPEATED_CAMP_FIELDS.has(field) ? CAMP_REPEATED_POLICY_ID : CAMP_SCALAR_POLICY_ID;
}

function claimTypeForField(field: VerifiedCampField): string {
  return REPEATED_CAMP_FIELDS.has(field)
    ? campfitVocabulary.claimTypes.repeatedField
    : campfitVocabulary.claimTypes.scalarField;
}

function requirePolicy(id: string) {
  const policy = VERIFIED_CAMP_SESSION_POLICIES.find((candidate) => candidate.id === id);
  if (!policy) {
    throw new Error(`Backfill expected VERIFIED_CAMP_SESSION_POLICIES to contain "${id}", but it was not found.`);
  }
  return policy;
}

function claimDraftForField(campId: string, field: VerifiedCampField): ClaimDefinitionDraft {
  return {
    id: campCanonicalClaimId(campId, field),
    subjectType: campfitVocabulary.subjectType,
    subjectId: campId,
    facet: campfitVocabulary.facet,
    claimType: claimTypeForField(field),
    fieldOrBehavior: field,
    verificationPolicyId: policyIdForField(field),
  };
}

async function rowExists(pool: Pool, table: 'SurfaceEvidence' | 'SurfaceVerificationEvent', id: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM "${table}" WHERE "id" = $1`, [id]);
  return rows.length > 0;
}

/**
 * Projects one Camp's one `fieldSources[field]` entry into a deterministic
 * Evidence + VerificationEvent pair. The field's current value is, by
 * definition, the one currently approved/attested — always folds to
 * `'verified'` (there is no stale/invalidated concept in `fieldSources`, only
 * in `FieldAttestation`).
 */
async function projectFieldSource(
  pool: Pool,
  campId: string,
  field: VerifiedCampField,
  source: LegacyFieldSource,
  summary: BackfillSummary,
): Promise<void> {
  const claimId = campCanonicalClaimId(campId, field);
  await persistClaim(pool, claimDraftForField(campId, field));

  const attestedBy = source.attestedBy;
  const evidenceType: EvidenceType = attestedBy ? 'attestation' : 'crawl_observation';
  const method: EvidenceMethod = attestedBy ? 'attestation' : 'observation';
  const collectedBy = attestedBy ?? 'campfit-legacy-backfill';
  const sourceRef = attestedBy ? `admin:${attestedBy}` : source.sourceUrl;

  const evidenceId = `evidence.${claimId}.legacy-field-source`;
  if (!(await rowExists(pool, 'SurfaceEvidence', evidenceId))) {
    const evidence: Evidence = {
      id: evidenceId,
      claimId,
      evidenceType,
      method,
      sourceRef,
      excerptOrSummary: source.excerpt ?? source.notes ?? 'Legacy fieldSources entry with no recorded excerpt.',
      observedAt: source.approvedAt,
      collectedBy,
    };
    await appendEvidence(pool, evidence);
    summary.evidenceInserted++;
  }

  const eventId = `event.${claimId}.legacy-field-source`;
  if (!(await rowExists(pool, 'SurfaceVerificationEvent', eventId))) {
    const event: VerificationEvent = {
      id: eventId,
      claimId,
      status: 'verified',
      type: 'verification',
      actor: collectedBy,
      method,
      evidenceIds: [evidenceId],
      createdAt: source.approvedAt,
      verifiedAt: source.approvedAt,
    };
    await appendEvent(pool, event);
    summary.eventsInserted++;
  }
}

/** `FieldAttestation.status` -> the `{TrustStatus, VerificationEventType}` pair the plan's mapping calls for. */
function statusForAttestation(status: FieldAttestation['status']): { status: VerificationEvent['status']; type: VerificationEventType } {
  switch (status) {
    case 'ACTIVE':
      return { status: 'verified', type: 'verification' };
    case 'STALE':
      // Surface's own VerificationEventType doc comment: "invalidation marks
      // a ledger line that explicitly revokes/stales a previously-good claim
      // (use with status 'revoked' or 'stale')".
      return { status: 'stale', type: 'invalidation' };
    case 'INVALIDATED':
      return { status: 'revoked', type: 'invalidation' };
  }
}

/**
 * Projects one `FieldAttestation` row into a deterministic Evidence +
 * VerificationEvent pair, keyed by the row's own `id` (append-only source —
 * every row is its own event, unlike `fieldSources`' single-current-value
 * shape).
 */
async function projectFieldAttestation(pool: Pool, row: FieldAttestation, summary: BackfillSummary): Promise<void> {
  const field = row.fieldKey as VerifiedCampField;
  const claimId = campCanonicalClaimId(row.entityId, field);
  await persistClaim(pool, claimDraftForField(row.entityId, field));

  const approvedBy = row.approvedBy ?? undefined;
  const collectedBy = approvedBy ?? 'campfit-legacy-backfill';

  const evidenceId = `evidence.${claimId}.field-attestation.${row.id}`;
  if (!(await rowExists(pool, 'SurfaceEvidence', evidenceId))) {
    const evidence: Evidence = {
      id: evidenceId,
      claimId,
      evidenceType: 'attestation',
      method: 'attestation',
      sourceRef: row.sourceUrl ?? `admin:${collectedBy}`,
      excerptOrSummary: row.excerpt ?? row.notes ?? 'Legacy FieldAttestation row with no recorded excerpt.',
      observedAt: row.observedAt,
      collectedBy,
    };
    await appendEvidence(pool, evidence);
    summary.evidenceInserted++;
  }

  const eventId = `event.${claimId}.field-attestation.${row.id}`;
  if (!(await rowExists(pool, 'SurfaceVerificationEvent', eventId))) {
    const { status, type } = statusForAttestation(row.status);
    const verifiedAt = row.status === 'ACTIVE' ? (row.approvedAt ?? row.observedAt) : undefined;
    const event: VerificationEvent = {
      id: eventId,
      claimId,
      status,
      type,
      actor: collectedBy,
      method: 'attestation',
      evidenceIds: [evidenceId],
      createdAt: row.approvedAt ?? row.observedAt,
      ...(verifiedAt ? { verifiedAt } : {}),
      ...(row.invalidationReason || row.notes ? { notes: row.invalidationReason ?? row.notes ?? undefined } : {}),
    };
    await appendEvent(pool, event);
    summary.eventsInserted++;
  }
}

/**
 * Reads every Camp's `fieldSources` + every `FieldAttestation` row and
 * projects each into the ClaimStore (see this module's header comment for
 * the full mapping/scope). `dryRun: true` reads and counts what WOULD be
 * projected without calling any of `claim-store.ts`'s write functions (AC3).
 * Safe to call repeatedly (see header comment's "Idempotency" section).
 */
export async function backfillClaimStore(pool: Pool, options: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const dryRun = options.dryRun === true;
  const summary: BackfillSummary = {
    dryRun,
    campsScanned: 0,
    fieldSourcesProjected: 0,
    fieldSourcesSkipped: 0,
    fieldAttestationRowsProjected: 0,
    fieldAttestationRowsSkipped: 0,
    evidenceInserted: 0,
    eventsInserted: 0,
  };

  if (!dryRun) {
    // Must exist before any claim referencing them is persisted (persistClaim
    // fails loud on a dangling verificationPolicyId) — upsertPolicy is itself
    // idempotent (ON CONFLICT DO UPDATE), safe to call on every run.
    await upsertPolicy(pool, requirePolicy(CAMP_SCALAR_POLICY_ID));
    await upsertPolicy(pool, requirePolicy(CAMP_REPEATED_POLICY_ID));
  }

  const { rows: camps } = await pool.query<{ id: string; fieldSources: Record<string, LegacyFieldSource> | null }>(
    `SELECT "id", "fieldSources" FROM "Camp" ORDER BY "id"`,
  );
  summary.campsScanned = camps.length;

  for (const camp of camps) {
    const sources = camp.fieldSources ?? {};
    for (const [field, source] of Object.entries(sources)) {
      if (!isVerifiedCampField(field)) {
        summary.fieldSourcesSkipped++;
        continue;
      }
      summary.fieldSourcesProjected++;
      if (dryRun) continue;
      await projectFieldSource(pool, camp.id, field, source, summary);
    }
  }

  const { rows: attestations } = await pool.query<FieldAttestation>(
    `SELECT "id", "entityType", "entityId", "fieldKey", "valueSnapshot", excerpt, "sourceUrl",
            "observedAt", "approvedAt", "approvedBy", status, "lastRecheckedAt", "invalidatedAt",
            "invalidationReason", notes, "createdAt"
       FROM "FieldAttestation"
      ORDER BY "createdAt"`,
  );

  for (const row of attestations) {
    if (row.entityType !== 'CAMP' || !isVerifiedCampField(row.fieldKey)) {
      summary.fieldAttestationRowsSkipped++;
      continue;
    }
    summary.fieldAttestationRowsProjected++;
    if (dryRun) continue;
    await projectFieldAttestation(pool, row, summary);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// V7 fix (MEDIUM, review-code.md) — downgrade-impact report
// ---------------------------------------------------------------------------

export interface CampDowngradeImpact {
  readonly campId: string;
  readonly campName: string;
  /** `Camp.dataConfidence` as it stands right now, before/without this report changing anything (read-only). */
  readonly currentDataConfidence: DataConfidence;
  /** What `refreshCampVerificationCache` would derive for this Camp if run today, given its FULLY-PROJECTED (post-backfill) Claim ledger. */
  readonly derivedDataConfidence: DataConfidence;
}

export interface DowngradeImpactReport {
  /** Every Camp whose CURRENT `dataConfidence` is `'VERIFIED'` — the only status this report checks for a downgrade. */
  readonly campsEvaluated: number;
  /** The subset of `campsEvaluated` whose derived status is NOT `'VERIFIED'` — i.e. would downgrade on the next cache refresh. */
  readonly downgrades: readonly CampDowngradeImpact[];
}

/**
 * The "Semantic finding: legacy-only evidence derives PLACEHOLDER" ops
 * mitigation this slice's docs previously left as advisory-only ("Consider a
 * one-time audit...", `docs/verification-authority.md`'s Ops runbook) — this
 * function makes that audit a real, run-before-deploy tool instead of a
 * suggestion. For every Camp CURRENTLY `dataConfidence: 'VERIFIED'`, derives
 * what `refreshCampVerificationCache` would compute for it TODAY (calling the
 * same `deriveCampVerification`/`projectTrustStatusToDataConfidence` pair
 * that function uses, read-only — this never writes `Camp.dataConfidence`)
 * and reports every Camp where the two disagree, so an operator can see the
 * exact blast radius of a legacy-VERIFIED→PLACEHOLDER downgrade BEFORE
 * deploying this slice, not discover it camp-by-camp afterward. Intended to
 * be called AFTER the backfill has run (dry or real) — a Camp's derived
 * status is only meaningful once its legacy `fieldSources`/`FieldAttestation`
 * history has actually been projected into the ClaimStore for this to read.
 */
export async function buildDowngradeImpactReport(pool: Pool): Promise<DowngradeImpactReport> {
  const { rows } = await pool.query<{ id: string; name: string; dataConfidence: DataConfidence }>(
    `SELECT id, name, "dataConfidence" FROM "Camp" WHERE "dataConfidence" = 'VERIFIED' ORDER BY id`,
  );

  const downgrades: CampDowngradeImpact[] = [];
  for (const row of rows) {
    const rollup = await deriveCampVerification(row.id);
    const derivedDataConfidence = projectTrustStatusToDataConfidence(rollup.status);
    if (derivedDataConfidence !== row.dataConfidence) {
      downgrades.push({
        campId: row.id,
        campName: row.name,
        currentDataConfidence: row.dataConfidence,
        derivedDataConfidence,
      });
    }
  }

  return { campsEvaluated: rows.length, downgrades };
}
