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
 * `applyScalarField`, `applyRelationField`, `recordAppliedFieldEvidence`,
 * `transitionProposalStatus`, `recordProvenance`) each responsible for one
 * concern of the apply transaction, so a future change to one concern (e.g.
 * adding a new relation type) doesn't require reading/modifying the whole
 * flow.
 *
 * Verification-authority cutover (`.kontourai/flow-agents/verification-
 * authority/verification-authority--deliver-plan.md`, Wave 4
 * "`review-apply.ts` `recomputeVerification` cutover"): `buildCampReviewTrustInput`'s
 * result — previously computed only for its `validateTrustBundle` side effect
 * and then discarded — is now the actual source of the Evidence recorded for
 * each applied field. Every approved field's Review Decision becomes real,
 * persisted Evidence on that field's canonical Claim
 * (`lib/admin/verification-authority.ts`'s `recordEvidence`, re-exported from
 * `lib/admin/claim-store.ts`); `refreshCampVerificationCacheOnLockedClient` then re-derives
 * `Camp.dataConfidence`/`lastVerifiedAt` from the full Claim ledger — the ONLY
 * writer of those two columns (see `verification-authority.ts`'s header
 * comment, AC1). This module no longer computes `isFullyVerified`/coverage
 * itself, and no longer writes `dataConfidence` directly — `lib/admin/
 * verification.ts` (the module that used to) is retired by this slice.
 * `recordAppliedFieldEvidence` runs INSIDE the apply transaction, under a
 * per-camp lock and stamped by the database clock, so a value and the record
 * of how it was decided land together or not at all. The cache is re-derived
 * in the same transaction, on the same connection, before `COMMIT`: an apply
 * that cannot re-derive it does not land. A rejected field's Current Value claim is left exactly
 * as-is: only `appliedFields` are iterated, never `decision.rejectedFields`.
 */
import type { Pool, PoolClient } from 'pg';
import type { ClaimDefinitionDraft, Evidence, TrustBundle, VerificationEvent } from '@kontourai/surface';
import { parseSnapshotSourceRef } from '@kontourai/traverse/fetch';

import { getPool } from '@/lib/db';
import { getProposal, updateProposalStatus, partialApprove } from './review-repository';
import { CAMP_ENUM_ARRAY_FIELDS, CAMP_SCALAR_FIELDS, CAMP_RELATION_TABLES } from './proposal-fields';
import { invalidEnumMembers } from './review-format-validation';
import { resolveCitationText, storedPreparedArtifact } from './citation-text';
import { resolveReviewExcerpt } from './review-excerpt-resolution';
import { textStatesTime } from '@/lib/ingestion/session-time';
import { excerptStatesOnlyYearOf, isStretchedCitation, statesSeveralYearsOnALine, yearOnADateLine } from '@/lib/ingestion/session-year';
import { keepUnstatedSessionTimes } from '@/lib/ingestion/diff-engine';
import { deriveFieldCorroboration, type ProposalHistoryRow } from './claim-corroboration';
import { contradictsRecentApproval } from './proposal-classification';
import type { BatchAcceptClaimRecord, BatchAcceptExclusion } from './batch-accept-audit-repository';
import { writeChangeLogs } from './changelog-repository';
import { recordReviewDecision } from './metrics-repository';
import { refreshCampVerificationCacheOnLockedClient, revokeArchivedSessionClaims, type RefreshCampVerificationCacheResult } from './verification-authority';
import { acquireSubjectAdvisoryLock, appendEvidence, persistClaimOnLockedClient, recordEvidenceOnLockedClient } from './claim-store';
import { lockCampForClaimWrites, nextClaimEventTime, withdrawVerification } from './unreviewed-change';
import { sessionClaimId } from './verification-policy';
import { SESSION_SUBJECT_TYPE } from './session-identity';
import { campfitSessionVocabulary } from '../trust-vocabulary';
import type { DataConfidence } from '@/lib/types';
import { buildCampReviewTrustInput, campCanonicalClaimId, type ReviewCitationSource } from './trust-projection';
import { deriveCampApplyFromSurveySession, SurveyReviewApplyError } from './survey-review-apply';
import { getSurveyReviewEvents } from './survey-review-events';
import { applyScheduleReconciliation, distinctSessions, scheduleNaturalKey, sessionMatchKey, type ExistingScheduleRow, type IncomingScheduleSnapshot } from './session-identity';
import {
  assertSurveyReviewSessionFreshForProposal,
  getSurveyReviewSessionForProposal,
  SurveyReviewSessionStaleError,
} from './survey-review-sessions';
import type { CampChangeProposal, FieldDiff, ProposedChanges } from './types';
import { createCampfitSnapshotStore } from '@/lib/ingestion/traverse-snapshot-store';

/**
 * Load the proposal's immutable snapshot and the exact text its excerpts are
 * checked against (see citation-text.ts): the prepared text the extraction
 * read, when the proposal recorded its digest, otherwise the raw body.
 */
async function exactProposalSnapshot(proposal: CampChangeProposal): Promise<{ snapshotRef: string; citation: ReviewCitationSource }> {
  if (!proposal.snapshotRef) throw new ReviewApplyCitationError(`Proposal ${proposal.id} has no immutable snapshot reference.`);
  const parsed = parseSnapshotSourceRef(proposal.snapshotRef);
  if (!parsed || !/^[a-f0-9]{64}$/i.test(parsed.bodyHash)) throw new ReviewApplyCitationError(`Proposal ${proposal.id} has a malformed snapshot reference.`);
  const snapshot = await createCampfitSnapshotStore().get(parsed.sourceId, parsed.bodyHash);
  if (!snapshot || snapshot.bodyHash !== parsed.bodyHash || snapshot.url !== parsed.url || snapshot.fetchedAt !== parsed.fetchedAt) {
    throw new ReviewApplyCitationError(`The stored snapshot for proposal ${proposal.id} is missing or does not match its reference, so its excerpts cannot be checked. Nothing was applied; re-crawl the camp.`);
  }
  const preparedArtifact = storedPreparedArtifact(proposal.rawExtraction);
  const citationText = resolveCitationText({ snapshotRef: proposal.snapshotRef, snapshot, preparedArtifact });
  if (!citationText.ok) {
    throw new ReviewApplyCitationError(`${citationText.message} Nothing was applied.`);
  }
  return {
    snapshotRef: proposal.snapshotRef,
    citation: { text: citationText.text, space: citationText.space, ...(citationText.space === 'prepared' ? { preparedArtifact: citationText.artifact } : {}) },
  };
}

/**
 * Refuse, before any write, an approval whose excerpt is not an exact
 * citation of the stored source text. Every failing field is named at once.
 */
function assertExactCitations(changes: ProposedChanges, fields: readonly string[], citation: ReviewCitationSource): void {
  const failing = fields.filter((field) => {
    const diff = changes[field];
    return Boolean(diff?.excerpt?.trim())
      && resolveReviewExcerpt(diff!.excerpt!, citation.text, diff!.locator).state !== 'verified';
  });
  if (failing.length > 0) {
    throw new ReviewApplyCitationError(
      `Cannot apply ${failing.map((field) => `"${field}"`).join(', ')}: the cited excerpt does not match the stored source text exactly. Nothing was applied. Keep the current value for ${failing.length === 1 ? 'this field' : 'these fields'}, or re-crawl the camp.`,
      failing,
    );
  }
}

/**
 * Refuse, before any write, an approved value this module cannot store as
 * approved: an enum member outside the allowed set, or a field with no apply
 * path. Without this such a field was skipped and still reported as applied.
 */
function assertApplicableValues(changes: ProposedChanges, fields: readonly string[]): void {
  const problems: string[] = [];
  const failing: string[] = [];
  for (const field of fields) {
    const diff = changes[field];
    if (!diff) continue;
    const invalid = invalidEnumMembers(field, diff.new);
    if (invalid.length > 0) {
      failing.push(field);
      problems.push(`"${field}" has value(s) that are not allowed: ${invalid.map((value) => `"${value}"`).join(', ')}`);
    } else if (CAMP_ENUM_ARRAY_FIELDS.includes(field) && Array.isArray(diff.new) && diff.new.length === 0) {
      failing.push(field);
      problems.push(`"${field}" would be emptied, which leaves the camp without one`);
    } else if (!hasApplyPath(field, diff)) {
      failing.push(field);
      problems.push(`"${field}" has no way to be applied in the proposed shape`);
    }
  }
  // A single value and its list approved together must agree. Applying both
  // would leave the column holding a value one of the two decisions did not
  // approve.
  for (const [list, twin] of Object.entries(ENUM_ARRAY_TWIN)) {
    const single = changes[twin.column];
    const members = changes[list]?.new;
    if (!fields.includes(list) || !fields.includes(twin.column) || !single || !Array.isArray(members)) continue;
    if (!members.includes(String(single.new))) {
      failing.push(twin.column);
      problems.push(`"${twin.column}" (${String(single.new)}) is not one of the approved "${list}" (${members.join(', ')})`);
    }
  }
  if (problems.length > 0) {
    throw new ReviewApplyValueError(`Cannot apply: ${problems.join('; ')}. Nothing was applied. Keep the current value or edit the field manually.`, failing);
  }
}

