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
 * `lib/admin/claim-store.ts`); `refreshCampVerificationCache` then re-derives
 * `Camp.dataConfidence`/`lastVerifiedAt` from the full Claim ledger — the ONLY
 * writer of those two columns (see `verification-authority.ts`'s header
 * comment, AC1). This module no longer computes `isFullyVerified`/coverage
 * itself, and no longer writes `dataConfidence` directly — `lib/admin/
 * verification.ts` (the module that used to) is retired by this slice.
 * `recordAppliedFieldEvidence`/`refreshCampVerificationCache` necessarily run
 * AFTER `COMMIT` (both go through `verification-authority.ts`'s own pool-
 * scoped calls, not this function's transaction `client`, so they need the
 * applied fields' writes to already be visible) — a rejected field's Current
 * Value claim is left exactly as-is: only `appliedFields` are iterated, never
 * `decision.rejectedFields`.
 */
import type { Pool, PoolClient } from 'pg';
import type { ClaimDefinitionDraft, Evidence, TrustBundle, VerificationEvent } from '@kontourai/surface';

import { getPool } from '@/lib/db';
import { getProposal, updateProposalStatus, partialApprove } from './review-repository';
import { CAMP_SCALAR_FIELDS, CAMP_RELATION_TABLES } from './proposal-fields';
import { deriveFieldCorroboration, type ProposalHistoryRow } from './claim-corroboration';
import type { BatchAcceptClaimRecord, BatchAcceptExclusion } from './batch-accept-audit-repository';
import { writeChangeLogs } from './changelog-repository';
import { recordReviewDecision } from './metrics-repository';
import { recordEvidence, refreshCampVerificationCache, revokeArchivedSessionClaims } from './verification-authority';
import { buildCampReviewTrustInput, campCanonicalClaimId } from './trust-projection';
import { deriveCampApplyFromSurveySession, SurveyReviewApplyError } from './survey-review-apply';
import { getSurveyReviewEvents } from './survey-review-events';
import { applyScheduleReconciliation, type ExistingScheduleRow, type IncomingScheduleSnapshot } from './session-identity';
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
  readonly step:
    | 'writeChangeLogs'
    | 'recordReviewDecision'
    /**
     * V2 fix (HIGH, review-code.md): `recordAppliedFieldEvidence`/
     * `refreshCampVerificationCache` run AFTER `COMMIT` (see this module's
     * header comment) and were previously unguarded — a failure there used
     * to propagate as an unhandled exception (a misleading 500 for an apply
     * that had already durably succeeded) and silently skipped
     * changelog/metrics provenance entirely. Both are now individually
     * try/caught and reported here instead, exactly like the pre-existing
     * writeChangeLogs/recordReviewDecision steps below.
     */
    | 'recordAppliedFieldEvidence'
    | 'refreshCampVerificationCache'
    /**
     * V3 fix (HIGH, review-code.md): `revokeArchivedSessionClaims` (AC6) —
     * appending a `revoked` VerificationEvent for an archived Session's
     * already-persisted Claims. Also non-fatal: the Session archive itself
     * (the `CampSchedule.archivedAt` write) already committed inside this
     * module's transaction; a failure recording the claim-level revocation
     * afterwards must not undo that, or block changelog/metrics provenance.
     */
    | 'revokeArchivedSessionClaims';
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
  // V3 fix (HIGH, review-code.md): Session rows archived by this round's
  // `schedules` reconciliation (if any) — captured inside the transaction,
  // consumed AFTER `COMMIT` by `revokeArchivedSessionClaims` (below), same
  // reasoning as `reviewTrustBundle` above.
  const orphanedSessions: ExistingScheduleRow[] = [];

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
    });

    for (const field of appliedFields) {
      const diff = decision.effectiveChanges[field];
      if (!diff) continue;

      if (SCALAR_FIELDS.includes(field)) {
        changeLogs.push(await applyScalarField(client, proposal, reviewer, decision.reviewedAt, field, diff));
      } else if (field in RELATION_TABLES && Array.isArray(diff.new)) {
        const relationResult = await applyRelationField(client, proposal, reviewer, decision.reviewedAt, field, diff);
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
    await transitionProposalStatus(client, proposalId, keepPending, appliedFields, reviewer, decision.reviewerNotes, feedbackTags);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Verification-authority cutover (see this module's header comment): the
  // old field-coverage-based, direct-`Camp.dataConfidence`-write
  // `recomputeVerification` is retired. Each applied field's Review Decision
  // becomes real, persisted Evidence on its canonical Claim
  // (`recordAppliedFieldEvidence`), then `refreshCampVerificationCache`
  // re-derives `dataConfidence`/`lastVerifiedAt` from the full Claim ledger —
  // the only writer of those two columns now. No-op when nothing was applied
  // this round (mirrors the old function's `appliedFieldCount === 0` guard),
  // including the idempotent no-op case where every derived field was
  // already applied under the lock. Runs for both a full apply and a
  // `keepPending` partial apply alike — the module derives the Camp's true
  // coverage from its persisted Claims on every call, so there is no
  // separate "defer VERIFIED until the final round" flag to thread through
  // here anymore.
  // V2 fix (HIGH, review-code.md): this used to be unguarded — a failure
  // here (e.g. a transient DB error, or `recordAppliedFieldEvidence`'s own
  // "expected a Claim/Evidence/Event, found none" defensive throw) propagated
  // as an unhandled exception even though the Camp's fields and the
  // Proposal's status had ALREADY durably committed above: the admin saw a
  // misleading 500 for an apply that had actually (fully or partially)
  // succeeded, AND changelog/metrics provenance below never ran, AND it was
  // never reported as a provenanceError like every other failure mode this
  // module handles. Both steps are now individually try/caught and reported
  // via `provenanceErrors` instead — changelog/metrics (`recordProvenance`,
  // below) still run regardless of whether these succeed.
  const postCommitProvenanceErrors: ProvenanceError[] = [];
  if (appliedFields.length > 0 && reviewTrustBundle) {
    try {
      await recordAppliedFieldEvidence(pool, proposal.campId, proposal.id, appliedFields, reviewTrustBundle);
    } catch (err) {
      console.error('recordAppliedFieldEvidence failed (non-fatal):', err);
      postCommitProvenanceErrors.push({ step: 'recordAppliedFieldEvidence', message: String(err) });
    }

    try {
      await refreshCampVerificationCache(proposal.campId);
    } catch (err) {
      console.error('refreshCampVerificationCache failed (non-fatal):', err);
      postCommitProvenanceErrors.push({ step: 'refreshCampVerificationCache', message: String(err) });
    }
  }

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
  // `postCommitProvenanceErrors` (recordAppliedFieldEvidence/
  // refreshCampVerificationCache/revokeArchivedSessionClaims) are always
  // included — they already ran (or were skipped, per their own
  // `appliedFields.length`/`orphanedSessions.length` guards above)
  // independently of the writeChangeLogs/recordReviewDecision
  // duplicate-retry discriminator below, which only applies to THOSE two
  // steps.
  const provenanceErrors = [
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
 * `refreshCampVerificationCache`, `writeChangeLogs`, `recordReviewDecision`)
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
 * selections inside a single transaction, then (post-commit, non-fatal)
 * records Evidence/verification-cache/changelog/metrics provenance exactly
 * as `applyProposalReview` does for an interactive apply. Split out of
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

  try {
    await client.query('BEGIN');

    // Authoritative re-check under FOR UPDATE — same race guard
    // applyProposalReview relies on (see lockAndCheckProposal's own
    // comment).
    alreadyAppliedFields = await lockAndCheckProposal(client, proposal.id);
    newlyAppliedFields = fields.filter((field) => !alreadyAppliedFields.has(field));

    for (const field of newlyAppliedFields) {
      const diff = proposal.proposedChanges[field];
      if (!diff) continue;
      changeLogs.push(await applyScalarField(client, proposal, actor, reviewedAt, field, diff));
    }

    const unappliedProposalFields = Object.keys(proposal.proposedChanges).filter((field) => !alreadyAppliedFields.has(field));
    const stillUnapplied = unappliedProposalFields.filter((field) => !newlyAppliedFields.includes(field));
    keepPending = stillUnapplied.length > 0;

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

  const narrowedChanges = pickFields(proposal.proposedChanges, newlyAppliedFields);
  const reviewTrustBundle = buildCampReviewTrustInput({
    proposalId: proposal.id,
    campId: proposal.campId,
    sourceUrl: proposal.sourceUrl,
    proposedChanges: narrowedChanges,
    // Every field in narrowedChanges is approved — this batch action never
    // rejects a field; a not-yet-selected/not-yet-corroborated field simply
    // stays out of narrowedChanges entirely (still PENDING for individual
    // review), rather than being marked 'rejected' here.
    approvedFields: newlyAppliedFields,
    reviewer: actor,
    reviewedAt,
    proposalCreatedAt: proposal.createdAt,
    extractionModel: proposal.extractionModel,
    reviewerNotes: BATCH_ACCEPT_REVIEWER_NOTES,
  });

  try {
    await recordAppliedFieldEvidence(pool, proposal.campId, proposal.id, newlyAppliedFields, reviewTrustBundle);
    await refreshCampVerificationCache(proposal.campId);
  } catch (err) {
    console.error('applyBatchAcceptedClaims: recordAppliedFieldEvidence/refreshCampVerificationCache failed (non-fatal):', err);
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
async function applyRelationField(
  client: PoolClient,
  proposal: CampChangeProposal,
  reviewer: string,
  reviewedAt: string,
  field: string,
  diff: FieldDiff,
): Promise<{ changeLog: ChangeLogEntry; orphaned?: readonly ExistingScheduleRow[] }> {
  const fieldSource = {
    excerpt: diff.excerpt ?? null,
    sourceUrl: diff.sourceUrl ?? proposal.sourceUrl,
    approvedAt: reviewedAt,
  };

  let orphaned: readonly ExistingScheduleRow[] | undefined;
  if (field === 'schedules') {
    const reconciliation = await applyScheduleReconciliation(client, proposal.campId, diff.new as IncomingScheduleSnapshot[]);
    orphaned = reconciliation.orphaned;

    await client.query(
      `UPDATE "Camp" SET "fieldSources" = COALESCE("fieldSources", '{}') || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ schedules: fieldSource }), proposal.campId],
    );
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
 */
async function recordAppliedFieldEvidence(
  pool: Pool,
  campId: string,
  proposalId: string,
  appliedFields: readonly string[],
  reviewTrustBundle: TrustBundle,
): Promise<void> {
  for (const field of appliedFields) {
    const claimId = campCanonicalClaimId(campId, field);
    const claim = reviewTrustBundle.claims.find((candidate) => candidate.id === claimId);
    const evidence = reviewTrustBundle.evidence.find((candidate) => candidate.claimId === claimId);
    const event = reviewTrustBundle.events.find((candidate) => candidate.claimId === claimId);
    if (!claim || !evidence || !event) {
      throw new Error(
        `recordAppliedFieldEvidence: expected buildCampReviewTrustInput's bundle to contain a ` +
          `Claim/Evidence/Event for "${claimId}" (field "${field}"), found ` +
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

    const evidenceId = `evidence.${claimId}.review.${proposalId}`;
    const scopedEvidence: Evidence = { ...evidence, id: evidenceId };
    const scopedEvent: VerificationEvent = { ...event, id: `event.${claimId}.review.${proposalId}`, evidenceIds: [evidenceId] };

    await recordEvidence(pool, { claim: draft, evidence: scopedEvidence, event: scopedEvent });
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
