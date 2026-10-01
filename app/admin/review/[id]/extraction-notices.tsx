import {
  multiProgramNotice,
  populatedListNotice,
  refusedValuesNotice,
  storedDroppedEntries,
  storedMultiProgram,
  storedRefusedValues,
  storedExtractionIncompleteness,
  storedPopulatedListFields,
  storedWithheldListFields,
  withheldListNotice,
} from '@/lib/admin/proposal-extraction-status';

/**
 * What the review page must say about a proposal made from an extraction that
 * did not read the whole page: the run was incomplete, which list updates it
 * withheld, and which empty lists it filled (those may be missing entries).
 * Renders nothing for a complete run. No hooks, so it renders on the server
 * and in a static-markup test.
 */
export function ExtractionNotices({ rawExtraction }: { rawExtraction: Record<string, unknown> | null | undefined }) {
  const incomplete = storedExtractionIncompleteness(rawExtraction);
  const withheld = storedWithheldListFields(rawExtraction);
  const populated = storedPopulatedListFields(rawExtraction);
  const refused = storedRefusedValues(rawExtraction);
  const multiProgram = storedMultiProgram(rawExtraction);
  const dropped = storedDroppedEntries(rawExtraction);
  return (
    <>
      {multiProgram && (
        <div role="status" data-testid="multi-program-notice" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Multi-program page</p>
          <p className="mt-0.5">{multiProgramNotice(multiProgram)}</p>
        </div>
      )}
      {dropped.length > 0 && (
        <div role="status" data-testid="dropped-entry-notices" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Entries left out of the proposed lists</p>
          <ul className="mt-0.5 space-y-1">
            {dropped.map((note, index) => <li key={`dropped-${index}`}>{note}</li>)}
          </ul>
        </div>
      )}
      {refused.length > 0 && (
        <ul role="status" data-testid="refused-value-notices" className="mb-4 space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {refused.map((entry) => <li key={`refused-${entry.field}`}>{refusedValuesNotice(entry)}</li>)}
        </ul>
      )}
      {incomplete && (
        <div role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Incomplete extraction ({incomplete.reason})</p>
          <p className="mt-0.5">
            {incomplete.unreadRanges > 0
              ? `${incomplete.unreadRanges} text range(s) of the source page were not fully read. `
              : 'Part of the source page was not read. '}
            These changes cover only the text that was read. A value missing here is not evidence it was removed.
          </p>
        </div>
      )}
      {(withheld.length > 0 || populated.length > 0) && (
        <ul role="status" data-testid="list-update-notices" className="mb-4 space-y-1 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {withheld.map((field) => <li key={`withheld-${field}`}>{withheldListNotice(field)}</li>)}
          {populated.map((field) => <li key={`populated-${field}`}>{populatedListNotice(field)}</li>)}
        </ul>
      )}
    </>
  );
}