function hasApplyPath(field: string, diff: FieldDiff): boolean {
  if (CAMP_SCALAR_FIELDS.includes(field)) return true;
  if (CAMP_ENUM_ARRAY_FIELDS.includes(field)) return Array.isArray(diff.new);
  return field in CAMP_RELATION_TABLES && Array.isArray(diff.new);
}

// Re-exported so callers (e.g. the route) can catch these alongside this
// module's own typed errors without a separate import from
// survey-review-sessions.ts / survey-review-apply.ts.
export { SurveyReviewSessionStaleError, SurveyReviewApplyError };
export { ReviewCitationMismatchError } from './trust-projection';

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
  readonly step:
    | 'writeChangeLogs'
    | 'recordReviewDecision'
    /**
     * V3 fix (HIGH, review-code.md): `revokeArchivedSessionClaims` (AC6) —
     * appending a `revoked` VerificationEvent for an archived Session's
     * already-persisted Claims. Also non-fatal: the Session archive itself
     * (the `CampSchedule.archivedAt` write) already committed inside this
     * module's transaction; a failure recording the claim-level revocation
     * afterwards must not undo that, or block changelog/metrics provenance.
     */
    | 'revokeArchivedSessionClaims'
    /**
     * A session's time was kept rather than replaced: the proposal's cited
     * time would have overwritten a value the reviewer was not shown (a
     * steward's time entered after the page was read, or a steward's "no
     * fixed daily time"). The rest of the apply went through.
     */
    | 'sessionTimeKept';
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
  /**
   * The camp's verification as re-derived by this apply, with every
   * Verified Camp requirement that is not yet verified. Absent when nothing
   * was applied.
   */
  readonly verification?: AppliedReviewVerification;
}

export interface AppliedReviewVerification {
  readonly dataConfidence: DataConfidence;
  readonly missingRequirements: readonly { readonly id: string; readonly title: string; readonly status: string }[];
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
/** The proposal's excerpts cannot be confirmed as exact citations of its stored source. A reviewer-fixable refusal (HTTP 422), never a server fault. */
export class ReviewApplyCitationError extends Error {
  constructor(message: string, readonly fields: readonly string[] = []) {
    super(message);
    this.name = 'ReviewApplyCitationError';
  }
}

/** An approved field carries a value that cannot be stored as approved (HTTP 422). */
export class ReviewApplyValueError extends Error {
  constructor(message: string, readonly fields: readonly string[] = []) {
    super(message);
    this.name = 'ReviewApplyValueError';
  }
}

/**
 * Postgres error classes that a retry can clear: serialization failure,
 * deadlock, lock not available, query canceled, server shutting down, too many
 * connections, and every connection exception (08xxx).
 */
const TRANSIENT_PG_CODES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '53300']);

export function isTransientDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return TRANSIENT_PG_CODES.has(code) || code.startsWith('08');
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|timeout exceeded/i.test(message);
}

/**
 * The record of an approval could not be written, so nothing was applied.
 * `transient`: a retry can succeed (HTTP 503). Otherwise retrying the same
 * decision fails the same way (HTTP 422), and the message says what to do.
 */
export class ReviewApplyEvidenceError extends Error {
  readonly transient: boolean;
  constructor(readonly field: string | null, cause: unknown) {
    const transient = isTransientDatabaseError(cause);
    const what = field ? `the review record for "${field}"` : 'the record of the changed fields';
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(transient
      ? `Nothing was applied: ${what} could not be written because the database was busy (${detail}). The proposal is still pending; try again.`
      : `Nothing was applied: ${what} cannot be written (${detail}). Trying again will not help${field ? `: keep the current value for "${field}" (or reject it) and apply the rest` : ''}, or report this.`);
    this.name = 'ReviewApplyEvidenceError';
    this.transient = transient;
  }
}

/** The database was busy (deadlock, serialization, lock timeout, connection); nothing was applied and a retry can succeed (HTTP 503). */
export class ReviewApplyBusyError extends Error {
  constructor(cause: unknown) {
    super(`Nothing was applied: the database was busy (${cause instanceof Error ? cause.message : String(cause)}). The proposal is still pending; try again.`);
    this.name = 'ReviewApplyBusyError';
  }
}

export class ReviewApplyConflictError extends Error {
  constructor(message = 'Proposal has already been reviewed.') {
    super(message);
    this.name = 'ReviewApplyConflictError';
  }
}

// SCALAR_FIELDS/RELATION_TABLES extracted to ./proposal-fields.ts (campfit#51,
// Wave 1 Task 1.1) so lib/admin/claim-corroboration.ts and
// lib/admin/review-repository.ts import the SAME list rather than
// duplicating it — a pure refactor, no behavior change. Local aliases kept so
// the rest of this module's body (below) is untouched.
const SCALAR_FIELDS = CAMP_SCALAR_FIELDS;
const RELATION_TABLES = CAMP_RELATION_TABLES;

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
  // Immutable snapshot bytes are needed only to validate an approved source
  // excerpt. Legacy/synthetic review provenance remains valid without one.
  const pool = getPool();
  const client: PoolClient = await pool.connect();

  const changeLogs: ChangeLogEntry[] = [];
  let appliedFields: string[] = [];
  // Captured before the under-lock re-filter below so the post-transaction
  // provenance-skip decision (see its comment, below) can tell "had nothing
  // to approve this round" apart from "had approved fields, but they were
  // all already applied" — see F13 in docs/review-apply-module.md.
  let derivedApprovedCount = 0;
  // Captured inside the transaction (built from the under-lock-filtered
  // `appliedFields`) but consumed AFTER `COMMIT` by `recordAppliedFieldEvidence`,
  // below — see this module's header comment on why the evidence-recording
  // step can't run inside this function's own transaction `client`.
  let reviewTrustBundle: TrustBundle | undefined;
  // Applied fields whose excerpt was checked as an exact citation of the
  // stored source inside the transaction (see reviewedWithCitation).
  const facts = newAppliedFacts();
  // V3 fix (HIGH, review-code.md): Session rows archived by this round's
  // `schedules` reconciliation (if any) — captured inside the transaction,
  // consumed AFTER `COMMIT` by `revokeArchivedSessionClaims` (below), same
  // reasoning as `reviewTrustBundle` above.
  const orphanedSessions: ExistingScheduleRow[] = [];
  let refreshed: RefreshCampVerificationCacheResult | undefined;

  try {
    await client.query('BEGIN');

    // Canonical lock order (unreviewed-change.ts): camp, subjects, then rows.
    await lockCampForClaimWrites(client, proposal.campId);
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

    assertApplicableValues(decision.effectiveChanges, appliedFields);
    const proposalSnapshot = proposal.snapshotRef && approvedFieldsRequireSnapshot(decision.effectiveChanges, appliedFields)
      ? await exactProposalSnapshot(proposal)
      : undefined;
    if (proposalSnapshot) assertExactCitations(decision.effectiveChanges, appliedFields, proposalSnapshot.citation);
    facts.citations = checkCitations(decision.effectiveChanges, appliedFields, proposalSnapshot?.citation);
    facts.countsAsReview = true;

    // Builds the Review Decision's Claim/Evidence/VerificationEvent shapes
    // for every field in this round (approved and rejected alike) — kept as
    // its own call (not inlined into recordAppliedFieldEvidence) so
    // `validateTrustBundle`'s structural check still runs, and fails, inside
    // this transaction exactly as it always has (a malformed Review Decision
    // rolls back the whole apply, same as before this cutover). Its result
    // is no longer discarded: recordAppliedFieldEvidence (below, post-COMMIT)
    // feeds the approved subset into `recordEvidence`.
    reviewTrustBundle = buildCampReviewTrustInput({
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
      ...(proposalSnapshot ?? {}),
    });

    for (const field of appliedFields) {
      const diff = decision.effectiveChanges[field];
      if (!diff) continue;

      if (SCALAR_FIELDS.includes(field)) {
        changeLogs.push(await applyScalarField(client, proposal, reviewer, decision.reviewedAt, field, diff, facts));
      } else if (CAMP_ENUM_ARRAY_FIELDS.includes(field)) {
        changeLogs.push(await applyEnumArrayField(client, proposal, reviewer, decision.reviewedAt, field, diff, facts));
      } else if (field in RELATION_TABLES && Array.isArray(diff.new)) {
        const relationResult = await applyRelationField(client, proposal, reviewer, decision.reviewedAt, field, diff, facts);
        changeLogs.push(relationResult.changeLog);
        if (relationResult.orphaned && relationResult.orphaned.length > 0) {
          orphanedSessions.push(...relationResult.orphaned);
        }
      }
    }

    // The Proposal's status transition happens inside this same transaction,
    // before COMMIT — see transitionProposalStatus's own comment for why
    // that's what makes the FOR UPDATE re-check above actually close the
    // double-apply race.
    // Fail closed: every claim whose value this apply changes is withdrawn
    // from verified, then only a value a reviewer attested is verified again,
    // all in this transaction and stamped in order by the database clock
    // under the per-camp lock, so a later change always wins.
    if (appliedFields.length > 0) {
      const at = await nextClaimEventTime(client, proposal.campId);
      await withdrawChangedClaims(client, proposal.campId, appliedFields, facts, reviewer, at)
        .catch((err: unknown) => { throw new ReviewApplyEvidenceError(null, err); });
      // In the same transaction: the values and the record of who reviewed
      // them land together or not at all.
      await recordAppliedFieldEvidence({ pool, client, at: new Date(at.getTime() + 1).toISOString() }, proposal.campId, proposal.id, appliedFields, reviewTrustBundle!, {
        kind: 'review',
        reviewer,
        reviewedAt: decision.reviewedAt,
        changes: decision.effectiveChanges,
        facts,
      });
      // The cached status, re-derived from the claims as this transaction
      // leaves them, commits with them or not at all.
      refreshed = await refreshCampVerificationCacheOnLockedClient(client, proposal.campId);
    }
    await transitionProposalStatus(client, proposalId, keepPending, appliedFields, reviewer, decision.reviewerNotes, feedbackTags);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A transient database error from anywhere in the apply is retryable.
    if (!(err instanceof ReviewApplyEvidenceError) && isTransientDatabaseError(err)) throw new ReviewApplyBusyError(err);
    throw err;
  } finally {
    client.release();
  }

  const postCommitProvenanceErrors: ProvenanceError[] = [];
  const verification: AppliedReviewVerification | undefined = refreshed && {
    dataConfidence: refreshed.dataConfidence,
    missingRequirements: refreshed.rollup.requirements
      .filter((requirement) => requirement.required && requirement.status !== 'verified')
      .map((requirement) => ({ id: requirement.id, title: requirement.title, status: requirement.status })),
  };

  // V3 fix (HIGH, review-code.md, AC6): revoke Claims for any Session this
  // round's `schedules` reconciliation archived (`orphanedSessions`, captured
  // inside the transaction above) — previously built, tested, and exported
  // by `session-identity.ts`/`verification-authority.ts` but never actually
  // called from this, the one live archive path. Non-fatal for the same
  // reason as `recordAppliedFieldEvidence` above: the Session's own
  // `archivedAt` write already committed; a failure recording its Claims'
  // `revoked` VerificationEvent afterwards must not undo that.
  if (orphanedSessions.length > 0) {
    try {
      await revokeArchivedSessionClaims({ orphaned: orphanedSessions, actor: reviewer, method: 'review-apply' });
    } catch (err) {
      console.error('revokeArchivedSessionClaims failed (non-fatal):', err);
      postCommitProvenanceErrors.push({ step: 'revokeArchivedSessionClaims', message: String(err) });
    }
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
  // `postCommitProvenanceErrors` (revokeArchivedSessionClaims) are always
  // included — they already ran (or were skipped, per their own
  // `appliedFields.length`/`orphanedSessions.length` guards above)
  // independently of the writeChangeLogs/recordReviewDecision
  // duplicate-retry discriminator below, which only applies to THOSE two
  // steps.
  const provenanceErrors = [
    ...facts.sessionTimesKept.map((message): ProvenanceError => ({ step: 'sessionTimeKept', message })),
    ...postCommitProvenanceErrors,
    ...(keepPending && derivedApprovedCount > 0 && appliedFields.length === 0
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
        })),
  ];

  return {
    proposalId,
    campId: proposal.campId,
    status: keepPending ? 'PENDING' : 'APPROVED',
    appliedFields,
    rejectedFields: decision.rejectedFields,
    kept: keepPending,
    provenanceErrors,
    ...(verification ? { verification } : {}),
  };
}


