import type { ProposedChanges } from '@/lib/admin/types';
import { listFieldLabel } from '@/lib/admin/proposal-extraction-status';

/**
 * Each proposed list row next to the page text it cites. Approving a list
 * attests every row whose excerpt is on the stored page; the check confirms
 * only that the text is there, so the reviewer reads here whether it says
 * what the row says. No hooks, so it renders on the server and in a test.
 */
export function RowCitations({ proposedChanges }: { proposedChanges: ProposedChanges | null | undefined }) {
  const lists = Object.entries(proposedChanges ?? {})
    .filter(([, diff]) => Array.isArray(diff?.new) && Array.isArray(diff?.rowCitations) && diff.rowCitations.length > 0);
  if (lists.length === 0) return null;
  return (
    <section data-testid="row-citations" className="mb-4 rounded-xl border border-cream-300 bg-cream-50 px-4 py-3 text-sm text-bark-600">
      <p className="font-semibold">What each proposed row cites</p>
      <p className="mt-0.5 text-xs text-bark-400">
        Approving a list attests every row whose quoted text is on the page. Check that the text says what the row says.
      </p>
      {lists.map(([field, diff]) => (
        <div key={field} className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-bark-400">{listFieldLabel(field)}</p>
          <ol className="mt-1 space-y-1.5">
            {(diff.new as unknown[]).map((row, index) => (
              <li key={`${field}-${index}`} data-testid="row-citation" className="grid gap-1 sm:grid-cols-2 sm:gap-3">
                <span className="break-words">{rowSummary(row)}</span>
                <span className="grid gap-0.5">
                  <q className="break-words text-xs text-bark-500">{diff.rowCitations?.[index]?.excerpt?.trim() || 'no citation'}</q>
                  <TimeCitation row={row} times={diff.rowCitations?.[index]?.times} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

/**
 * A session row's time: the text that states it, or a note that the time was
 * kept from the stored session because the page does not state one (an
 * approval does not attest a kept time).
 */
function TimeCitation({ row, times }: { row: unknown; times: readonly { excerpt: string }[] | undefined }) {
  const value = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  if (!value.startTime || !value.endTime) return null;
  if (!times || times.length === 0) {
    return <span data-testid="row-time-kept" className="text-xs text-bark-400">time kept from the stored session; the page does not state it</span>;
  }
  return (
    <span data-testid="row-time-citation" className="text-xs text-bark-500">
      time: {times.map((time, i) => <q key={i} className="break-words">{time.excerpt}</q>)}
    </span>
  );
}

function rowSummary(row: unknown): string {
  if (typeof row !== 'object' || row === null) return String(row);
  const value = row as Record<string, unknown>;
  const parts = [
    value.label,
    value.startDate && value.endDate ? `${String(value.startDate)} – ${String(value.endDate)}` : null,
    value.startTime && value.endTime ? `${String(value.startTime)}–${String(value.endTime)}` : null,
    value.minAge !== undefined || value.maxAge !== undefined ? `ages ${value.minAge ?? '?'}–${value.maxAge ?? '?'}` : null,
    typeof value.amount === 'number' ? `$${value.amount}${value.unit ? ` ${String(value.unit)}` : ''}` : null,
  ].filter((part) => part !== null && part !== undefined && part !== '');
  return parts.map(String).join(' · ');
}
