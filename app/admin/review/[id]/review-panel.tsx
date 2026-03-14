'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Check, X, Loader2, ChevronDown, ChevronUp, ExternalLink, GitBranch, Quote, Link2, Pencil, BookmarkCheck, Lightbulb, ShieldCheck, ShieldAlert, RefreshCw, AlertCircle, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CampChangeProposal, FieldDiff } from '@/lib/admin/types';
import { ENUM_OPTIONS, labelFor } from '@/lib/enums';
import { CAMP_TYPE_DESCRIPTIONS } from '@/lib/types';

const FIELD_LABELS: Record<string, string> = {
  name: 'Camp Name', description: 'Description', campType: 'Camp Type',
  category: 'Category', registrationStatus: 'Registration Status',
  registrationOpenDate: 'Registration Opens', lunchIncluded: 'Lunch Included',
  address: 'Address', neighborhood: 'Neighborhood', city: 'City',
  websiteUrl: 'Website URL', interestingDetails: 'Interesting Details',
  ageGroups: 'Age Groups', schedules: 'Schedules', pricing: 'Pricing',
  notes: 'Notes', sourceType: 'Source Type', dataConfidence: 'Data Confidence',
  lastVerifiedAt: 'Last Verified', communitySlug: 'Community', region: 'Region',
  registrationOpenTime: 'Registration Opens (Time)',
};

const CAMP_META_FIELDS = [
  'registrationStatus', 'campType', 'category', 'city', 'neighborhood',
  'address', 'lunchIncluded', 'dataConfidence', 'lastVerifiedAt', 'websiteUrl',
  'description', 'interestingDetails', 'notes',
];

// Fields that are safe to inline-edit as plain text
const INLINE_EDITABLE = new Set([
  'name', 'description', 'city', 'neighborhood', 'address',
  'websiteUrl', 'interestingDetails', 'notes',
  'registrationStatus', 'campType', 'category',
]);

const FIELD_PRIORITY: Record<string, number> = {
  name: 0,
  registrationStatus: 1,
  description: 2,
  websiteUrl: 3,
  city: 4,
  neighborhood: 5,
  address: 6,
  ageGroups: 7,
  schedules: 8,
  pricing: 9,
};