export interface BatchAcceptSelection {
  readonly proposalId: string;
  readonly field: string;
}

export interface BatchAcceptOutcome {
  readonly proposalId: string;
  readonly field: string;
  readonly status: 'applied' | 'excluded_not_pending' | 'excluded_not_corroborated' | 'error';
  readonly message?: string;
}

/**
 * Batch-accept for exact-corroborated Candidate Claims (campfit#51, Wave 2
 * Task 2.2, R2/R3/R4). Reuses the SAME transactional/evidence/verification-
 * cache primitives `applyProposalReview` already calls
 * (`lockAndCheckProposal`, `applyScalarField`, `transitionProposalStatus`,
 * `buildCampReviewTrustInput`, `recordAppliedFieldEvidence`,
 * `refreshCampVerificationCacheOnLockedClient`, `writeChangeLogs`, `recordReviewDecision`)
 * — NOT the Survey-session-gated `deriveDecision`, which has no meaning for
 * a rule-driven batch action with no interactive session. Bypassing these
 * primitives would silently break `Camp.dataConfidence` (see this module's
 * header comment and `verification-authority.ts`'s "sole writer" framing);
 * `tests/integration/verification-authority-callers.test.ts` (Wave 4) is the
 * standing structural guard against that regressing later.
 *
 * Selections are grouped by `proposalId`; each proposal's valid, corroborated
 * fields are applied inside ONE transaction (mirroring
 * `applyProposalReview`'s own transaction shape) — a failure applying one
 * proposal's group does not abort the rest of the batch (mirrors the
 * aggregator-discovery onboard route's own per-item isolation discipline).
 *
 * Corroboration is RE-DERIVED here, server-side, against the caller-supplied
 * `historyByCamp` (never trusted from a client-supplied "already
 * corroborated" flag) — any selected field whose corroboration does not
 * resolve `exact: true` right now is excluded
 * (`excluded_not_corroborated`), never applied, regardless of what the UI
 * displayed when the selection was made.
 *
 * A partially-corroborated Proposal (some fields batch-eligible, some not)
 * is never fully approved by this function: it transitions to `APPROVED`
 * only when EVERY currently-unapplied field was included and applied this
 * round; otherwise it stays `PENDING` via the existing `partialApprove`
 * path, identical semantics to an interactive partial accept.
 *
 * Does NOT itself write the audit row — the caller (the batch-accept route,
 * Wave 3) owns calling `recordBatchAcceptAudit` once with this function's
 * full result, keeping this function pool/transaction-only with no audit-
 * table dependency, matching `applyProposalReview`'s own "pure Node/pg, no
 * HTTP dependency" discipline.
 */
export async function applyBatchAcceptedClaims(
  pool: Pool,
  opts: {
    selections: BatchAcceptSelection[];
    actor: string;
    historyByCamp: Map<string, ProposalHistoryRow[]>;
  },
): Promise<{ outcomes: BatchAcceptOutcome[]; claims: BatchAcceptClaimRecord[] }> {
  const { selections, actor, historyByCamp } = opts;

  const byProposal = new Map<string, string[]>();
  for (const selection of selections) {
    const fields = byProposal.get(selection.proposalId);
    if (fields) {
      if (!fields.includes(selection.field)) fields.push(selection.field);
    } else {
      byProposal.set(selection.proposalId, [selection.field]);
    }
  }

  const outcomes: BatchAcceptOutcome[] = [];
  const claims: BatchAcceptClaimRecord[] = [];

  for (const [proposalId, requestedFields] of byProposal) {
    const proposal = await getProposal(proposalId);

    if (!proposal || proposal.status !== 'PENDING') {
      for (const field of requestedFields) {
        outcomes.push({ proposalId, field, status: 'excluded_not_pending', message: proposal ? 'Proposal is no longer PENDING.' : 'Proposal was not found.' });
      }
      continue;
    }

    // Validate each requested field against this proposal's own shape
    // (scalar field, actually present in proposedChanges) BEFORE
    // re-deriving corroboration — a field that isn't even a candidate on
    // this proposal has nothing to corroborate.
    const validFields: string[] = [];
    for (const field of requestedFields) {
      if (!CAMP_SCALAR_FIELDS.includes(field) || !(field in proposal.proposedChanges)) {
        outcomes.push({ proposalId, field, status: 'excluded_not_pending', message: 'Field is not a pending scalar Candidate Claim on this proposal.' });
        continue;
      }
      validFields.push(field);
    }

    // Re-derive corroboration server-side for every valid selected field —
    // never trusts a caller-supplied "already corroborated" claim (R2/AC2).
    const history = historyByCamp.get(proposal.campId) ?? [];
    const corroboratedFields: string[] = [];
    for (const field of validFields) {
      const corroboration = deriveFieldCorroboration({
        targetProposalId: proposal.id,
        targetCrawlRunId: proposal.crawlRunId,
        field,
        history,
      });
      if (!corroboration.exact) {
        outcomes.push({ proposalId, field, status: 'excluded_not_corroborated', message: 'No exact-corroborating observation from a different crawl run was found.' });
        continue;
      }
      if (contradictsRecentApproval(proposal.proposedChanges[field])) {
        outcomes.push({ proposalId, field, status: 'excluded_not_corroborated', message: 'Changes a value a reviewer approved in the last 30 days; review it individually.' });
        continue;
      }
      corroboratedFields.push(field);
    }

    if (corroboratedFields.length === 0) continue;

    try {
      const result = await applyBatchAcceptedFieldsForProposal(pool, {
        proposal,
        fields: corroboratedFields,
        actor,
        history,
      });
      outcomes.push(...result.outcomes);
      claims.push(...result.claims);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const field of corroboratedFields) {
        outcomes.push({ proposalId, field, status: 'error', message });
      }
    }
  }

  return { outcomes, claims };
}

/**
 * Applies one Proposal's already-validated, already-corroborated field
 * selections inside a single transaction (values, evidence and the
 * verification cache), then (post-commit, non-fatal) records changelog and
 * metrics provenance exactly as `applyProposalReview` does for an
 * interactive apply. Split out of
 * `applyBatchAcceptedClaims` so that function's per-proposal loop stays
 * readable; not exported (batch-internal only).
 */
