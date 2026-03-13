'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, ExternalLink, Loader2, Pencil, Quote, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FieldDiff, ProviderChangeProposal } from '@/lib/admin/types';

const FIELD_LABELS: Record<string, string> = {
  name: 'Provider Name',
  websiteUrl: 'Website URL',
  logoUrl: 'Logo URL',
  address: 'Address',
  city: 'City',
  neighborhood: 'Neighborhood',
  contactEmail: 'Contact Email',
  contactPhone: 'Contact Phone',
  notes: 'Notes',
  crawlRootUrl: 'Crawl Root URL',
  applicationUrl: 'Application URL',
  socialLinks: 'Social Links',
};

const INLINE_EDITABLE = new Set([
  'name', 'websiteUrl', 'logoUrl', 'address', 'city', 'neighborhood',
  'contactEmail', 'contactPhone', 'notes', 'crawlRootUrl', 'applicationUrl',
]);

export function ProviderReviewPanel({
  proposal,
  queueContext,
}: {
  proposal: ProviderChangeProposal;
  queueContext: {
    backHref: string;
    providerHref: string;
    nextHref: string | null;
  };
}) {
  const router = useRouter();
  const [proposedChanges, setProposedChanges] = useState<Record<string, FieldDiff>>(proposal.proposedChanges ?? {});
  const fields = Object.entries(proposedChanges) as [string, FieldDiff][];
  const [selected, setSelected] = useState<Set<string>>(new Set(fields.map(([field]) => field)));
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const providerData = (proposal.providerData ?? {}) as Record<string, unknown>;

  function toggleField(field: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  function startEdit(field: string, currentValue: unknown) {
    setEditing((prev) => ({ ...prev, [field]: String(currentValue ?? '') }));
  }

  function commitEdit(field: string) {
    const nextValue = editing[field];
    if (nextValue === undefined) return;
    setProposedChanges((prev) => ({
      ...prev,
      [field]: { ...prev[field], new: nextValue },
    }));
    setEditing((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  async function submit(action: 'approve' | 'reject', moveToNext = false) {
    setLoading(action);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/admin/provider-proposals/${proposal.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvedFields: Array.from(selected),
          reviewerNotes: notes,
          overrides: proposedChanges,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Failed to ${action} proposal`);

      if (action === 'approve' && moveToNext && queueContext.nextHref) {
        router.push(queueContext.nextHref);
      } else {
        router.push(queueContext.backHref);
      }
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Request failed');
      setLoading(null);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-3">
        {fields.map(([field, diff]) => {
          const conf = Math.round((diff.confidence ?? proposal.overallConfidence ?? 0) * 100);
          const isEditing = editing[field] !== undefined;
          return (
            <div
              key={field}
              className={cn(
                'rounded-2xl border p-4 transition-colors',
                selected.has(field) ? 'border-pine-300/60 bg-pine-50/30' : 'border-cream-400/40 bg-cream-100/40'
              )}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(field)}
                  onChange={() => toggleField(field)}
                  className="mt-1 w-4 h-4 accent-pine-600 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="font-semibold text-bark-600 text-sm">{FIELD_LABELS[field] ?? field}</span>
                    <span className={cn(
                      'text-xs px-1.5 py-0.5 rounded-full font-medium',
                      conf >= 80 ? 'bg-pine-100 text-pine-600' :
                      conf >= 50 ? 'bg-amber-100 text-amber-600' :
                      'bg-red-100 text-red-500'
                    )}>
                      {conf}%
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-bark-300 mb-1 uppercase tracking-wide">Current</p>
                      <p className="text-bark-500 break-words">{formatValue(diff.old)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-pine-400 mb-1 uppercase tracking-wide flex items-center gap-1">
                        Proposed
                        {INLINE_EDITABLE.has(field) && !isEditing && (
                          <button onClick={() => startEdit(field, diff.new)} className="text-bark-300 hover:text-pine-500">
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                      </p>
                      {isEditing ? (
                        <div className="flex items-start gap-1">
                          <input
                            autoFocus
                            value={editing[field] ?? ''}
                            onChange={(event) => setEditing((prev) => ({ ...prev, [field]: event.target.value }))}
                            className="flex-1 rounded-lg border border-cream-300 bg-cream-50 px-2.5 py-1.5 text-sm"
                          />
                          <button onClick={() => commitEdit(field)} className="text-pine-500 hover:text-pine-700 p-1 shrink-0">
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setEditing((prev) => {
                              const next = { ...prev };
                              delete next[field];
                              return next;
                            })}
                            className="text-bark-300 hover:text-red-400 p-1 shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <p className="text-pine-700 font-medium break-words">{formatValue(diff.new)}</p>
                      )}
                    </div>
                  </div>

                  {(diff.excerpt || diff.sourceUrl) && (
                    <div className="mt-3 flex items-start gap-2 bg-amber-50/60 border border-amber-200/60 rounded-lg px-3 py-2">
                      <Quote className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        {diff.excerpt && (
                          <p className="text-xs text-amber-800 italic leading-relaxed">"{diff.excerpt}"</p>
                        )}
                        {diff.sourceUrl && (
                          <a
                            href={diff.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-pine-500 hover:text-pine-700 mt-1 break-all"
                          >
                            <ExternalLink className="w-3 h-3 shrink-0" />
                            {diff.sourceUrl.replace(/^https?:\/\//, '').slice(0, 70)}
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-4">
        <div className="glass-panel p-5">
          <h3 className="font-semibold text-bark-600 mb-3">Reviewer Notes</h3>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Optional notes about this review..."
            rows={4}
            className="w-full text-sm border border-cream-400/60 rounded-xl p-3 focus:outline-none focus:border-pine-400 resize-none bg-cream-50"
          />

          <div className="space-y-2 mt-4">
            <Link href={queueContext.providerHref} className="btn-secondary w-full gap-2">
              <ExternalLink className="w-4 h-4" />
              Open Provider Data
            </Link>
            <button
              onClick={() => submit('approve')}
              disabled={loading !== null || selected.size === 0}
              className="btn-primary w-full gap-2 disabled:opacity-50"
            >
              {loading === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Apply & Resolve
            </button>
            <button
              onClick={() => submit('approve', true)}
              disabled={loading !== null || selected.size === 0 || !queueContext.nextHref}
              className="btn-secondary w-full gap-2 disabled:opacity-50"
            >
              {loading === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              Apply & Next
            </button>
            <button
              onClick={() => submit('reject')}
              disabled={loading !== null}
              className="btn-secondary w-full gap-2 text-red-500 hover:bg-red-50 disabled:opacity-50"
            >
              {loading === 'reject' ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
              Reject All
            </button>
          </div>
          {errorMessage && (
            <p className="mt-3 text-sm text-red-600">{errorMessage}</p>
          )}
        </div>

        <div className="glass-panel p-5 space-y-2 text-sm text-bark-500">
          <div>
            <span className="text-xs uppercase tracking-wide text-bark-300">Current provider snapshot</span>
          </div>
          {Object.entries(providerData)
            .filter(([field]) => !['id', 'slug', 'createdAt', 'updatedAt'].includes(field))
            .filter(([, value]) => value !== null && value !== '')
            .slice(0, 12)
            .map(([field, value]) => (
              <div key={field} className="border-t border-cream-200/60 pt-2">
                <div className="text-xs text-bark-300 uppercase tracking-wide">{FIELD_LABELS[field] ?? field}</div>
                <div className="break-words">{formatValue(value)}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