export function ReviewPanel({
  proposal,
  queueContext,
}: {
  proposal: CampChangeProposal;
  queueContext?: {
    backHref: string;
    campHref: string;
    nextHref: string | null;
    previousHref: string | null;
  };
}) {
  const router = useRouter();
  const [proposedChanges, setProposedChanges] = useState<Record<string, FieldDiff>>(proposal.proposedChanges);
  // Fields already applied in previous partial-approval rounds
  const alreadyApplied = new Set<string>(proposal.appliedFields ?? []);
  // Only show unapplied fields as selectable
  const fields = (Object.entries(proposedChanges) as [string, FieldDiff][])
    .filter(([k]) => !alreadyApplied.has(k))
    .sort(([fieldA], [fieldB]) => compareFieldPriority(fieldA, fieldB));
  const [selected, setSelected] = useState<Set<string>>(new Set(fields.map(([k]) => k)));
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState<'approve' | 'keep' | 'reject' | 'recrawl' | null>(null);
  const [recrawlMsg, setRecrawlMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [proposedCollapsed, setProposedCollapsed] = useState(false);
  const [snapshotCollapsed, setSnapshotCollapsed] = useState(true);
  const [showAllMeta, setShowAllMeta] = useState(false);
  // editing state: { [field]: currentEditValue }
  const [editing, setEditing] = useState<Record<string, string>>({});
  // direct camp field edits (bypassing proposal)
  const [campEdits, setCampEdits] = useState<Record<string, string>>({});
  const [campEditFields, setCampEditFields] = useState<Record<string, boolean>>({});
  const [savingCampField, setSavingCampField] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const campData = (proposal.campData ?? {}) as Record<string, unknown>;
  const campDomain = (() => {
    try { return new URL(proposal.sourceUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  const [hintText, setHintText] = useState('');
  const [savingHint, setSavingHint] = useState(false);
  const [savedHints, setSavedHints] = useState(0);
  const changedFieldNames = new Set(fields.map(([k]) => k));

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

  // Edit proposed value inline
  const startEdit = (field: string, currentVal: unknown) => {
    setEditing(prev => ({ ...prev, [field]: String(currentVal ?? '') }));
  };
  const commitEdit = (field: string) => {
    const val = editing[field];
    if (val === undefined) return;
    setProposedChanges(prev => ({
      ...prev,
      [field]: { ...prev[field], new: val },
    }));
    setEditing(prev => { const n = { ...prev }; delete n[field]; return n; });
  };
  const cancelEdit = (field: string) => {
    setEditing(prev => { const n = { ...prev }; delete n[field]; return n; });
  };

  // Save a direct camp field edit (not via proposal)
  const saveCampField = async (field: string) => {
    const val = campEdits[field];
    if (val === undefined) return;
    setSavingCampField(field);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/admin/camps/${proposal.campId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: val }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to save field'));
      setCampEditFields(prev => { const n = { ...prev }; delete n[field]; return n; });
      // Optimistically update campData display
      campData[field] = val;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save field');
    } finally {
      setSavingCampField(null);
    }
  };

  const callApprove = async (keepPending: boolean, moveToNext = false) => {
    setLoading(keepPending ? 'keep' : 'approve');
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/admin/review/${proposal.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvedFields: Array.from(selected),
          reviewerNotes: notes,
          overrides: proposedChanges,
          keepPending,
        }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to apply proposal'));
      if (keepPending) {
        // Stay on page — refresh to show updated applied state
        router.refresh();
      } else if (moveToNext && queueContext?.nextHref) {
        router.push(queueContext.nextHref);
        router.refresh();
      } else {
        router.push(queueContext?.backHref ?? '/admin/review');
        router.refresh();
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to apply proposal');
      setLoading(null);
    }
  };

  const handleApprove = () => callApprove(false);
  const handleKeep = () => callApprove(true);
  const handleApproveAndNext = () => callApprove(false, true);

  const handleReject = async () => {
    setLoading('reject');
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/admin/review/${proposal.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewerNotes: notes }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'Failed to reject proposal'));
      router.push(queueContext?.backHref ?? '/admin/review');
      router.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reject proposal');
      setLoading(null);
    }
  };

  const fieldSources = (campData.fieldSources ?? {}) as Record<string, { excerpt: string | null; sourceUrl: string; approvedAt: string }>;
  const [proofOpen, setProofOpen] = useState<Set<string>>(new Set());
  const toggleProof = (f: string) => setProofOpen(prev => { const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n; });

  const campSnapshot = (
      <div className="glass-panel p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-bark-600 text-sm uppercase tracking-wide">Current Camp Data</h2>
          <button
            onClick={() => setShowAllMeta(v => !v)}
            className="text-xs text-bark-400 hover:text-pine-500 flex items-center gap-1"
          >
            {showAllMeta ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {showAllMeta ? 'Show less' : 'Show all fields'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {(showAllMeta ? Object.keys(campData) : CAMP_META_FIELDS)
            .filter(f => !['id', 'slug', 'createdAt', 'updatedAt', 'savedBy', 'notifications', 'dataSourceCamps', 'fieldSources'].includes(f))
            .map(field => {
              const val = campData[field];
              const isChanged = changedFieldNames.has(field);
              const isEditingCamp = campEditFields[field];
              if (!showAllMeta && (val === null || val === undefined || val === '' || val === false)) return null;
              const proposedVal = isChanged ? proposedChanges[field]?.new : undefined;
              const proof = fieldSources[field];
              const isProofOpen = proofOpen.has(field);

              return (
                <div key={field} className={cn(
                  'group py-1.5 px-1 rounded border-b border-cream-200/50',
                  isChanged && 'bg-amber-50/40',
                )}>
                  <p className="text-xs text-bark-300 uppercase tracking-wide flex items-center gap-1">
                    {FIELD_LABELS[field] ?? field}
                    {/* Proof status icon */}
                    {proof ? (
                      <button
                        onClick={() => toggleProof(field)}
                        title={`Verified ${new Date(proof.approvedAt).toLocaleDateString()} — click to ${isProofOpen ? 'hide' : 'show'} proof`}
                        className="ml-1 text-pine-500 hover:text-pine-700"
                      >
                        <ShieldCheck className="w-3 h-3" />
                      </button>
                    ) : (val !== null && val !== undefined && val !== '') ? (
                      <span title="No proof citation yet"><ShieldAlert className="w-3 h-3 ml-1 text-amber-400" /></span>
                    ) : null}
                    {INLINE_EDITABLE.has(field) && !isEditingCamp && (
                      <button
                        onClick={() => { setCampEditFields(p => ({ ...p, [field]: true })); setCampEdits(p => ({ ...p, [field]: String(val ?? '') })); }}
                        className="opacity-0 group-hover:opacity-100 ml-1 text-bark-300 hover:text-pine-500 transition-opacity"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                  </p>
                  {isEditingCamp ? (
                    <div className="flex items-center gap-1 mt-1">
                      <FieldInput
                        field={field}
                        value={campEdits[field] ?? ''}
                        onChange={v => setCampEdits(p => ({ ...p, [field]: v }))}
                        onCommit={() => saveCampField(field)}
                        onCancel={() => setCampEditFields(p => { const n = { ...p }; delete n[field]; return n; })}
                      />
                      <button onClick={() => saveCampField(field)} disabled={savingCampField === field} className="text-pine-500 hover:text-pine-700 p-1 shrink-0">
                        {savingCampField === field ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => setCampEditFields(p => { const n = { ...p }; delete n[field]; return n; })} className="text-bark-300 hover:text-red-400 p-1 shrink-0">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : isChanged ? (
                    <div className="flex items-center gap-1.5 flex-wrap text-sm">
                      <span className="text-bark-400 line-through text-xs">
                        {ENUM_OPTIONS[field] ? labelFor(field, String(val ?? '')) : formatValue(val)}
                      </span>
                      <span className="text-amber-400 text-xs">→</span>
                      <span className="text-amber-700 font-medium text-xs">
                        {ENUM_OPTIONS[field] ? labelFor(field, String(proposedVal ?? '')) : formatValue(proposedVal)}
                      </span>
                    </div>
                  ) : (
                    <p className="text-bark-600 truncate text-sm">
                      {ENUM_OPTIONS[field] ? labelFor(field, String(val ?? '')) : formatValue(val)}
                    </p>
                  )}
                  {/* Inline proof */}
                  {proof && isProofOpen && (
                    <div className="mt-1.5 rounded-lg bg-pine-50/60 border border-pine-200/50 px-2.5 py-2 space-y-1">
                      <p className="text-xs text-pine-600 font-medium flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3" />
                        Verified {new Date(proof.approvedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                      {proof.excerpt && (
                        <p className="text-xs text-bark-500 italic leading-relaxed">"{proof.excerpt}"</p>
                      )}
                      {!proof.excerpt && (
                        <p className="text-xs text-bark-400 italic">Admin attestation — no excerpt</p>
                      )}
                      {proof.sourceUrl && (
                        <a
                          href={proof.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-pine-500 hover:text-pine-700 break-all"
                        >
                          <Link2 className="w-3 h-3 shrink-0" />
                          {proof.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60)}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
  );

  return (
    <div className="space-y-6">
      {/* ── Proposed Changes header (always visible) ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setProposedCollapsed(v => !v)}
          className="flex items-center gap-1.5 font-semibold text-bark-600 text-sm uppercase tracking-wide hover:text-bark-700"
        >
          {proposedCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          Proposed Changes
        </button>
        {!proposedCollapsed && (
          <>
            <span className="text-bark-300 text-xs">·</span>
            <button onClick={() => setSelected(new Set(fields.map(([k]) => k)))} className="text-xs text-pine-500 hover:underline">Select all</button>
            <button onClick={() => setSelected(new Set())} className="text-xs text-bark-400 hover:underline">Deselect all</button>
          </>
        )}
        <span className="text-bark-300 ml-auto text-xs">
          {alreadyApplied.size > 0 && <span className="text-pine-500 mr-2">{alreadyApplied.size} applied</span>}
          {!proposedCollapsed && <>{selected.size} of {fields.length} remaining selected</>}
        </span>
        {/* Recrawl button */}
        <button
          disabled={loading === 'recrawl'}
          onClick={async () => {
            setLoading('recrawl');
            setRecrawlMsg(null);
            try {
              const res = await fetch(`/api/admin/camps/${proposal.campId}/crawl`, { method: 'POST' });
              if (res.ok) {
                setRecrawlMsg('Crawling… new proposal will replace this one when ready.');
                setTimeout(() => { router.refresh(); }, 8000);
              } else {
                const j = await res.json().catch(() => ({}));
                setRecrawlMsg(j.error ?? 'Crawl failed');
              }
            } finally {
              setLoading(null);
            }
          }}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-cream-300 text-bark-400 hover:text-pine-600 hover:border-pine-300 disabled:opacity-40 transition-colors"
          title="Re-crawl this camp's website and replace this proposal with fresh results"
        >
          {loading === 'recrawl' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Recrawl
        </button>
      </div>
      {recrawlMsg && (
        <p className="text-xs text-pine-600 bg-pine-50 border border-pine-200/60 rounded-lg px-3 py-2">{recrawlMsg}</p>
      )}
      {errorMessage && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {!proposedCollapsed && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Proposed Changes list ─────────────────────────────── */}
        <div className="lg:col-span-2 space-y-3">

          {/* Already-applied fields (greyed out) */}
          {alreadyApplied.size > 0 && (
            <div className="space-y-2 opacity-60">
              {Array.from(alreadyApplied).filter(f => proposal.proposedChanges[f]).map(field => (
                <div key={field} className="rounded-2xl border border-pine-200/60 bg-pine-50/20 px-4 py-2.5 flex items-center gap-3">
                  <BookmarkCheck className="w-4 h-4 text-pine-500 shrink-0" />
                  <span className="text-sm font-medium text-bark-500">{FIELD_LABELS[field] ?? field}</span>
                  <span className="text-xs text-pine-500 font-medium ml-1">Applied</span>
                  <span className="text-xs text-bark-300 ml-auto truncate max-w-[200px]">
                    {formatValue(proposal.proposedChanges[field].new)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {fields.map(([field, diff]) => {
            const isSelected = selected.has(field);
            const isArray = Array.isArray(diff.new);
            const isExpandable = isArray || String(diff.new).length > 120;
            const isExpanded = expanded.has(field);
            const conf = Math.round(diff.confidence * 100);
            const isPopulate = diff.old === null || diff.old === '' || diff.old === undefined;
            const isEditingProposed = editing[field] !== undefined;

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
                      <span className={cn(
                        'text-xs px-1.5 py-0.5 rounded-full font-medium',
                        isPopulate ? 'bg-blue-100 text-blue-600' : 'bg-amber-100 text-amber-700'
                      )}>
                        {isPopulate ? 'new data' : 'update'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs text-bark-300 mb-1 uppercase tracking-wide">Current</p>
                        <FieldValue value={diff.old} field={field} expanded={isExpanded} />
                      </div>
                      <div>
                        <p className="text-xs text-pine-400 mb-1 uppercase tracking-wide flex items-center gap-1">
                          Proposed
                          {!isArray && !isEditingProposed && (
                            <button
                              onClick={() => startEdit(field, diff.new)}
                              className="text-bark-300 hover:text-pine-500 ml-1"
                              title="Edit proposed value"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                        </p>
                        {isEditingProposed ? (
                          <div className="flex items-start gap-1">
                            <FieldInput
                              field={field}
                              value={editing[field] ?? ''}
                              onChange={v => setEditing(prev => ({ ...prev, [field]: v }))}
                              onCommit={() => commitEdit(field)}
                              onCancel={() => cancelEdit(field)}
                            />
                            <div className="flex flex-col gap-1">
                              <button onClick={() => commitEdit(field)} className="text-pine-500 hover:text-pine-700 p-1 shrink-0"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => cancelEdit(field)} className="text-bark-300 hover:text-red-400 p-1 shrink-0"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          </div>
                        ) : (
                          <FieldValue value={diff.new} field={field} expanded={isExpanded} highlight />
                        )}
                      </div>
                    </div>

                    {/* Excerpt + source link */}
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
                              <Link2 className="w-3 h-3 shrink-0" />
                              {diff.sourceUrl.replace(/^https?:\/\//, '').slice(0, 70)}
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    {isExpandable && !isEditingProposed && (
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

        {/* ── Actions sidebar ───────────────────────────────────── */}
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
              {queueContext?.campHref && (
                <Link href={queueContext.campHref} className="btn-secondary w-full gap-2">
                  <ExternalLink className="w-4 h-4" />
                  Open Camp Data
                </Link>
              )}
              <button
                onClick={handleApprove}
                disabled={loading !== null || selected.size === 0}
                className="btn-primary w-full gap-2 disabled:opacity-50"
                title="Apply selected fields and close this proposal"
              >
                {loading === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Apply & Resolve
              </button>
              <button
                onClick={handleApproveAndNext}
                disabled={loading !== null || selected.size === 0 || !queueContext?.nextHref}
                className="btn-secondary w-full gap-2 disabled:opacity-50"
                title="Apply selected fields and move straight to the next proposal in this queue"
              >
                {loading === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                Apply & Next
              </button>
              <button
                onClick={handleKeep}
                disabled={loading !== null || selected.size === 0}
                className="btn-secondary w-full gap-2 disabled:opacity-50"
                title="Apply selected fields but keep this proposal in queue for future review"
              >
                {loading === 'keep' ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookmarkCheck className="w-4 h-4" />}
                Apply & Keep Reviewing
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

          <div className="glass-panel p-5 space-y-3">
            <h3 className="font-semibold text-bark-600 mb-1 text-sm">Source</h3>
            <a
              href={proposal.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-1.5 text-xs text-pine-500 hover:text-pine-700 break-all leading-relaxed"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {proposal.sourceUrl.replace(/^https?:\/\//, '')}
            </a>

            {proposal.crawlRunId && (
              <a
                href={`/admin/crawls?runId=${proposal.crawlRunId}`}
                className="flex items-center gap-1.5 text-xs text-pine-500 hover:text-pine-700"
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0" />
                View crawl run logs
                {proposal.crawlStartedAt && (
                  <span className="text-bark-300 ml-1">
                    · {new Date(proposal.crawlStartedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
              </a>
            )}

            <div className="border-t border-cream-300 pt-3 space-y-1 text-xs text-bark-400">
              <p>Model: <span className="font-mono">{proposal.extractionModel}</span></p>
              <p>Proposed: {new Date(proposal.createdAt).toLocaleString()}</p>
              {proposal.crawlTriggeredBy && <p>Triggered by: {proposal.crawlTriggeredBy}</p>}
              <p>{fields.length + alreadyApplied.size} field{(fields.length + alreadyApplied.size) !== 1 ? 's' : ''} in proposal</p>
            </div>
          </div>

          {/* Crawl hint */}
          <div className="glass-panel p-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
              <h3 className="text-xs font-semibold text-bark-500 uppercase tracking-wide">Add Crawl Hint</h3>
              {savedHints > 0 && <span className="ml-auto text-xs text-pine-500">{savedHints} saved</span>}
            </div>
            <p className="text-xs text-bark-300 mb-2">
              Teach future crawls how to extract correctly from <span className="font-mono">{campDomain}</span>
            </p>
            <textarea
              value={hintText}
              onChange={e => setHintText(e.target.value)}
              placeholder={`e.g. "Session Full means FULL status, not CLOSED"`}
              rows={2}
              className="w-full text-xs border border-cream-400/60 rounded-lg p-2 focus:outline-none focus:border-pine-400 resize-none bg-cream-50 dark:bg-bark-700 dark:border-bark-500 dark:text-cream-200"
            />
            <button
              disabled={!hintText.trim() || savingHint}
              onClick={async () => {
                setSavingHint(true);
                const res = await fetch('/api/admin/site-hints', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ domain: campDomain, hint: hintText, source: 'from_review', sourceId: proposal.id }),
                });
                if (res.ok) { setHintText(''); setSavedHints(n => n + 1); }
                setSavingHint(false);
              }}
              className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 disabled:opacity-40 transition-colors"
            >
              {savingHint ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lightbulb className="w-3 h-3" />}
              Save hint for {campDomain}
            </button>
          </div>
        </div>
      </div>
      )} {/* end !proposedCollapsed */}

      {/* ── Current Camp Data (collapsed by default) ─── */}
      <div>
        <button
          onClick={() => setSnapshotCollapsed(v => !v)}
          className="flex items-center gap-1.5 font-semibold text-bark-600 text-sm uppercase tracking-wide hover:text-bark-700 mb-3"
        >
          {snapshotCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          Current Camp Data
        </button>
        {!snapshotCollapsed && campSnapshot}
      </div>
    </div>
  );
}

function compareFieldPriority(fieldA: string, fieldB: string) {
  const priorityA = FIELD_PRIORITY[fieldA] ?? 100;
  const priorityB = FIELD_PRIORITY[fieldB] ?? 100;
  if (priorityA !== priorityB) return priorityA - priorityB;
  return fieldA.localeCompare(fieldB);
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/)) {
    return new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return String(val);
}

function FieldValue({ value, field, expanded, highlight }: {
  value: unknown; field: string; expanded: boolean; highlight?: boolean;
}) {
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
  // For enum fields, show the human-readable label
  if (ENUM_OPTIONS[field]) {
    const label = labelFor(field, str);
    return <p className={cn('leading-relaxed', highlight ? 'text-pine-700 font-medium' : 'text-bark-500')}>{label}</p>;
  }

  const text = !expanded && str.length > 120 ? str.slice(0, 120) + '…' : str;
  return (
    <p className={cn('leading-relaxed', highlight ? 'text-pine-700' : 'text-bark-500')}>
      {text}
    </p>
  );
}

/** Input that renders a <select> for enum fields, <textarea> for long text, <input> otherwise */
function FieldInput({ field, value, onChange, onCommit, onCancel }: {
  field: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const enumOpts = ENUM_OPTIONS[field];

  if (enumOpts) {
    return (
      <select
        autoFocus
        value={value}
        onChange={e => { onChange(e.target.value); }}
        onKeyDown={e => { if (e.key === 'Escape') onCancel(); }}
        onBlur={onCommit}
        className="flex-1 text-xs border border-pine-300 rounded px-2 py-1 focus:outline-none focus:border-pine-500 bg-white"
      >
        {enumOpts.map(o => (
          <option
            key={o.value}
            value={o.value}
            title={field === 'campType' ? CAMP_TYPE_DESCRIPTIONS[o.value as keyof typeof CAMP_TYPE_DESCRIPTIONS] : undefined}
          >
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  const isLong = value.length > 80 || field === 'description' || field === 'interestingDetails' || field === 'notes';
  if (isLong) {
    return (
      <textarea
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onCommit(); } if (e.key === 'Escape') onCancel(); }}
        rows={3}
        className="flex-1 text-xs border border-pine-300 rounded px-2 py-1 focus:outline-none focus:border-pine-500 bg-white resize-none"
      />
    );
  }

  return (
    <input
      autoFocus
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
      className="flex-1 text-xs border border-pine-300 rounded px-2 py-1 focus:outline-none focus:border-pine-500 bg-white"
    />
  );
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  if (body && typeof body.error === 'string' && body.error.trim()) {
    return body.error;
  }
  return fallback;
}