async function applyBatchAcceptedFieldsForProposal(
  pool: Pool,
  opts: {
    proposal: CampChangeProposal;
    fields: string[];
    actor: string;
    history: readonly ProposalHistoryRow[];
  },
): Promise<{ outcomes: BatchAcceptOutcome[]; claims: BatchAcceptClaimRecord[] }> {
  const { proposal, fields, actor, history } = opts;
  const reviewedAt = new Date().toISOString();
  const client = await pool.connect();

  const changeLogs: ChangeLogEntry[] = [];
  let newlyAppliedFields: string[] = [];
  let alreadyAppliedFields: Set<string> = new Set();
  let keepPending = false;
  let reviewTrustBundle: TrustBundle | undefined;
  let narrowedChanges: ProposedChanges = {};
  const facts = newAppliedFacts();

  try {
    await client.query('BEGIN');

    // Authoritative re-check under FOR UPDATE — same race guard
    // applyProposalReview relies on (see lockAndCheckProposal's own
    // comment).
    await lockCampForClaimWrites(client, proposal.campId);
    alreadyAppliedFields = await lockAndCheckProposal(client, proposal.id);
    newlyAppliedFields = fields.filter((field) => !alreadyAppliedFields.has(field));

    // Validate immutable snapshot identity and construct every canonical
    // citation before the first Camp/proposal mutation. Any missing snapshot,
    // excerpt mismatch, or malformed citation rolls back a mutation-free txn.
    if (newlyAppliedFields.length > 0) {
      narrowedChanges = pickFields(proposal.proposedChanges, newlyAppliedFields);
      assertApplicableValues(narrowedChanges, newlyAppliedFields);
      const proposalSnapshot = proposal.snapshotRef && approvedFieldsRequireSnapshot(narrowedChanges, newlyAppliedFields)
        ? await exactProposalSnapshot(proposal)
        : undefined;
      if (proposalSnapshot) assertExactCitations(narrowedChanges, newlyAppliedFields, proposalSnapshot.citation);
      facts.citations = checkCitations(narrowedChanges, newlyAppliedFields, proposalSnapshot?.citation);
      facts.countsAsReview = true;
      reviewTrustBundle = buildCampReviewTrustInput({
        proposalId: proposal.id,
        campId: proposal.campId,
        sourceUrl: proposal.sourceUrl,
        proposedChanges: narrowedChanges,
        approvedFields: newlyAppliedFields,
        reviewer: actor,
        reviewedAt,
        proposalCreatedAt: proposal.createdAt,
        extractionModel: proposal.extractionModel,
        reviewerNotes: BATCH_ACCEPT_REVIEWER_NOTES,
        ...(proposalSnapshot ?? {}),
      });
    }

    for (const field of newlyAppliedFields) {
      const diff = proposal.proposedChanges[field];
      if (!diff) continue;
      changeLogs.push(await applyScalarField(client, proposal, actor, reviewedAt, field, diff, facts));
    }

    const unappliedProposalFields = Object.keys(proposal.proposedChanges).filter((field) => !alreadyAppliedFields.has(field));
    const stillUnapplied = unappliedProposalFields.filter((field) => !newlyAppliedFields.includes(field));
    keepPending = stillUnapplied.length > 0;

    if (newlyAppliedFields.length > 0) {
      const at = await nextClaimEventTime(client, proposal.campId);
      await withdrawChangedClaims(client, proposal.campId, newlyAppliedFields, facts, actor, at)
        .catch((err: unknown) => { throw new ReviewApplyEvidenceError(null, err); });
      await recordAppliedFieldEvidence({ pool, client, at: new Date(at.getTime() + 1).toISOString() }, proposal.campId, proposal.id, newlyAppliedFields, reviewTrustBundle!, {
        kind: 'batch-accept',
        reviewer: actor,
        reviewedAt,
        changes: narrowedChanges,
        facts,
      });
      await refreshCampVerificationCacheOnLockedClient(client, proposal.campId);
    }
    await transitionProposalStatus(client, proposal.id, keepPending, newlyAppliedFields, actor, BATCH_ACCEPT_REVIEWER_NOTES, undefined);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const outcomes: BatchAcceptOutcome[] = fields.map((field) => ({ proposalId: proposal.id, field, status: 'applied' as const }));

  // No new field was actually written this round (every requested field was
  // already applied under the lock, e.g. a duplicate/idempotent retry) —
  // nothing new to record as Evidence/changelog/audit-claim provenance.
  if (newlyAppliedFields.length === 0) {
    return { outcomes, claims: [] };
  }

  try {
    await writeChangeLogs(changeLogs);
  } catch (err) {
    console.error('applyBatchAcceptedClaims: writeChangeLogs failed (non-fatal):', err);
  }

  try {
    await recordReviewDecision({
      proposalId: proposal.id,
      runId: proposal.crawlRunId,
      approvedFields: newlyAppliedFields,
      rejectedFields: [],
      proposedChanges: narrowedChanges,
      reviewerNotes: BATCH_ACCEPT_REVIEWER_NOTES,
      extractionModel: proposal.extractionModel,
      overallConfidence: proposal.overallConfidence,
      finalDecision: !keepPending,
    });
  } catch (err) {
    console.error('applyBatchAcceptedClaims: recordReviewDecision failed (non-fatal):', err);
  }

  const claims: BatchAcceptClaimRecord[] = newlyAppliedFields.map((field) => {
    const diff = proposal.proposedChanges[field]!;
    const corroboration = deriveFieldCorroboration({
      targetProposalId: proposal.id,
      targetCrawlRunId: proposal.crawlRunId,
      field,
      history,
    });
    return {
      proposalId: proposal.id,
      campId: proposal.campId,
      field,
      oldValue: diff.old,
      newValue: diff.new,
      corroboratingProposalIds: corroboration.corroboratingProposalIds,
      corroboratingSourceUrls: corroboration.corroboratingSourceUrls,
      sameSourceUrl: corroboration.sameSourceUrl,
      overallConfidenceAtAccept: proposal.overallConfidence,
    };
  });

  return { outcomes, claims };
}

/** Snapshot bytes are required only when an approved diff claims a source excerpt. */
export function approvedFieldsRequireSnapshot(changes: ProposedChanges, approvedFields: readonly string[]): boolean {
  return approvedFields.some((field) => Boolean(changes[field]?.excerpt?.trim()));
}

/** One proposed list row's citation: whether its excerpt is on the stored page. */
interface RowCitationCheck {
  /** The excerpt occurs verbatim on the stored page. Not a check that it supports this row's values. */
  readonly checked: boolean;
  readonly excerpt?: string;
  /** The `chars:` locator the excerpt resolved to. Set only when `checked`. */
  readonly locator?: string;
  /**
   * Sessions only, present when the row cites where its time was read: every
   * time excerpt is on the stored page AND states the row's start and end
   * time (session-time.ts). A time with no citation of its own (a stored
   * time the crawl kept, see diff-engine.ts) has no `time` check and is not
   * attested by this approval.
   */
  readonly time?: { readonly checked: boolean; readonly excerpt?: string; readonly locator?: string };
  /**
   * Sessions only, present when the row's dates take their year from another
   * excerpt (`rowCitations[i].year`, session-year.ts): that excerpt is on the
   * stored page AND states exactly one year, the row's start and end date's.
   * The row is `checked` only when this is.
   */
  readonly year?: { readonly checked: boolean; readonly excerpt?: string; readonly locator?: string };
}

/** Whether an applied field's cited excerpts are on the stored page, and for a list, row by row. */
interface CitationCheck {
  /** Every part of the approved value cites an excerpt that is on the stored page. */
  readonly reviewed: boolean;
  /** For a list field with per-row citations: one entry per row of the approved list. */
  readonly rows?: readonly RowCitationCheck[];
}

/**
 * Which applied fields were approved with their cited excerpts on the page.
 *
 * "Checked" means the excerpt occurs verbatim in the stored page text. It
 * does not mean the excerpt supports the value: the reviewer sees each
 * citation next to its row on the review page and judges that.
 *
 * - No stored snapshot was loaded: nothing was checked.
 * - A single value: it carries an excerpt (which `assertExactCitations` has
 *   already confirmed is on the stored page).
 * - A list: every row carries its own citation (`FieldDiff.rowCitations`) and
 *   every one is on the stored page. The list's `excerpt` is only
 *   its first row's, so a list with no per-row citations, or with any row
 *   that does not match, is not reviewed as a whole. Rows that do match are
 *   still reported individually (a session is attested row by row).
 */
function checkCitations(changes: ProposedChanges, fields: readonly string[], citation: ReviewCitationSource | undefined): Map<string, CitationCheck> {
  const checks = new Map<string, CitationCheck>();
  for (const field of fields) {
    const diff = changes[field];
    if (!diff || !citation) {
      checks.set(field, { reviewed: false });
      continue;
    }
    if (!Array.isArray(diff.new)) {
      checks.set(field, { reviewed: Boolean(diff.excerpt?.trim()) });
      continue;
    }
    const citations = diff.rowCitations;
    if (!Array.isArray(citations) || citations.length !== diff.new.length || diff.new.length === 0) {
      checks.set(field, { reviewed: false });
      continue;
    }
    const rows = citations.map((row, index): RowCitationCheck => {
      const time = field === 'schedules' ? checkSessionTimeCitation((diff.new as unknown[])[index], row?.times, citation.text) : undefined;
      // The dates' year, when it was taken from another excerpt, is part of
      // what the row's dates assert: the row counts only when it checks too.
      const year = field === 'schedules' ? checkSessionYearCitation((diff.new as unknown[])[index], row?.year, citation.text) : undefined;
      const extra = { ...(time ? { time } : {}), ...(year ? { year } : {}) };
      const excerpt = typeof row?.excerpt === 'string' ? row.excerpt : '';
      if (!excerpt.trim()) return { checked: false, ...extra };
      const resolved = resolveReviewExcerpt(excerpt, citation.text, row.locator);
      // A row with no year citation whose dates' citation was stretched up to
      // a heading (a proposal written before the session-year rules) counts
      // only when one of its date lines states the year (session-year.ts).
      const ownYearStated = field !== 'schedules' || year !== undefined || stretchedCitationStatesYear(excerpt, (diff.new as unknown[])[index]);
      return resolved.state === 'verified' && ownYearStated && (year === undefined || year.checked)
        ? { checked: true, excerpt, locator: resolved.locator, ...extra }
        : { checked: false, excerpt, ...extra };
    });
    // A cited time is part of what the row asserts: a list whose cited time
    // fails the check is not reviewed as a whole.
    checks.set(field, { reviewed: rows.every((row) => row.checked && (row.time === undefined || row.time.checked)), rows });
  }
  return checks;
}

/**
 * Check a proposed session row's time citation: every excerpt is on the stored
 * page and, together, they state the row's start and end time. Undefined when
 * the row cites no time.
 */
function checkSessionTimeCitation(
  value: unknown,
  times: readonly { excerpt?: unknown; locator?: string }[] | undefined,
  pageText: string,
): RowCitationCheck['time'] | undefined {
  if (!Array.isArray(times) || times.length === 0) return undefined;
  const excerpts = times.map((time) => (typeof time?.excerpt === 'string' ? time.excerpt : ''));
  const resolved = times.map((time, i) => (excerpts[i]!.trim() ? resolveReviewExcerpt(excerpts[i]!, pageText, time.locator) : null));
  const row = (value ?? {}) as { startTime?: unknown; endTime?: unknown };
  // Each time must be stated within one excerpt: joined, the end of one and
  // the start of the next could read as a range.
  const checked = resolved.every((r) => r?.state === 'verified')
    && excerpts.some((excerpt) => textStatesTime(row.startTime, excerpt))
    && excerpts.some((excerpt) => textStatesTime(row.endTime, excerpt));
  const first = resolved[0];
  return checked
    ? { checked, excerpt: excerpts.join(' / '), locator: first?.state === 'verified' ? first.locator : undefined }
    : { checked: false, excerpt: excerpts.join(' / ') };
}

/**
 * For a session row with no year citation: true unless its dates' citation
 * is stretched (covers a heading or other sessions' date lines) or has a line
 * stating more than one year, and its date lines do not state the row's start
 * and end year by the same rule as extraction (`yearOnADateLine`: a
 * multi-year line binds each date to its own year).
 */
function stretchedCitationStatesYear(excerpt: string, value: unknown): boolean {
  if (!isStretchedCitation(excerpt) && !statesSeveralYearsOnALine(excerpt)) return true;
  const row = (value ?? {}) as { startDate?: unknown; endDate?: unknown };
  const dates = ([[row.startDate, 'start'], [row.endDate, 'end']] as const)
    .filter((entry): entry is readonly [string, 'start' | 'end'] => typeof entry[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(entry[0]));
  return dates.length > 0 && dates.every(([date, role]) => yearOnADateLine(excerpt, date, role));
}

/**
 * Check a proposed session row's year citation: its excerpt is on the stored
 * page and states exactly one year, the year of the row's start and end
 * date. Undefined when the row cites no year of its own (its dates' own text
 * states it).
 */
function checkSessionYearCitation(
  value: unknown,
  year: { excerpt?: unknown; locator?: string } | null | undefined,
  pageText: string,
): RowCitationCheck['year'] | undefined {
  if (year === undefined || year === null) return undefined;
  const excerpt = typeof year.excerpt === 'string' ? year.excerpt : '';
  if (!excerpt.trim()) return { checked: false };
  const resolved = resolveReviewExcerpt(excerpt, pageText, year.locator);
  const row = (value ?? {}) as { startDate?: unknown; endDate?: unknown };
  const checked = resolved.state === 'verified' && excerptStatesOnlyYearOf(excerpt, [row.startDate, row.endDate]);
  return checked && resolved.state === 'verified'
    ? { checked: true, excerpt, locator: resolved.locator }
    : { checked: false, excerpt };
}

/** What the apply transaction learned that the evidence written after it needs. */
interface AppliedFacts {
  citations: Map<string, CitationCheck>;
  /** For each applied enum list: whether applying it changed its single-value twin column. */
  twinChanged: Map<string, boolean>;
  /** Each session's `startTime|endTime` before this apply, by `CampSchedule.id`. */
  previousSessionTimes: Map<string, string>;
  /** Sessions this apply kept (same id) whose time it changed or removed. */
  sessionsWithChangedTime: string[];
  /** This apply is a review that can verify (not a batch accept, unless the switch says so). */
  countsAsReview: boolean;
  /** The session rows this apply wrote (`sessionRowsToApply`), index-aligned with the proposal's rows and their citations. */
  appliedSchedules?: IncomingScheduleSnapshot[];
  /** One sentence per session whose stored time was kept instead of a cited time the reviewer was not shown. */
  sessionTimesKept: string[];
}

function newAppliedFacts(): AppliedFacts {
  return { citations: new Map(), twinChanged: new Map(), previousSessionTimes: new Map(), sessionsWithChangedTime: [], countsAsReview: false, sessionTimesKept: [] };
}

/**
 * In the apply transaction: append a `proposed` event to every existing claim
 * whose value this apply changed — each applied field, the single-value twin
 * an applied list moved, and the time of every kept session whose time
 * changed. Stamped `at`; the events this apply then records for reviewed
 * values are stamped one millisecond later.
 */
async function withdrawChangedClaims(
  client: PoolClient,
  campId: string,
  appliedFields: readonly string[],
  facts: AppliedFacts,
  actor: string,
  at: Date,
): Promise<void> {
  const claimIds = [
    ...appliedFields.map((field) => campCanonicalClaimId(campId, field)),
    ...Object.entries(ENUM_ARRAY_TWIN)
      .filter(([list]) => appliedFields.includes(list) && facts.twinChanged.get(list))
      .map(([, twin]) => campCanonicalClaimId(campId, twin.column)),
    ...facts.sessionsWithChangedTime.map((sessionId) => sessionClaimId(sessionId, 'time')),
  ];
  await withdrawVerification(client, claimIds, {
    actor,
    method: 'review-apply',
    notes: 'The value changed in a review apply; verified again only by the evidence recorded for this approval.',
    createdAt: at.toISOString(),
  });
}

/**
 * The session rows an approved list writes. A time is applied only from the
 * crawl's own citation of it (`rowCitations[i].times`): a row's time without
 * one is not the page's statement (a time `computeDiff` kept from the stored
 * session, possibly since changed by a steward, or no time at all), so it is
 * treated as unstated, and an unstated time keeps the stored session's time
 * (`keepUnstatedSessionTimes`, read here under the camp lock). A crawl never
 * removes or rewinds a time it does not state.
 */
type StoredSessionTime = Pick<IncomingScheduleSnapshot, 'label' | 'startDate' | 'endDate' | 'startTime' | 'endTime'> & { readonly noFixedTime?: boolean };

function sessionRowsToApply(diff: FieldDiff, stored: readonly StoredSessionTime[], kept: string[]): IncomingScheduleSnapshot[] {
  const rows = (Array.isArray(diff.new) ? diff.new as IncomingScheduleSnapshot[] : []).map((row, index) =>
    (diff.rowCitations?.[index]?.times?.length ?? 0) > 0 && !timeShownUnchanged(diff, row) && !timeNotShown(diff, row, stored, kept)
      ? row
      : { ...row, startTime: null, endTime: null });
  return keepUnstatedSessionTimes(stored, rows) as IncomingScheduleSnapshot[];
}

/**
 * Whether a cited time would replace a stored value the reviewer was not
 * shown: the stored session's time differs from what the proposal's `old`
 * list had for it (a steward entered or changed it after the page was read,
 * or the proposal has no `old` row for it), or a steward recorded that the
 * session has no fixed daily time (which no `old` row can show). That time is
 * then kept, only for that session, and `kept` says so; the rest of the apply
 * goes through, and a later crawl proposes the page's time against the
 * stored one.
 */
function timeNotShown(diff: FieldDiff, row: IncomingScheduleSnapshot, stored: readonly StoredSessionTime[], kept: string[]): boolean {
  if (row.startTime === null || row.endTime === null) return false;
  const old = Array.isArray(diff.old) ? diff.old as StoredSessionTime[] : [];
  const only = (list: readonly StoredSessionTime[]) => {
    const key = scheduleNaturalKey(row.label, row.startDate, row.endDate);
    const same = list.filter((candidate) => candidate && scheduleNaturalKey(candidate.label, candidate.startDate, candidate.endDate) === key);
    return same.length === 1 ? same[0]! : null;
  };
  const key = scheduleNaturalKey(row.label, row.startDate, row.endDate);
  const twins = stored.filter((candidate) => scheduleNaturalKey(candidate.label, candidate.startDate, candidate.endDate) === key);
  if (twins.length > 1) {
    // Sessions told apart only by their times (morning and afternoon): a
    // cited time that is one of theirs changes nothing, and the proposal's
    // `old` list showing exactly these sessions means the reviewer saw what
    // it replaces. Otherwise which stored value it would replace is unseen.
    if (twins.some((twin) => sessionTimeKey(twin) === sessionTimeKey(row))) return false;
    const shownTwins = old.filter((candidate) => candidate && scheduleNaturalKey(candidate.label, candidate.startDate, candidate.endDate) === key).map(sessionTimeKey).sort();
    if (JSON.stringify(shownTwins) === JSON.stringify(twins.map(sessionTimeKey).sort())) return false;
    throw new ReviewApplyValueError(
      `Nothing was applied: "${row.label}" on these dates is more than one stored session, and the page's ${row.startTime}–${row.endTime} is neither's time, so which one it would replace is not settled. Keep the current sessions, or correct them in the camp editor.`,
      ['schedules'],
    );
  }
  const current = twins[0];
  if (!current) return false;
  if (current.noFixedTime) {
    kept.push(`Session "${row.label}": a steward recorded that it has no fixed daily time, so the page's ${row.startTime}–${row.endTime} was not applied. If the page is right, a steward enters that time for the session.`);
    return true;
  }
  if (!current.startTime?.trim() || !current.endTime?.trim()) return false;
  if (sessionTimeKey(current) === sessionTimeKey(row)) return false;
  const shown = only(old);
  if (shown && sessionTimeKey(shown) === sessionTimeKey(current)) return false;
  kept.push(`Session "${row.label}": kept ${current.startTime}–${current.endTime}, which this proposal did not show (it was entered or changed after the page was read); the page's ${row.startTime}–${row.endTime} was not applied. The next crawl proposes it against the current time.`);
  return true;
}

/**
 * Whether the reviewer was shown this row's time as unchanged: the
 * proposal's `old` list has the same session (same plain label and dates,
 * the only one) with the same time. Such a time is not a change the reviewer
 * approved, so it does not overwrite a time changed since (by a steward);
 * it is treated as unstated, which keeps the stored time.
 */
function timeShownUnchanged(diff: FieldDiff, row: IncomingScheduleSnapshot): boolean {
  const old = Array.isArray(diff.old) ? diff.old as IncomingScheduleSnapshot[] : [];
  const key = scheduleNaturalKey(row.label, row.startDate, row.endDate);
  const same = old.filter((candidate) => candidate && scheduleNaturalKey(candidate.label, candidate.startDate, candidate.endDate) === key);
  return same.length === 1 && sessionTimeKey(same[0]!) === sessionTimeKey(row);
}

function sessionTimeKey(row: { startTime?: string | null; endTime?: string | null }): string {
  return `${row.startTime?.trim() ?? ''}|${row.endTime?.trim() ?? ''}`;
}

/** General review provenance always builds; snapshot citation is optional enrichment. */
export function canBuildReviewTrustBundle(
  _snapshot: { snapshotRef?: string; citation?: ReviewCitationSource },
  _changes: ProposedChanges,
  _approvedFields: readonly string[],
): boolean {
  return true;
}

const BATCH_ACCEPT_REVIEWER_NOTES = 'Batch-accepted via exact-corroboration rule.';

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
      // The STORED open-time binding (never recomputed here) — the apply
      // derivation refuses a queue whose bytes or item set moved after the
      // round opened. `getSurveyReviewSessionForProposal` above already
      // refuses unbound/unattested rows, so this is non-null in practice.
      binding: surveySessionRecord.binding ?? undefined,
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

/**
 * The `fieldSources` entry an approval records: the cited excerpt, where it
 * came from, when it was approved, and the fingerprint of the page text the
 * proposal was read from in full (so a crawl of the same text does not ask
 * again). A proposal made from an incomplete read records no fingerprint.
 */
function approvedFieldSource(proposal: CampChangeProposal, diff: FieldDiff, reviewedAt: string, reviewed: boolean) {
  // A proposal from an incomplete read never carries one (the adapter does not
  // store it); the second check keeps that true for any other writer.
  // Only a value a reviewer attested may later stand for "decided on this
  // page": an unreviewed or batch-accepted value is asked about again.
  const contentFingerprint = !reviewed || proposal.rawExtraction?.incomplete ? undefined : proposal.rawExtraction?.contentFingerprint;
  return {
    excerpt: diff.excerpt ?? null,
    sourceUrl: diff.sourceUrl ?? proposal.sourceUrl,
    approvedAt: reviewedAt,
    ...(typeof contentFingerprint === 'string' && contentFingerprint ? { contentFingerprint } : {}),
  };
}

/** Writes one scalar Camp field + its fieldSources entry; returns the CampChangeLog entry to record for it. */
async function applyScalarField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
  facts: AppliedFacts,
): Promise<ChangeLogEntry> {
  const fieldSource = approvedFieldSource(proposal, diff, reviewedAt, facts.countsAsReview && facts.citations.get(field)?.reviewed === true);
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
 * Applies one of the three relation fields (`ageGroups`/`schedules`/
 * `pricing`). `ageGroups`/`pricing` keep replace-all semantics: delete this
 * Camp's prior rows for the relation, then insert exactly the Review's
 * approved set (decision 5 scopes the keyed-upsert change below to
 * `schedules` only — these two are a documented, natural follow-up once a
 * second demand for stable child-row identity shows up).
 *
 * `schedules` instead goes through `session-identity.ts`'s
 * `applyScheduleReconciliation`: matches the incoming snapshot against
 * existing, non-archived `CampSchedule` rows by natural key (trimmed-
 * lowercase `label` + `startDate` + `endDate`) via `@kontourai/surface`'s
 * `matchClaimSubjects`, then updates matched rows in place (id preserved),
 * soft-archives (`archivedAt`, never `DELETE`) rows with no incoming match,
 * and inserts rows with no existing match — see `session-identity.ts`'s
 * header comment for the full rationale and the archived-session claim-
 * disposition follow-up this enables in Wave 3.
 *
 * Returns the CampChangeLog entry to record for the field, plus (V3 fix,
 * `schedules` only) the archived (`orphaned`) Session rows this round, so
 * the caller can revoke their Claims post-commit
 * (`revokeArchivedSessionClaims`) — see this module's header comment and
 * `applyProposalReview`'s post-commit block.
 */
/**
 * Replace one enum-list column (`campTypes`, `categories`). The members were
 * checked against the allowed set by {@link assertApplicableValues} before the
 * transaction wrote anything.
 */
const ENUM_ARRAY_TWIN: Record<string, { column: string; type: string }> = {
  campTypes: { column: 'campType', type: 'CampType' },
  categories: { column: 'category', type: 'CampCategory' },
};

async function applyEnumArrayField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
  facts: AppliedFacts,
): Promise<ChangeLogEntry> {
  const fieldSource = approvedFieldSource(proposal, diff, reviewedAt, facts.countsAsReview && facts.citations.get(field)?.reviewed === true);
  // Each list has a single-value twin column (`campType`, `category`) that
  // other code still reads. It must stay a member of the list: kept when it
  // still is one, otherwise moved to the list's first member.
  const twin = ENUM_ARRAY_TWIN[field]!;
  // The camp lock (taken first by the apply) already serialises every writer of this column.
  const before = await client.query<{ twin: string | null }>(`SELECT "${twin.column}"::text AS twin FROM "Camp" WHERE id = $1`, [proposal.campId]);
  const result = await client.query<{ twin: string | null }>(
    `UPDATE "Camp"
        SET "${field}" = $1::text[],
            "${twin.column}" = CASE WHEN "${twin.column}"::text = ANY($1::text[]) THEN "${twin.column}" ELSE ($1::text[])[1]::"${twin.type}" END,
            "fieldSources" = COALESCE("fieldSources", '{}') || $2::jsonb
      WHERE id = $3
      RETURNING "${twin.column}"::text AS twin`,
    [diff.new as string[], JSON.stringify({ [field]: fieldSource }), proposal.campId]
  );
  if (result.rowCount !== 1) throw new Error(`Applying "${field}" updated ${result.rowCount ?? 0} camp rows, expected 1.`);
  facts.twinChanged.set(field, before.rows[0]?.twin !== result.rows[0]?.twin);
  const empty = !Array.isArray(diff.old) || diff.old.length === 0;
  return {
    campId: proposal.campId,
    proposalId: proposal.id,
    changedBy: reviewer,
    fieldName: field,
    oldValue: diff.old,
    newValue: diff.new,
    changeType: empty ? 'FIELD_POPULATED' : 'UPDATE',
  };
}

async function applyRelationField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
  facts: AppliedFacts,
): Promise<{ changeLog: ChangeLogEntry; orphaned?: readonly ExistingScheduleRow[] }> {
  const fieldSource = approvedFieldSource(proposal, diff, reviewedAt, facts.countsAsReview && facts.citations.get(field)?.reviewed === true);

  let orphaned: readonly ExistingScheduleRow[] | undefined;
  if (field === 'schedules') {
    // A matched session keeps its id; whether its time changed decides if an
    // earlier time claim still describes it.
    const before = await client.query<{ id: string; label: string; startDate: string; endDate: string; startTime: string | null; endTime: string | null }>(
      `SELECT id, label, to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "startTime", "endTime"
         FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL`,
      [proposal.campId],
    );
    for (const row of before.rows) facts.previousSessionTimes.set(row.id, sessionTimeKey(row));
    // A steward's "no fixed daily time" is a stored value too, though the row has no time.
    const { rows: noFixedTime } = await client.query<{ id: string }>(
      `SELECT s.id FROM "CampSchedule" s
        WHERE s."campId" = $1 AND s."archivedAt" IS NULL
          AND (SELECT e.method FROM "SurfaceVerificationEvent" e
                WHERE e."claimId" = 'session.' || s.id || '.time'
                ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1) = 'no-fixed-time'`,
      [proposal.campId],
    );
    const stored = before.rows.map((row) => ({ ...row, noFixedTime: noFixedTime.some((n) => n.id === row.id) }));
    facts.appliedSchedules = sessionRowsToApply(diff, stored, facts.sessionTimesKept);
    const reconciliation = await applyScheduleReconciliation(client, proposal.campId, facts.appliedSchedules);
    orphaned = reconciliation.orphaned;
    if (reconciliation.matchedIds.length > 0) {
      const after = await client.query<{ id: string; startTime: string | null; endTime: string | null }>(
        `SELECT id, "startTime", "endTime" FROM "CampSchedule" WHERE id = ANY($1::text[])`,
        [reconciliation.matchedIds],
      );
      for (const row of after.rows) {
        if (facts.previousSessionTimes.get(row.id) !== sessionTimeKey(row)) facts.sessionsWithChangedTime.push(row.id);
      }
    }
  } else {
    const table = RELATION_TABLES[field];
    await client.query(`DELETE FROM "${table}" WHERE "campId" = $1`, [proposal.campId]);

    if (field === 'ageGroups') {
      for (const ag of diff.new as { label: string; minAge: number | null; maxAge: number | null; minGrade: number | null; maxGrade: number | null }[]) {
        await client.query(
          `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
          [proposal.campId, ag.label, ag.minAge, ag.maxAge, ag.minGrade, ag.maxGrade]
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
  }

  // Every approved list records its source, like a scalar. `ageGroups` and
  // `pricing` used to record none, so a later crawl could not tell that a
  // reviewer had approved them.
  await client.query(
    `UPDATE "Camp" SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ [field]: fieldSource }), proposal.campId],
  );

  return {
    changeLog: {
      campId: proposal.campId,
      proposalId: proposal.id,
      changedBy: reviewer,
      fieldName: field,
      oldValue: diff.old,
      newValue: diff.new,
      changeType: 'UPDATE',
    },
    orphaned,
  };
}

