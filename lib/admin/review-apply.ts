/**
 * lib/admin/review-apply.ts — Review Apply module.
 *
 * "Review Apply" (see docs/contexts/data-stewardship/CONTEXT.md) is the
 * transactional step where a resolved Review makes approved Proposed Values
 * the accepted data for a Camp, records provenance for each applied
 * Attribute, and re-evaluates verification. A Review Apply is all-or-nothing
 * for the Attributes it applies; a partial Review Apply (`keepPending: true`)
 * leaves the Proposal in queue for the remaining Attributes.
 *
 * This module is pure Node/pg — it has no dependency on `next/server` or any
 * other HTTP-framework concern, so it is directly importable and callable
 * from a vitest test (or any other caller) without a Next.js runtime.
 * `app/api/admin/review/[id]/approve/route.ts` is the current HTTP caller.
 *
 * `applyProposalReview` (below) is the orchestrating function; it delegates
 * to small private helpers (`deriveDecision`, `lockAndCheckProposal`,
 * `applyScalarField`, `applyRelationField`, `recomputeVerification`,
 * `transitionProposalStatus`, `recordProvenance`) each responsible for one
 * concern of the apply transaction, so a future change to one concern (e.g.
 * adding a new relation type) doesn't require reading/modifying the whole
 * flow.
 */
import type { PoolClient } from 'pg';

import { getPool } from '@/lib/db';
import { getProposal, updateProposalStatus, partialApprove } from './review-repository';
import { writeChangeLogs } from './changelog-repository';
import { recordReviewDecision } from './metrics-repository';
import { isFullyVerified } from './verification';
import { buildCampReviewTrustInput } from './trust-projection';
import { deriveCampApplyFromSurveySession, SurveyReviewApplyError } from './survey-review-apply';
import { getSurveyReviewEvents } from './survey-review-events';
import {
  assertSurveyReviewSessionFreshForProposal,
  getSurveyReviewSessionForProposal,
  SurveyReviewSessionStaleError,
} from './survey-review-sessions';
import type { CampChangeProposal, FieldDiff, ProposedChanges } from './types';

// Re-exported so callers (e.g. the route) can catch these alongside this
// module's own typed errors without a separate import from
// survey-review-sessions.ts / survey-review-apply.ts.
export { SurveyReviewSessionStaleError, SurveyReviewApplyError };

export interface ApplyProposalReviewOptions {
  readonly proposalId: string;
  readonly reviewSessionId: string;
  readonly reviewer: string;
  readonly notes?: string;
  readonly feedbackTags?: string[];
  /** If true: apply the Review's resolved Attributes but leave the Proposal PENDING (partial Review Apply). */
  readonly keepPending?: boolean;
}

export interface ProvenanceError {
  readonly step: 'writeChangeLogs' | 'recordReviewDecision';
  readonly message: string;
}

export interface AppliedReview {
  readonly proposalId: string;
  readonly campId: string;
  readonly status: 'APPROVED' | 'PENDING';
  readonly appliedFields: readonly string[];
  readonly rejectedFields: readonly string[];
  /** True for a partial Review Apply (proposal stays PENDING/in queue). */
  readonly kept: boolean;
  /**
   * Non-fatal post-commit provenance-write failures (writeChangeLogs /
   * recordReviewDecision). The Review Apply itself already committed by the
   * time these run — see step 7 in the module's transaction flow — so a
   * failure here does not roll back the applied Attributes; it is surfaced
   * here instead of being silently swallowed.
   */
  readonly provenanceErrors: readonly ProvenanceError[];
}

export class ReviewApplyProposalNotFoundError extends Error {
  constructor(message = 'Proposal was not found.') {
    super(message);
    this.name = 'ReviewApplyProposalNotFoundError';
  }
}

export class ReviewApplySessionNotFoundError extends Error {
  constructor(message = 'Survey review session was not found for this proposal.') {
    super(message);
    this.name = 'ReviewApplySessionNotFoundError';
  }
}

