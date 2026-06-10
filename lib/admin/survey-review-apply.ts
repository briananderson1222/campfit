import type { ReviewDecision, ReviewSessionEvent } from '@kontourai/survey';
import {
  type ReviewWorkbenchResult,
} from '@/lib/kontourai/survey-review-workbench';
import {
  createServerReviewSessionRecord,
  deriveServerReviewSessionApplyResult,
  ServerReviewSessionEventValidationError,
  StaleServerReviewSessionError,
} from '@/lib/kontourai/survey-review-server-session';
import type { CampReviewQueueSession } from './survey-review-items';
import type { CampChangeProposal } from './types';

export interface SurveyReviewApplyResult {
  readonly approvedFields: string[];
  readonly rejectedFields: string[];
  readonly reviewerNotes?: string;
  readonly decisions: readonly ReviewDecision[];
  readonly results: readonly ReviewWorkbenchResult[];
}

export type SurveyReviewApplyMode = 'full' | 'partial';

export class SurveyReviewApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurveyReviewApplyError';
  }
}

export function deriveCampApplyFromSurveySession(opts: {
  readonly proposal: CampChangeProposal;
  readonly session: CampReviewQueueSession;
  readonly events: readonly ReviewSessionEvent[];
  readonly mode?: SurveyReviewApplyMode;
  readonly serverSession?: {
    readonly sessionName: string;
    readonly snapshotHash: string;
    readonly updatedAt: string;
  };
}): SurveyReviewApplyResult {
  const mode = opts.mode ?? 'full';
  validateSessionItems(opts.proposal, opts.session);

  const record = opts.serverSession
    ? {
        sessionName: opts.serverSession.sessionName,
        snapshot: opts.session,
        snapshotHash: opts.serverSession.snapshotHash,
        updatedAt: opts.serverSession.updatedAt,
      }
    : createServerReviewSessionRecord({
        sessionName: opts.events[0]?.spec.sessionName ?? 'review-workbench-session',
        snapshot: opts.session,
        updatedAt: opts.session.reviewedAt,
      });

  const applyResult = (() => {
    try {
      return deriveServerReviewSessionApplyResult({
        record,
        events: opts.events,
        requiredResolvedItems: mode === 'full' ? 'all' : 'any',
      });
    } catch (error) {
      if (
        error instanceof ServerReviewSessionEventValidationError ||
        error instanceof StaleServerReviewSessionError
      ) {
        throw new SurveyReviewApplyError(error.message);
      }
      throw error;
    }
  })();
  if (!applyResult.ok) {
    throw new SurveyReviewApplyError(
      applyResult.issues.map((issue) => issue.message).join(' '),
    );
  }

  const itemByName = new Map(opts.session.items.map((item) => [item.metadata.name, item]));
  const alreadyApplied = new Set(opts.proposal.appliedFields ?? []);
  const approvedFields: string[] = [];
  const rejectedFields: string[] = [];

  for (const result of applyResult.results) {
    const item = itemByName.get(result.reviewItemName);
    if (!item) {
      throw new SurveyReviewApplyError(`Survey result references an unknown item: ${result.reviewItemName}`);
    }

    const field = item.spec.target;
    if (alreadyApplied.has(field)) {
      continue;
    }

    if (result.decision === 'accept-proposed' && result.selectedCandidateRole === 'proposed') {
      approvedFields.push(field);
    } else if (result.decision === 'keep-current' || result.decision === 'reject-proposed') {
      rejectedFields.push(field);
    } else {
      throw new SurveyReviewApplyError(
        `Survey decision ${result.decision} for ${result.reviewItemName} does not map to a CampFit apply action.`,
      );
    }
  }

  if (mode === 'partial' && approvedFields.length === 0 && rejectedFields.length === 0) {
    throw new SurveyReviewApplyError('Survey review has no newly applicable resolved items to apply.');
  }

  return {
    approvedFields: unique(approvedFields),
    rejectedFields: unique(rejectedFields),
    reviewerNotes: surveyReviewerNotes(applyResult.replayedSession.notesByItemName),
    decisions: applyResult.decisions,
    results: applyResult.results,
  };
}

function validateSessionItems(proposal: CampChangeProposal, session: CampReviewQueueSession): void {
  const proposedFields = new Set(Object.keys(proposal.proposedChanges));
  const seenTargets = new Set<string>();

  for (const item of session.items) {
    const field = item.spec.target;
    if (!proposedFields.has(field)) {
      throw new SurveyReviewApplyError(`Survey item ${item.metadata.name} targets field outside this proposal: ${field}`);
    }
    if (seenTargets.has(field)) {
      throw new SurveyReviewApplyError(`Survey session contains duplicate proposal field target: ${field}`);
    }
    seenTargets.add(field);

    const labelField = item.metadata.labels?.field;
    if (labelField && labelField !== field) {
      throw new SurveyReviewApplyError(`Survey item ${item.metadata.name} has mismatched field label: ${labelField}`);
    }
    if (item.metadata.labels?.proposalId && item.metadata.labels.proposalId !== proposal.id) {
      throw new SurveyReviewApplyError(`Survey item ${item.metadata.name} belongs to a different proposal.`);
    }
  }
}

function surveyReviewerNotes(notesByItemName: Readonly<Record<string, string>>): string | undefined {
  const notes = Object.entries(notesByItemName)
    .map(([itemName, note]) => ({ itemName, note: note.trim() }))
    .filter(({ note }) => note.length > 0)
    .map(({ itemName, note }) => `${itemName}: ${note}`);

  return notes.length > 0 ? notes.join('\n') : undefined;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}