/**
 * Feeds `buildCampReviewTrustInput`'s already-produced Claims/Evidence/Events
 * for each applied (approved) field into `verification-authority.ts`'s
 * `recordEvidence` — the Review Decision becomes real, persisted Evidence on
 * the field's canonical Claim (`campCanonicalClaimId(campId, field)`), per
 * this module's header comment / the verification-authority plan's Wave 4
 * "`review-apply.ts` `recomputeVerification` cutover" task. A rejected
 * field's Current Value claim is left exactly as-is — this function only
 * ever iterates `appliedFields`, never `decision.rejectedFields`, so nothing
 * is written for a rejection.
 *
 * `campReviewResolution` (trust-projection.ts) always emits the SELECTED
 * observation's Claim/Evidence/Event under the field's canonical claim id —
 * for an applied (approved) field that is always the `proposedObservation`
 * (crawl_observation-sourced when `diff.sourceUrl` was set, matching
 * `claim-store-backfill.ts`'s "crawl_observation for source-URL-backed
 * approvals" mapping), with a `verified`-status VerificationEvent (survey's
 * `to-surface.ts` `eventMethodFor('verified')` -> `'survey-review'`) — so the
 * bundle built above is guaranteed to contain all three for every id this
 * function looks up; the error below only guards a future change to that
 * claim-identity convention.
 *
 * `evidence.id`/`event.id`, as `buildSurveyTrustBundle` mints them, are keyed
 * off the claim id ALONE (`${claimId}.evidence.source` /
 * `${claimId}.event.${status}` — `to-surface.ts`'s `observationToClaimRecord`
 * always derives them from the SELECTED observation's overridden claim id,
 * not from anything proposal-scoped), so they are NOT unique across two
 * different Proposals approving the same field for the same Camp — and
 * `SurfaceEvidence`/`SurfaceVerificationEvent` are deliberately append-only
 * (no `ON CONFLICT`, migration 012 — corrections are new rows, never
 * mutations; see `claim-store.ts`'s header comment). This function therefore
 * re-keys both ids off `(claimId, proposalId)` before calling `recordEvidence`
 * — the same "key every Evidence/VerificationEvent id deterministically off
 * the row it came from" convention `claim-store-backfill.ts` already
 * establishes (there, the legacy row; here, the approving
 * `CampChangeProposal`) — rather than reusing the bundle's own ids verbatim.
 *
 * The bundle's event always says `verified`. What is recorded does not: see
 * `recordApprovedClaim`, which writes `verified` only for a value a reviewer
 * approved against a checked citation, and `proposed` otherwise.
 */