/**
 * Thrown when the target Proposal's status is no longer PENDING — either at
 * the cheap fast-fail check immediately after loading the Proposal, or (the
 * authoritative check) at the point the apply transaction re-checks it under
 * `SELECT ... FOR UPDATE`. Guards against two Reviews resolving the same
 * Proposal concurrently (e.g. two concurrent full-approve requests racing to
 * apply the same Proposal).
 */
export class ReviewApplyConflictError extends Error {
  constructor(message = 'Proposal has already been reviewed.') {
    super(message);
    this.name = 'ReviewApplyConflictError';
  }
}

const SCALAR_FIELDS = [
  'name', 'organizationName', 'description', 'campType', 'category', 'registrationStatus',
  'registrationOpenDate', 'registrationCloseDate', 'lunchIncluded', 'address', 'neighborhood', 'city',
  'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
  'interestingDetails', 'state', 'zip',
];

const RELATION_TABLES: Record<string, string> = {
  ageGroups: 'CampAgeGroup',
  schedules: 'CampSchedule',
  pricing: 'CampPricing',
};

type ChangeLogEntry = Parameters<typeof writeChangeLogs>[0][number];

/**
 * Applies a resolved survey Review to the target Camp: makes the Review's
 * approved Proposed Values the accepted data, records provenance
 * (CampChangeLog rows + review-decision metrics), and re-evaluates
 * verification coverage. Relocated, behavior-preserving (apart from the
 * deliberate changes documented in docs/review-apply-module.md), from
 * `app/api/admin/review/[id]/approve/route.ts`'s previously-inline logic.
 */
