'use client';

/**
 * app/admin/aggregators/[id]/tos-receipt.tsx — read-only ToS-decision
 * receipt + collapsed re-decide affordance (campfit#93 R1/AC1).
 *
 * Once a decision is recorded, the gate itself must remain visibly
 * auditable (never quietly replaced by a blank form) — this renders the
 * decision, reviewer, timestamp, and notes as a receipt, with an explicit
 * "Change decision" toggle that reveals `TosDecisionForm` in `mode=
 * "redecide"` for a genuinely new decision (itself fully audited by the
 * same server-side fields — see `tos-decision-form.tsx`'s header doc; this
 * component never lets a decision silently revert to unset).
 */
import { useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { AggregatorSourceRow } from '@/lib/ingestion/aggregator/types';
import { relativeDate } from '../aggregators-view';
import { TosDecisionForm } from './tos-decision-form';

export function TosReceiptWithRedecide({ aggregator }: { aggregator: AggregatorSourceRow }) {
  const [redecideOpen, setRedecideOpen] = useState(false);
  const approved = aggregator.tosDecision === 'APPROVED';

  return (
    <div className="space-y-2">
      <div className={`glass-panel p-5 ${approved ? 'border-pine-300/60 bg-pine-50/20' : 'border-red-300/60 bg-red-50/20'}`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            {approved ? (
              <CheckCircle2 className="w-5 h-5 text-pine-500 mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            )}
            <div>
              <p className="font-display font-bold text-bark-700">
                ToS {approved ? 'Approved' : 'Declined'}
              </p>
              <p className="text-sm text-bark-400 mt-0.5">
                Reviewed by {aggregator.tosReviewedBy ?? 'unknown'} · {relativeDate(aggregator.tosReviewedAt)}
              </p>
              {aggregator.tosNotes && (
                <p className="text-sm text-bark-500 mt-2 italic">&quot;{aggregator.tosNotes}&quot;</p>
              )}
            </div>
          </div>
          <button onClick={() => setRedecideOpen((v) => !v)} className="btn-secondary text-xs">
            {redecideOpen ? 'Cancel' : 'Change decision'}
          </button>
        </div>
      </div>
      {redecideOpen && <TosDecisionForm aggregatorId={aggregator.id} mode="redecide" />}
    </div>
  );
}