/** Where and when an apply writes its evidence: inside its transaction, stamped `at`. */
interface EvidenceWriter {
  readonly pool: Pool;
  readonly client: PoolClient;
  readonly at: string;
}

async function recordAppliedFieldEvidence(
  w: EvidenceWriter,
  campId: string,
  proposalId: string,
  appliedFields: readonly string[],
  reviewTrustBundle: TrustBundle,
  review: ReviewDecisionRecord,
): Promise<void> {
  // Inside the apply transaction: any failure rolls the whole apply back,
  // so no value lands without the record of how it was decided.
  for (const field of appliedFields) {
    try {
      await recordAppliedField(w, campId, proposalId, field, appliedFields, reviewTrustBundle, review);
    } catch (err) {
      throw new ReviewApplyEvidenceError(field, err);
    }
  }
}

async function recordAppliedField(
  w: EvidenceWriter,
  campId: string,
  proposalId: string,
  field: string,
  appliedFields: readonly string[],
  reviewTrustBundle: TrustBundle,
  review: ReviewDecisionRecord,
): Promise<void> {
  const claimId = campCanonicalClaimId(campId, field);
  const claim = reviewTrustBundle.claims.find((candidate) => candidate.id === claimId);
  const evidence = reviewTrustBundle.evidence.find((candidate) => candidate.claimId === claimId);
  const event = reviewTrustBundle.events.find((candidate) => candidate.claimId === claimId);
  if (!claim || !evidence || !event) {
    throw new Error(
      `expected buildCampReviewTrustInput's bundle to contain a Claim/Evidence/Event for "${claimId}", found ` +
        `${claim ? 'a claim' : 'NO claim'}, ${evidence ? 'evidence' : 'NO evidence'}, ${event ? 'an event' : 'NO event'}.`,
    );
  }

  const draft: ClaimDefinitionDraft = {
    id: claim.id,
    subjectType: claim.subjectType,
    subjectId: claim.subjectId,
    facet: claim.facet,
    claimType: claim.claimType,
    fieldOrBehavior: claim.fieldOrBehavior,
    impactLevel: claim.impactLevel,
    metadata: claim.metadata,
  };
  const diff = review.changes[field];
  const check = review.facts.citations.get(field) ?? { reviewed: false };
  const reviewed = countsAsReview(review) && check.reviewed;
  await recordApprovedClaim(w, { draft, evidence, event, proposalId, field, reviewed, review });

  // The single-value twin of an enum list (`campType`, `category`) is what
  // the Verified Camp Claim Set requires. Applying the list keeps the twin a
  // member of it, so a reviewed list (every member cited) stands for the
  // twin. An unreviewed list that moved the twin takes the twin's claim out
  // of verified; one that left it alone says nothing about it. When the twin
  // itself was approved in this proposal, that decision is the twin's.
  const twin = ENUM_ARRAY_TWIN[field];
  if (twin && !appliedFields.includes(twin.column) && (reviewed || review.facts.twinChanged.get(field))) {
    await recordApprovedClaim(w, {
      draft: { ...draft, id: campCanonicalClaimId(campId, twin.column), fieldOrBehavior: twin.column },
      evidence,
      event,
      proposalId,
      field,
      via: field,
      reviewed,
      review,
    });
  }

  // Each session the approved list leaves on the camp is its own claim subject.
  if (field === 'schedules' && diff) {
    await recordSessionClaims(w, { campId, proposalId, diff, check, evidence, review, applied: review.facts.appliedSchedules });
  }
}