export async function applyProposalReview(opts: ApplyProposalReviewOptions): Promise<AppliedReview> {
  const { proposalId, reviewSessionId, reviewer, notes, feedbackTags, keepPending = false } = opts;

  const proposal = await getProposal(proposalId);
  if (!proposal) throw new ReviewApplyProposalNotFoundError();

  // Fast-fail on the just-loaded snapshot, before any session/derivation
  // work. Cheaper and more specific than waiting for the FOR UPDATE
  // re-check inside the transaction (lockAndCheckProposal, below), which
  // remains the *authoritative* guard against a race between this snapshot
  // and the transaction — this check only closes the gap where a stale/
  // foreign reviewSessionId submitted for an already-resolved Proposal would
  // otherwise reach a derivation error (400) instead of a conflict (409).
  if (proposal.status !== 'PENDING') {
    throw new ReviewApplyConflictError();
  }

  const decision = await deriveDecision({ proposal, reviewSessionId, keepPending, notes });

  const pool = getPool();
  const client: PoolClient = await pool.connect();

  const changeLogs: ChangeLogEntry[] = [];
  let appliedFields: string[] = [];
  // Captured before the under-lock re-filter below so the post-transaction
  // provenance-skip decision (see its comment, below) can tell "had nothing
  // to approve this round" apart from "had approved fields, but they were
  // all already applied" — see F13 in docs/review-apply-module.md.
  let derivedApprovedCount = 0;

  try {
    await client.query('BEGIN');

    const alreadyAppliedFields = await lockAndCheckProposal(client, proposalId);

    // Re-filter the derived approvedFields against the row's authoritative,
    // freshly-locked appliedFields — idempotency under the lock. Two
    // concurrent partial (`keepPending`) applies for the same field set both
    // pass lockAndCheckProposal's PENDING check (a partial apply leaves
    // status PENDING), but whichever acquires the lock second sees the
    // first's already-committed appliedFields here and treats those fields
    // as no-ops: no duplicate Camp writes, changelogs, or metrics. If
    // nothing remains after filtering, the apply still completes cleanly
    // with an empty appliedFields.
    derivedApprovedCount = decision.approvedFields.length;
    appliedFields = decision.approvedFields.filter((field) => !alreadyAppliedFields.has(field));

    // Validation side effect only — result intentionally unused. Relocated
    // unchanged from the route; flagged for a follow-up Verification-
    // authority slice (see the plan's Stop-short risks).
    buildCampReviewTrustInput({
      proposalId: proposal.id,
      campId: proposal.campId,
      sourceUrl: proposal.sourceUrl,
      proposedChanges: decision.effectiveChanges,
      approvedFields: appliedFields,
      reviewer,
      reviewedAt: decision.reviewedAt,
      proposalCreatedAt: proposal.createdAt,
      extractionModel: proposal.extractionModel,
      reviewerNotes: decision.reviewerNotes,
      feedbackTags,
    });

    for (const field of appliedFields) {
      const diff = decision.effectiveChanges[field];
      if (!diff) continue;

      if (SCALAR_FIELDS.includes(field)) {
        changeLogs.push(await applyScalarField(client, proposal, reviewer, decision.reviewedAt, field, diff));
      } else if (field in RELATION_TABLES && Array.isArray(diff.new)) {
        changeLogs.push(await applyRelationField(client, proposal, reviewer, decision.reviewedAt, field, diff));
      }
    }

    await recomputeVerification(client, proposal.campId, keepPending, appliedFields.length);

    // The Proposal's status transition happens inside this same transaction,
    // before COMMIT — see transitionProposalStatus's own comment for why
    // that's what makes the FOR UPDATE re-check above actually close the
    // double-apply race.
    await transitionProposalStatus(client, proposalId, keepPending, appliedFields, reviewer, decision.reviewerNotes, feedbackTags);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Provenance-skip discriminator (F13-corrected): skip writeChangeLogs/
  // recordReviewDecision ONLY when this was the genuine duplicate-retry
  // no-op — i.e. the under-lock re-filter (above) emptied a *non-empty*
  // derived approved set (derivedApprovedCount > 0 && appliedFields.length
  // === 0). That is the only case where this call's own status transition
  // (transitionProposalStatus still ran, merging no new fields) is a pure
  // duplicate of a prior/concurrent, now-committed call's own provenance —
  // re-recording it would re-report the same rejectedFields metrics that
  // call already wrote. A keepPending round whose derived approved set was
  // empty from the start (a reviewer resolves everything as rejected/
  // keep-current this round, approving nothing new) is NOT a duplicate — it
  // is a legitimate resolved round in its own right, and records provenance
  // exactly as a full apply would (in particular, its rejectedFields metrics
  // land). A full (non-keepPending) apply always records provenance,
  // matching prior behavior, since it authoritatively resolves the Proposal
  // exactly once.
  //
  // Accepted residual: this discriminator only protects against a fully-
  // empty-after-filter approved set. Two *concurrent* keepPending calls that
  // both legitimately derive zero approved fields and an identical
  // non-empty rejectedFields set (both resolving the same items as
  // rejected/keep-current) both pass this check as non-duplicates — neither
  // one's appliedFields is ever forced to empty by the lock, since there is
  // nothing to filter — so both record provenance, and rejectedFields
  // metrics can be double-recorded for that vanishingly rare race. There is
  // no rejection-tracking column (mirroring appliedFields for approvals) to
  // de-duplicate against; this is audit-only (no Camp/Proposal state
  // corruption) and accepted rather than fixed here.
  const provenanceErrors = keepPending && derivedApprovedCount > 0 && appliedFields.length === 0
    ? []
    : await recordProvenance({
        proposalId,
        proposal,
        appliedFields,
        rejectedFields: decision.rejectedFields,
        effectiveChanges: decision.effectiveChanges,
        reviewerNotes: decision.reviewerNotes,
        feedbackTags,
        changeLogs,
        keepPending,
      });

  return {
    proposalId,
    campId: proposal.campId,
    status: keepPending ? 'PENDING' : 'APPROVED',
    appliedFields,
    rejectedFields: decision.rejectedFields,
    kept: keepPending,
    provenanceErrors,
  };
}

/**
 * Loads the Survey review session bound to this Proposal, derives the
 * Review Decision from it (approved/rejected fields, reviewer notes), and
 * computes the subset of the Proposal's proposedChanges not yet applied per
 * the (pre-transaction) Proposal snapshot. Throws
 * `ReviewApplySessionNotFoundError`, or lets `SurveyReviewSessionStaleError`
 * / `SurveyReviewApplyError` propagate unmapped, exactly as before
 * decomposition.
 */
async function deriveDecision(opts: {
  readonly proposal: CampChangeProposal;
  readonly reviewSessionId: string;
  readonly keepPending: boolean;
  readonly notes?: string;
}): Promise<{
  readonly approvedFields: string[];
  readonly rejectedFields: string[];
  readonly reviewerNotes: string | undefined;
  readonly effectiveChanges: ProposedChanges;
  readonly reviewedAt: string;
}> {
  const { proposal, reviewSessionId, keepPending, notes } = opts;

  const surveySessionRecord = await getSurveyReviewSessionForProposal({ proposalId: proposal.id, reviewSessionId });
  if (!surveySessionRecord) throw new ReviewApplySessionNotFoundError();
  // Lets SurveyReviewSessionStaleError propagate to the caller unmapped.
  assertSurveyReviewSessionFreshForProposal(surveySessionRecord, proposal);

  const surveyEvents = await getSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId });
  // Lets SurveyReviewApplyError propagate to the caller unmapped.
  const surveyApply = deriveCampApplyFromSurveySession({
    proposal,
    session: surveySessionRecord.snapshot,
    events: surveyEvents,
    mode: keepPending ? 'partial' : 'full',
    serverSession: {
      sessionName: surveySessionRecord.sessionName,
      snapshotHash: surveySessionRecord.snapshotHash,
      updatedAt: surveySessionRecord.updatedAt,
    },
  });

  const unappliedProposalFields = unappliedFields(proposal);
  const effectiveChanges = pickFields(proposal.proposedChanges, unappliedProposalFields);

  return {
    approvedFields: surveyApply.approvedFields,
    rejectedFields: surveyApply.rejectedFields,
    reviewerNotes: combineReviewerNotes(notes, surveyApply.reviewerNotes),
    effectiveChanges,
    reviewedAt: new Date().toISOString(),
  };
}

