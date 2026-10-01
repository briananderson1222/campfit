/**
 * citation-text.ts — which text a crawl proposal's excerpts are checked against.
 *
 * An extraction never reads raw HTML. Traverse prepares the snapshot body
 * (HTML to Markdown, page chrome pruned) and the provider quotes that prepared
 * text, so an excerpt carries its `**bold**` and `[label](url)` markers and
 * its `chars:` locator is an offset into the prepared text. Checking such an
 * excerpt against the raw snapshot body fails for most fields.
 *
 * The prepared text is not stored. It is re-derived here from the stored
 * snapshot with the same Traverse preparation, and accepted only when its
 * SHA-256 equals the digest the extraction recorded (`PreparedArtifact`), and
 * that record names this proposal's snapshot. A preparation that no longer
 * reproduces the recorded digest is refused, never approximated: the check
 * stays an exact string comparison, only against the right text.
 *
 * A proposal written before the prepared-text identity was recorded has no
 * `PreparedArtifact`; its excerpts keep resolving against the raw body.
 */
import {
  createPreparedArtifact,
  prepareAndChunk,
  validatePreparedArtifact,
  type ContentType,
  type PreparedArtifact,
} from '@kontourai/traverse';

/** Where a citation locator points. Recorded on evidence so a later reader resolves it in the same text. */
export type CitationSpace = 'prepared' | 'snapshot-body';

export type CitationText =
  | { ok: true; space: 'prepared'; text: string; artifact: PreparedArtifact }
  | { ok: true; space: 'snapshot-body'; text: string }
  | { ok: false; reason: CitationTextFailure; message: string };

export type CitationTextFailure =
  | 'invalid-prepared-artifact'
  | 'snapshot-mismatch'
  | 'unsupported-preparation'
  | 'preparation-failed'
  | 'digest-mismatch';

export interface CitationSnapshot {
  readonly body: string;
  readonly bodyBytes?: Uint8Array;
  readonly contentType: ContentType;
}

/** The `PreparedArtifact` an extraction recorded on its proposal, if any. */
export function storedPreparedArtifact(rawExtraction: Record<string, unknown> | null | undefined): unknown {
  return rawExtraction?.preparedArtifact ?? undefined;
}

/**
 * Resolve the text `snapshotRef`'s citations are checked against.
 *
 * `preparedArtifact` is the untrusted record from the proposal. Absent means a
 * legacy proposal (raw body). Present means the prepared text must be
 * reproduced exactly, or the result is a failure.
 */
export function resolveCitationText(args: {
  readonly snapshotRef: string;
  readonly snapshot: CitationSnapshot;
  readonly preparedArtifact?: unknown;
}): CitationText {
  if (args.preparedArtifact === undefined || args.preparedArtifact === null) {
    return { ok: true, space: 'snapshot-body', text: args.snapshot.body };
  }

  const validated = validatePreparedArtifact(args.preparedArtifact);
  if (validated.status !== 'valid') {
    return { ok: false, reason: 'invalid-prepared-artifact', message: 'The proposal\'s prepared-text record is malformed.' };
  }
  const recorded = validated.artifact;
  if (recorded.sourceSnapshotRef !== args.snapshotRef) {
    return { ok: false, reason: 'snapshot-mismatch', message: 'The proposal\'s prepared-text record names a different snapshot.' };
  }
  if (recorded.preparationMode !== 'markdown' && recorded.preparationMode !== 'text') {
    return { ok: false, reason: 'unsupported-preparation', message: `Prepared text of kind "${recorded.preparationMode}" cannot be reproduced here.` };
  }

  const prepared = prepareAndChunk(args.snapshot.bodyBytes ?? args.snapshot.body, args.snapshot.contentType);
  if (prepared.error !== undefined) {
    return { ok: false, reason: 'preparation-failed', message: `The stored snapshot could not be prepared: ${prepared.error}` };
  }
  const derived = createPreparedArtifact(prepared.fullText, {
    preparationMode: recorded.preparationMode,
    preparationVersion: recorded.preparationVersion,
    sourceSnapshotRef: recorded.sourceSnapshotRef,
  });
  if (derived.digest !== recorded.digest || derived.ref !== recorded.ref) {
    return {
      ok: false,
      reason: 'digest-mismatch',
      message: 'The text the extraction read can no longer be reproduced from the stored snapshot (its digest differs). Re-crawl the camp to get a checkable proposal.',
    };
  }
  return { ok: true, space: 'prepared', text: prepared.fullText, artifact: recorded };
}