/** Who decided the applied fields, how, when, and what the apply transaction learned. */
interface ReviewDecisionRecord {
  /** `review`: a reviewer decided each field in the review session. `batch-accept`: fields accepted in bulk by the exact-corroboration rule. */
  readonly kind: 'review' | 'batch-accept';
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly changes: ProposedChanges;
  readonly facts: AppliedFacts;
}

/**
 * Whether an apply can verify what it applies. Both a review session and a
 * batch accept can (owner decision), but only for a field whose cited
 * excerpt is on the stored page, per row for a list: `checkCitations`
 * decides that, and an uncited field stays `proposed` either way. A batch
 * accept is still recorded as its own kind (`batch-accept`).
 */
function countsAsReview(review: ReviewDecisionRecord): boolean {
  return review.facts.countsAsReview;
}

/**
 * Persist one approved claim.
 *
 * The camp and session field policies require both `crawl_observation` and
 * `human_attestation` evidence, and Surface counts every evidence record ever
 * attached to a claim. So the status this approval leaves rests on the EVENT
 * it writes, which is always the claim's latest:
 *
 *  - Reviewed (a reviewer approved this value against a citation that was
 *    checked): the crawl observation, the reviewer's decision as
 *    `human_attestation` evidence, and a
 *    `verified` event citing both.
 *  - Not reviewed (no checked citation, or a batch accept): the crawl
 *    observation and a `proposed` event. The value was applied but nobody
 *    attested it, so the claim is not verified, whatever evidence an earlier
 *    approval of a different value left behind.
 *
 * The decision evidence is written before the event that cites it, so a
 * failure in between leaves no `verified` event behind.
 */
