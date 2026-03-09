'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CampChangeProposal, FieldDiff } from '@/lib/admin/types';

const FIELD_LABELS: Record<string, string> = {
  name: 'Camp Name', description: 'Description', campType: 'Camp Type',
  category: 'Category', registrationStatus: 'Registration Status',
  registrationOpenDate: 'Registration Opens', lunchIncluded: 'Lunch Included',
  address: 'Address', neighborhood: 'Neighborhood', city: 'City',
  websiteUrl: 'Website URL', interestingDetails: 'Interesting Details',
  ageGroups: 'Age Groups', schedules: 'Schedules', pricing: 'Pricing',
};

export function ReviewPanel({ proposal }: { proposal: CampChangeProposal }) {
  const router = useRouter();
  const fields = Object.entries(proposal.proposedChanges) as [string, FieldDiff][];
  const [selected, setSelected] = useState<Set<string>>(new Set(fields.map(([k]) => k)));
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleField = (field: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const toggleExpand = (field: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const handleApprove = async () => {
    setLoading('approve');
    try {
      const res = await fetch(`/api/admin/review/${proposal.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedFields: Array.from(selected), reviewerNotes: notes }),
      });
      if (!res.ok) throw new Error('Failed');
      router.push('/admin/review');
      router.refresh();
    } catch {
      setLoading(null);
    }
  };

  const handleReject = async () => {
    setLoading('reject');
    try {
      const res = await fetch(`/api/admin/review/${proposal.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewerNotes: notes }),
      });
      if (!res.ok) throw new Error('Failed');
      router.push('/admin/review');
      router.refresh();
    } catch {
      setLoading(null);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Diff table */}
      <div className="lg:col-span-2 space-y-3">
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setSelected(new Set(fields.map(([k]) => k)))} className="text-xs text-pine-500 hover:underline">Select all</button>
          <span className="text-bark-300">·</span>
          <button onClick={() => setSelected(new Set())} className="text-xs text-bark-400 hover:underline">Deselect all</button>
          <span className="text-bark-300 ml-auto text-xs">{selected.size} of {fields.length} fields selected</span>
        </div>

        {fields.map(([field, diff]) => {
          const isSelected = selected.has(field);
          const isArray = Array.isArray(diff.new);
          const isExpandable = isArray || String(diff.new).length > 120;
          const isExpanded = expanded.has(field);
          const conf = Math.round(diff.confidence * 100);

          return (
            <div
              key={field}
              className={cn(
                'rounded-2xl border p-4 transition-colors',
                isSelected ? 'border-pine-300/60 bg-pine-50/30' : 'border-cream-400/40 bg-cream-100/40'
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleField(field)}
                  className="mt-1 w-4 h-4 accent-pine-600 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-semibold text-bark-600 text-sm">{FIELD_LABELS[field] ?? field}</span>
                    <span className={cn(
                      'text-xs px-1.5 py-0.5 rounded-full font-medium',
                      conf >= 80 ? 'bg-pine-100 text-pine-600' :
                      conf >= 50 ? 'bg-amber-100 text-amber-600' :
                      'bg-red-100 text-red-500'
                    )}>
                      {conf}% confidence
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-bark-300 mb-1 uppercase tracking-wide">Current</p>
                      <FieldValue value={diff.old} field={field} expanded={isExpanded} />
                    </div>
                    <div>
                      <p className="text-xs text-pine-400 mb-1 uppercase tracking-wide">Proposed</p>
                      <FieldValue value={diff.new} field={field} expanded={isExpanded} highlight />
                    </div>
                  </div>

                  {isExpandable && (
                    <button
                      onClick={() => toggleExpand(field)}
                      className="flex items-center gap-1 text-xs text-bark-300 hover:text-bark-500 mt-2"
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {isExpanded ? 'Collapse' : 'Expand'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions sidebar */}
      <div className="space-y-4">
        <div className="glass-panel p-5">
          <h3 className="font-semibold text-bark-600 mb-3">Reviewer Notes</h3>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes about this review..."
            rows={4}
            className="w-full text-sm border border-cream-400/60 rounded-xl p-3 focus:outline-none focus:border-pine-400 resize-none bg-cream-50"
          />

          <div className="space-y-2 mt-4">
            <button
              onClick={handleApprove}
              disabled={loading !== null || selected.size === 0}
              className="btn-primary w-full gap-2 disabled:opacity-50"
            >
              {loading === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Apply {selected.size} Field{selected.size !== 1 ? 's' : ''}
            </button>
            <button
              onClick={handleReject}
              disabled={loading !== null}
              className="btn-secondary w-full gap-2 text-red-500 hover:bg-red-50 disabled:opacity-50"
            >
              {loading === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
              Reject All
            </button>
          </div>
        </div>

        <div className="glass-panel p-5">
          <h3 className="font-semibold text-bark-600 mb-2 text-sm">Extraction Info</h3>
          <div className="space-y-1 text-xs text-bark-400">
            <p>Model: {proposal.extractionModel}</p>
            <p>Created: {new Date(proposal.createdAt).toLocaleString()}</p>
            <p>Fields changed: {fields.length}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldValue({ value, field, expanded, highlight }: {
  value: unknown; field: string; expanded: boolean; highlight?: boolean;
}) {
  void field; // used for future field-specific rendering

  if (value === null || value === undefined) {
    return <span className="text-bark-200 italic">empty</span>;
  }

  if (typeof value === 'boolean') {
    return <span className={highlight ? 'text-pine-600 font-medium' : 'text-bark-500'}>{value ? 'Yes' : 'No'}</span>;
  }

  if (Array.isArray(value)) {
    const preview = JSON.stringify(value, null, 2);
    return (
      <pre className={cn(
        'text-xs rounded-lg p-2 overflow-hidden whitespace-pre-wrap break-all font-mono',
        highlight ? 'bg-pine-50 text-pine-700 border border-pine-200/50' : 'bg-cream-200/60 text-bark-500',
        !expanded && 'max-h-24'
      )}>
        {preview}
      </pre>
    );
  }

  const str = String(value);
  const text = !expanded && str.length > 120 ? str.slice(0, 120) + '…' : str;
  return (
    <p className={cn('leading-relaxed', highlight ? 'text-pine-700' : 'text-bark-500')}>
      {text}
    </p>
  );
}
