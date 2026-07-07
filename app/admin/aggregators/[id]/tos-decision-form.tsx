'use client';

/**
 * app/admin/aggregators/[id]/tos-decision-form.tsx — the ToS-review
 * checkpoint form (campfit#93 R1/AC1's literal "hard human checkpoint").
 *
 * Follows `first-crawl-offer.tsx`'s "offer" card visual idiom
 * (`app/admin/providers/[providerId]/first-crawl-offer.tsx`) for a
 * gate that must be prominent, not a routine form: an unrecorded decision
 * renders as an attention-grabbing amber card (never a quiet inline form)
 * because AC1 exists specifically to force a human to stop and read the
 * aggregator's actual Terms of Service before anything can be fetched from
 * it. Once a decision exists, `page.tsx` renders a separate read-only
 * receipt (`tosReviewedBy`/`tosReviewedAt`/`tosNotes`) above this same form
 * component reused for a RE-decision — this component itself never
 * silently reverts a recorded decision back to unset; every submission is
 * itself a new, fully audited decision (matches
 * `recordTosDecision`'s own server-side semantics,
 * `lib/ingestion/aggregator/aggregator-repository.ts`).
 *
 * Calls `POST /api/admin/aggregators/[id]/tos-decision` per the plan's
 * declared contract (`{decision: 'APPROVED'|'DECLINED', notes?}` → updated
 * row, admin-only — NOT moderator). That route (Wave 3 Task 3.2) is owned
 * by a parallel worker and may not exist yet at authoring time; this
 * component is coded directly against the plan's contract and needs no
 * change once the route lands unless its response shape diverges.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, ShieldAlert, X } from 'lucide-react';

type Decision = 'APPROVED' | 'DECLINED';

export function TosDecisionForm({
  aggregatorId,
  mode = 'initial',
}: {
  aggregatorId: string;
  /** `'initial'` renders the prominent amber gate card (no decision yet);
   * `'redecide'` renders a smaller inline form for changing an existing
   * decision (still fully audited, never a silent unset — see header doc). */
  mode?: 'initial' | 'redecide';
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision>('APPROVED');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/aggregators/${aggregatorId}/tos-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, notes: notes.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed to record ToS decision');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record ToS decision');
      setSaving(false);
    }
  }

  const body = (
    <>
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm text-bark-600">
          <input
            type="radio"
            name="tosDecision"
            checked={decision === 'APPROVED'}
            onChange={() => setDecision('APPROVED')}
            className="accent-pine-600"
          />
          Approve — ToS reviewed, fetching is permitted
        </label>
        <label className="flex items-center gap-2 text-sm text-bark-600">
          <input
            type="radio"
            name="tosDecision"
            checked={decision === 'DECLINED'}
            onChange={() => setDecision('DECLINED')}
            className="accent-red-500"
          />
          Decline — do not fetch this site
        </label>
      </div>

      <textarea
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
        placeholder="Notes on the ToS review (optional)"
        rows={3}
        className="mt-3 w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm resize-none"
      />

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className={
            decision === 'APPROVED'
              ? 'inline-flex items-center gap-2 rounded-xl bg-pine-600 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700 disabled:opacity-50'
              : 'inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-red-600 disabled:opacity-50'
          }
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : decision === 'APPROVED' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          Record decision
        </button>
      </div>
    </>
  );

  if (mode === 'redecide') {
    return <div className="glass-panel p-4">{body}</div>;
  }

  return (
    <div className="glass-panel p-5 border-amber-300/60 bg-amber-50/30">
      <div className="flex items-start gap-3 mb-4">
        <ShieldAlert className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
        <div>
          <p className="font-display font-bold text-bark-700">ToS review required before discovery can run</p>
          <p className="text-sm text-bark-400 mt-0.5">
            Read this aggregator&apos;s Terms of Service, then record the decision below. Discovery stays blocked
            until an APPROVED decision is recorded — both here and at the server.
          </p>
        </div>
      </div>
      {body}
    </div>
  );
}