/**
 * Re-checks the Proposal's status under `SELECT ... FOR UPDATE`, immediately
 * after `BEGIN` and before any write — this is what actually closes the
 * double-apply race (the row lock only matters because the status
 * transition, `transitionProposalStatus`, also happens inside this same
 * transaction, before `COMMIT`). Throws `ReviewApplyConflictError` if the
 * row's status is no longer `PENDING`. Returns the row's up-to-the-lock
 * `appliedFields` set — authoritative for the idempotency-under-lock
 * filtering in `applyProposalReview`, unlike the pre-transaction
 * `proposal.appliedFields` snapshot, which may be stale under concurrency.
 */
async function lockAndCheckProposal(client: PoolClient, proposalId: string): Promise<Set<string>> {
  const statusCheck = await client.query<{ status: string; appliedFields: string[] | null }>(
    `SELECT status, "appliedFields" FROM "CampChangeProposal" WHERE id = $1 FOR UPDATE`,
    [proposalId],
  );
  const currentStatus = statusCheck.rows[0]?.status;
  if (currentStatus !== 'PENDING') {
    throw new ReviewApplyConflictError();
  }
  return new Set(statusCheck.rows[0]?.appliedFields ?? []);
}

/** Writes one scalar Camp field + its fieldSources entry; returns the CampChangeLog entry to record for it. */
async function applyScalarField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
): Promise<ChangeLogEntry> {
  const fieldSource = {
    excerpt: diff.excerpt ?? null,
    sourceUrl: diff.sourceUrl ?? proposal.sourceUrl,
    approvedAt: reviewedAt,
  };
  await client.query(
    `UPDATE "Camp" SET "${field}" = $1, "fieldSources" = COALESCE("fieldSources", '{}') || $2::jsonb WHERE id = $3`,
    [diff.new, JSON.stringify({ [field]: fieldSource }), proposal.campId]
  );
  return {
    campId: proposal.campId,
    proposalId: proposal.id,
    changedBy: reviewer,
    fieldName: field,
    oldValue: diff.old,
    newValue: diff.new,
    changeType: (diff.old === null || diff.old === '') ? 'FIELD_POPULATED' : 'UPDATE',
  };
}