async function recordApprovedClaim(
  w: EvidenceWriter,
  args: {
    readonly draft: ClaimDefinitionDraft;
    readonly evidence: Evidence;
    readonly event: VerificationEvent;
    readonly proposalId: string;
    readonly field: string;
    /** The applied list this claim is recorded through (a twin column, a session). Keeps its ids apart from a direct approval's. */
    readonly via?: string;
    readonly reviewed: boolean;
    readonly review: ReviewDecisionRecord;
  },
): Promise<void> {
  const claimId = args.draft.id!;
  const suffix = `${args.proposalId}${args.via ? `.via.${args.via}` : ''}`;
  const evidenceId = `evidence.${claimId}.review.${suffix}`;
  const batch = args.review.kind === 'batch-accept';
  const reviewKind = batch ? 'batch-accept' : 'crawl-proposal';
  const sourceEvidence: Evidence = { ...args.evidence, id: evidenceId, claimId, metadata: { ...args.evidence.metadata, reviewKind } };
  const eventId = `event.${claimId}.review.${suffix}`;

  if (!args.reviewed) {
    const { verifiedAt: _verifiedAt, ...event } = args.event;
    await recordEvidenceOnLockedClient(w.pool, w.client, {
      claim: args.draft,
      evidence: sourceEvidence,
      event: {
        ...event,
        id: eventId,
        claimId,
        createdAt: w.at,
        status: 'proposed',
        evidenceIds: [evidenceId],
        ...(batch ? { method: 'batch-accept' } : {}),
        notes: batch
          ? 'Accepted in a batch by the exact-corroboration rule without a cited excerpt found on the stored page. Applied, not verified.'
          : 'Approved without a cited excerpt found on the stored page. Applied, not verified.',
      },
    });
    return;
  }

  const decisionEvidence: Evidence = {
    id: `evidence.${claimId}.review-decision.${suffix}`,
    claimId,
    evidenceType: 'human_attestation',
    method: 'attestation',
    sourceRef: `campfit-reviewer:${args.review.reviewer}`,
    sourceLocator: `proposal:${args.proposalId}:field:${args.field}`,
    excerptOrSummary: batch
      ? `${args.review.reviewer} batch-accepted the proposed "${args.field}" value under the exact-corroboration rule; its cited excerpt is on the stored page.`
      : `Reviewer ${args.review.reviewer} approved the proposed "${args.field}" value; its cited excerpt is on the stored page.`,
    observedAt: args.review.reviewedAt,
    collectedBy: args.review.reviewer,
    metadata: {
      proposalId: args.proposalId,
      reviewKind,
      trustProducer: 'campfit.crawl-review',
      decision: 'approved',
      excerptOnPage: true,
      ...(args.via ? { recordedThrough: args.via } : {}),
    },
  };
  await persistClaimOnLockedClient(w.pool, w.client, args.draft);
  await appendEvidence(w.client, decisionEvidence);
  // The source citation stays last: the trust display reads an event's last
  // evidence id as the citation to show.
  await recordEvidenceOnLockedClient(w.pool, w.client, {
    claim: args.draft,
    evidence: sourceEvidence,
    event: { ...args.event, id: eventId, claimId, createdAt: w.at, verifiedAt: w.at, status: 'verified', evidenceIds: [decisionEvidence.id, evidenceId], ...(batch ? { method: 'batch-accept' } : {}) },
  });
}

/**
 * Record what an applied `schedules` list says about each session it kept.
 *
 * Each session on the camp is matched to the proposal row it came from by the
 * same key the apply used (exact duplicate rows are one session; sessions with
 * the same label and dates are told apart by their times). A session is attested only when its
 * own row's cited excerpt is on the stored page: `dates` always, `time` only
 * when the row states a start and an end time. A session the reviewer was not
 * shown, or whose row's excerpt is not on the page, gets no new claim.
 *
 * A time this apply changed was already withdrawn from verified inside the
 * apply transaction (`withdrawChangedClaims`), so nothing here has to undo an
 * earlier claim. Recorded inside the apply transaction: a failure rolls the
 * whole apply back.
 */
async function recordSessionClaims(
  w: EvidenceWriter,
  args: {
    readonly campId: string;
    readonly proposalId: string;
    readonly diff: FieldDiff;
    readonly check: CitationCheck;
    readonly evidence: Evidence;
    readonly review: ReviewDecisionRecord;
    readonly applied: readonly IncomingScheduleSnapshot[] | undefined;
  },
): Promise<void> {
  if (!countsAsReview(args.review)) return;
  const { rows: sessions } = await w.client.query<{ id: string; label: string; startDate: string; endDate: string; startTime: string | null; endTime: string | null }>(
    `SELECT id, label, to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate", "startTime", "endTime"
       FROM "CampSchedule" WHERE "campId" = $1 AND "archivedAt" IS NULL ORDER BY id`,
    [args.campId],
  );
  // The rows the apply wrote (cited times, stored times kept), index-aligned with the citations.
  const proposed = args.applied ?? [];
  // The same keys the apply matched on (session-identity.ts): exact
  // duplicates are one session; sessions that share a label and dates are
  // told apart by their times.
  const keyOf = sessionMatchKey(distinctSessions(proposed));
  const rowIndexByKey = new Map<string, number>();
  for (const [index, row] of proposed.entries()) {
    const key = keyOf(row);
    if (!rowIndexByKey.has(key)) rowIndexByKey.set(key, index);
  }

  for (const session of sessions) {
    const index = rowIndexByKey.get(keyOf(session));
    const citation = index === undefined ? undefined : args.check.rows?.[index];
    if (!citation?.checked) continue;
    // The time is attested only from its own citation, checked on the page
    // and stating this time; a time the crawl did not state (kept from the
    // stored session) is left to whoever attested it before.
    const timeStated = Boolean(session.startTime?.trim() && session.endTime?.trim());
    // The time the citation was checked against is the proposal's own row;
    // the stored time must still be that one (a kept or newer time is not
    // what the cited text states).
    const row = proposed[index!]!;
    const proposedRow = (Array.isArray(args.diff.new) ? args.diff.new as IncomingScheduleSnapshot[] : [])[index!];
    const timeChecked = timeStated && citation.time?.checked === true
      && session.startTime === row.startTime && session.endTime === row.endTime
      && session.startTime === proposedRow?.startTime && session.endTime === proposedRow?.endTime;
    // A session created by this apply was not locked up front (its id did not exist yet).
    await acquireSubjectAdvisoryLock(w.client, SESSION_SUBJECT_TYPE, session.id);
    const attributes: ('dates' | 'time')[] = timeChecked ? ['dates', 'time'] : ['dates'];
    for (const attribute of attributes) {
      const claimId = sessionClaimId(session.id, attribute);
      const cited = attribute === 'time' ? citation.time! : citation;
      await recordApprovedClaim(w, {
          draft: {
            id: claimId,
            subjectType: SESSION_SUBJECT_TYPE,
            subjectId: session.id,
            facet: campfitSessionVocabulary.facet,
            claimType: campfitSessionVocabulary.claimTypes[attribute],
            fieldOrBehavior: attribute,
            impactLevel: 'medium',
            metadata: { proposalId: args.proposalId, reviewKind: 'crawl-proposal', sessionLabel: session.label },
          },
          // This row's own citation (for the time, the text that states it), not the list's first row's.
          evidence: {
            ...args.evidence,
            sourceLocator: cited.locator,
            excerptOrSummary: cited.excerpt ?? args.evidence.excerptOrSummary,
            // The dates' year, when it came from another excerpt: the text that
            // states it and where, checked on the stored page with the row.
            ...(attribute === 'dates' && citation.year?.checked
              ? { metadata: { ...args.evidence.metadata, yearExcerpt: citation.year.excerpt, yearLocator: citation.year.locator } }
              : {}),
          },
          event: {
            id: claimId,
            claimId,
            status: 'verified',
            type: 'verification',
            actor: args.review.reviewer,
            method: 'survey-review',
            evidenceIds: [],
            createdAt: args.review.reviewedAt,
            verifiedAt: args.review.reviewedAt,
          },
          proposalId: args.proposalId,
          field: 'schedules',
          via: 'schedules',
          reviewed: true,
          review: args.review,
        });
    }
  }
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