/**
 * Replace-all semantics for one of the three relation fields
 * (`ageGroups`/`schedules`/`pricing`): deletes this Camp's prior rows for
 * the relation, then inserts exactly the Review's approved set. Returns the
 * CampChangeLog entry to record for it.
 */
async function applyRelationField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
): Promise<ChangeLogEntry> {
  const table = RELATION_TABLES[field];
  const fieldSource = {
    excerpt: diff.excerpt ?? null,
    sourceUrl: diff.sourceUrl ?? proposal.sourceUrl,
    approvedAt: reviewedAt,
  };

  await client.query(`DELETE FROM "${table}" WHERE "campId" = $1`, [proposal.campId]);

  if (field === 'ageGroups') {
    for (const ag of diff.new as { label: string; minAge: number | null; maxAge: number | null; minGrade: number | null; maxGrade: number | null }[]) {
      await client.query(
        `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
        [proposal.campId, ag.label, ag.minAge, ag.maxAge, ag.minGrade, ag.maxGrade]
      );
    }
  } else if (field === 'schedules') {
    for (const s of diff.new as { label: string; startDate: string | null; endDate: string | null; startTime: string | null; endTime: string | null; earlyDropOff: string | null; latePickup: string | null }[]) {
      await client.query(
        `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff", "latePickup")
         VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
        [proposal.campId, s.label, s.startDate, s.endDate, s.startTime, s.endTime, s.earlyDropOff, s.latePickup]
      );
    }
  } else if (field === 'pricing') {
    for (const p of diff.new as { label: string; amount: number; unit: string; durationWeeks: number | null; ageQualifier: string | null; discountNotes: string | null }[]) {
      await client.query(
        `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"PricingUnit", $5, $6, $7)`,
        [proposal.campId, p.label, p.amount, p.unit, p.durationWeeks, p.ageQualifier, p.discountNotes]
      );
    }
  }

  if (field === 'schedules') {
    await client.query(
      `UPDATE "Camp" SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ schedules: fieldSource }), proposal.campId],
    );
  }

  return {
    campId: proposal.campId,
    proposalId: proposal.id,
    changedBy: reviewer,
    fieldName: field,
    oldValue: diff.old,
    newValue: diff.new,
    changeType: 'UPDATE',
  };
}

/**
 * Updates `lastVerifiedAt` and (when every required field now has
 * fieldSources coverage, and this isn't a partial Review Apply) flips
 * `dataConfidence` to VERIFIED. Field-coverage-based, not proposal-based —
 * partial approvals can still eventually trigger VERIFIED once the last
 * required field gets its citation. No-op when nothing was actually applied
 * this transaction (`appliedFieldCount === 0`) — including the idempotent
 * no-op case where every derived field was already applied under the lock.
 */
async function recomputeVerification(
  client: PoolClient,
  campId: string,
  keepPending: boolean,
  appliedFieldCount: number,
): Promise<void> {
  if (appliedFieldCount === 0) return;

  // Fetch the current camp state (including freshly-written fieldSources) to check coverage
  const { rows: [updatedCamp] } = await client.query(
    `SELECT description, "campType", category, "registrationStatus", city, "websiteUrl",
            "organizationName", "applicationUrl", "contactEmail", "contactPhone", "socialLinks",
            state, zip, "registrationOpenDate", "registrationCloseDate",
            "ageGroups", pricing, schedules, "fieldSources"
     FROM "Camp"
     LEFT JOIN LATERAL (
       SELECT COALESCE(json_agg(ag), '[]'::json) AS "ageGroups"
       FROM "CampAgeGroup" ag WHERE ag."campId" = "Camp".id
     ) ag ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(json_agg(s), '[]'::json) AS schedules
       FROM "CampSchedule" s WHERE s."campId" = "Camp".id
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(json_agg(p), '[]'::json) AS pricing
       FROM "CampPricing" p WHERE p."campId" = "Camp".id
     ) p ON true
     WHERE "Camp".id = $1`,
    [campId]
  );

  const campNowVerified = !keepPending && updatedCamp &&
    isFullyVerified(updatedCamp, updatedCamp.fieldSources);

  await client.query(
    `UPDATE "Camp"
     SET "lastVerifiedAt" = now(),
         "sourceType"     = 'SCRAPER',
         "dataConfidence" = CASE WHEN $2 THEN 'VERIFIED'::"DataConfidence" ELSE "dataConfidence" END
     WHERE id = $1`,
    [campId, campNowVerified ?? false]
  );
}

/**
 * Flips the Proposal's status (or partially-applies it, for `keepPending`)
 * inside the same transaction as the field writes above, before `COMMIT` —
 * not as a separate post-commit pool call — so `lockAndCheckProposal`'s
 * `FOR UPDATE` re-check actually closes the double-apply race: a concurrent
 * Review Apply cannot observe `PENDING` once this one has written its
 * Review Decision, because both the row lock and the status flip live in
 * the same transaction.
 */
async function transitionProposalStatus(
  client: PoolClient,
  proposalId: string,
  keepPending: boolean,
  appliedFields: string[],
  reviewer: string,
  reviewerNotes: string | undefined,
  feedbackTags: string[] | undefined,
): Promise<void> {
  if (keepPending) {
    await partialApprove(proposalId, appliedFields, reviewer, reviewerNotes, client);
  } else {
    await updateProposalStatus(proposalId, 'APPROVED', reviewer, reviewerNotes, feedbackTags, client);
  }
}

/**
 * Provenance writes happen outside the transaction — failures here are
 * non-fatal (the Review Apply itself already committed) and are collected
 * rather than thrown or silently swallowed.
 */
async function recordProvenance(opts: {
  readonly proposalId: string;
  readonly proposal: CampChangeProposal;
  readonly appliedFields: string[];
  readonly rejectedFields: string[];
  readonly effectiveChanges: ProposedChanges;
  readonly reviewerNotes: string | undefined;
  readonly feedbackTags: string[] | undefined;
  readonly changeLogs: ChangeLogEntry[];
  readonly keepPending: boolean;
}): Promise<ProvenanceError[]> {
  const provenanceErrors: ProvenanceError[] = [];

  try {
    await writeChangeLogs(opts.changeLogs);
  } catch (logErr) {
    console.error('writeChangeLogs failed (non-fatal):', logErr);
    provenanceErrors.push({ step: 'writeChangeLogs', message: String(logErr) });
  }

  try {
    await recordReviewDecision({
      proposalId: opts.proposalId,
      runId: opts.proposal.crawlRunId,
      approvedFields: opts.appliedFields,
      rejectedFields: opts.rejectedFields,
      proposedChanges: opts.effectiveChanges,
      reviewerNotes: opts.reviewerNotes,
      feedbackTags: opts.feedbackTags,
      extractionModel: opts.proposal.extractionModel,
      overallConfidence: opts.proposal.overallConfidence,
      finalDecision: !opts.keepPending,
    });
  } catch (metricsErr) {
    console.error('recordReviewDecision failed (non-fatal):', metricsErr);
    provenanceErrors.push({ step: 'recordReviewDecision', message: String(metricsErr) });
  }

  return provenanceErrors;
}

function combineReviewerNotes(requestNotes?: string, surveyNotes?: string): string | undefined {
  const notesList = [requestNotes?.trim(), surveyNotes?.trim()].filter((note): note is string => Boolean(note));
  return notesList.length > 0 ? notesList.join('\n') : undefined;
}

function unappliedFields(proposal: CampChangeProposal): string[] {
  const alreadyApplied = new Set(proposal.appliedFields ?? []);
  return Object.keys(proposal.proposedChanges).filter((field) => !alreadyApplied.has(field));
}

function pickFields<T>(record: Record<string, T>, fields: readonly string[]): Record<string, T> {
  return Object.fromEntries(
    fields
      .filter((field) => field in record)
      .map((field) => [field, record[field]]),
  );
}
