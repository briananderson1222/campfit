'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Check, X, Pencil, Loader2, ExternalLink, AlertCircle,
  Plus, Trash2, ToggleLeft, ToggleRight, ClipboardList,
  Lightbulb, ShieldCheck, Building2, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ENUM_OPTIONS, labelFor } from '@/lib/enums';
import { computeCoverage, REQUIRED_FOR_VERIFIED } from '@/lib/admin/verification';

interface FieldSource { excerpt: string | null; sourceUrl: string; approvedAt: string; }

interface Camp {
  id: string; name: string; slug: string; communitySlug: string;
  organizationName: string | null; providerId: string | null;
  description: string | null; notes: string | null;
  campType: string | null; category: string | null; websiteUrl: string | null;
  interestingDetails: string | null; city: string | null; neighborhood: string | null;
  address: string | null; lunchIncluded: boolean | null;
  registrationOpenDate: string | null; registrationStatus: string | null;
  dataConfidence: string | null; lastVerifiedAt: string | null;
  fieldSources: Record<string, FieldSource> | null;
  createdAt: string; updatedAt: string;
  ageGroups: AgeGroup[];
  schedules: { id: string; label: string; startDate: string; endDate: string; startTime: string | null; endTime: string | null }[];
  pricing: { id: string; label: string; amount: number; unit: string }[];
}

interface Provider { id: string; name: string; domain: string | null; }

interface AgeGroup {
  id: string; label: string;
  minAge: number | null; maxAge: number | null;
  minGrade: number | null; maxGrade: number | null;
}

interface PendingProposal {
  id: string; createdAt: string; overallConfidence: number;
  fieldCount: number | null; appliedFields: string[];
}

interface SiteHint {
  id: string; domain: string; hint: string; source: string;
  sourceId: string | null; active: boolean; createdBy: string; createdAt: string;
}

// ── Coverage meter ────────────────────────────────────────────────────────────

function CoverageMeter({ campId, camp, fieldSources: initialFieldSources }: {
  campId: string; camp: Camp; fieldSources: Record<string, FieldSource> | null;
}) {
  const [fieldSources, setFieldSources] = useState(initialFieldSources);
  const [attesting, setAttesting] = useState<string | null>(null);

  const campLike = { ...camp, ageGroups: camp.ageGroups, pricing: camp.pricing, schedules: camp.schedules };
  const { covered, missing, unattested, pct } = computeCoverage(campLike as never, fieldSources);
  const isVerified = missing.length === 0 && unattested.length === 0;
  const color = isVerified ? 'bg-pine-500' : pct >= 67 ? 'bg-amber-400' : 'bg-red-400';

  async function attest(field: string) {
    setAttesting(field);
    const res = await fetch(`/api/admin/camps/${campId}/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: [field] }),
    }).catch(() => null);
    if (res?.ok) {
      const now = new Date().toISOString();
      setFieldSources(prev => ({
        ...(prev ?? {}),
        [field]: { excerpt: null, sourceUrl: 'admin:attested', approvedAt: now },
      }));
    }
    setAttesting(null);
  }

  return (
    <div className="rounded-xl border border-cream-300 dark:border-bark-500 p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-bark-500 dark:text-cream-300 uppercase tracking-wide">
          Field Coverage
        </span>
        <span className={cn(
          'text-xs font-bold px-2 py-0.5 rounded-full',
          isVerified ? 'bg-pine-100 text-pine-700 dark:bg-pine-900/30 dark:text-pine-300'
            : pct >= 67 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
        )}>
          {covered.length}/{REQUIRED_FOR_VERIFIED.length} attested
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-cream-200 dark:bg-bark-600 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      {missing.length > 0 && (
        <div className="space-y-1 pt-0.5">
          <p className="text-xs text-bark-300">Have value but need source — tap to attest directly:</p>
          <div className="flex flex-wrap gap-1.5">
            {missing.map(f => (
              <button key={f} onClick={() => attest(f)} disabled={attesting === f}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200/60 dark:border-red-700/30 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50">
                {attesting === f ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
      {unattested.length > 0 && (
        <div className="space-y-1 pt-0.5">
          <p className="text-xs text-bark-300">Blank — tap to mark as N/A / intentionally blank:</p>
          <div className="flex flex-wrap gap-1.5">
            {unattested.map(f => (
              <button key={f} onClick={() => attest(f)} disabled={attesting === f}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200/60 dark:border-amber-700/30 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-50">
                {attesting === f ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
      {isVerified && (
        <p className="text-xs text-pine-600 dark:text-pine-400 flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5" />
          All required fields attested — auto-VERIFIED on next approval
        </p>
      )}
    </div>
  );
}

// ── Provider field ────────────────────────────────────────────────────────────

function ProviderField({ campId, providerId, organizationName, provider }: {
  campId: string;
  providerId: string | null;
  organizationName: string | null;
  provider: Provider | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(organizationName ?? '');
  const [saving, setSaving] = useState(false);
  const [currentOrgName, setCurrentOrgName] = useState(organizationName);

  async function save() {
    setSaving(true);
    await fetch(`/api/admin/camps/${campId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizationName: draft || null }),
    });
    setSaving(false);
    setCurrentOrgName(draft || null);
    setEditing(false);
  }

  if (provider) {
    return (
      <div>
        <dt className="text-xs text-bark-300 dark:text-bark-300 font-semibold uppercase tracking-wide mb-0.5">Provider</dt>
        <dd className="flex items-center gap-2">
          <Building2 className="w-3.5 h-3.5 text-pine-500 shrink-0" />
          <Link href={`/admin/providers/${provider.id}`}
            className="text-sm text-pine-600 hover:text-pine-700 dark:text-pine-400 dark:hover:text-pine-300 transition-colors">
            {provider.name}
          </Link>
          {provider.domain && <span className="text-xs text-bark-300">{provider.domain}</span>}
        </dd>
      </div>
    );
  }

  return (
    <div className="group">
      <dt className="text-xs text-bark-300 dark:text-bark-300 font-semibold uppercase tracking-wide mb-0.5">Organization</dt>
      <dd className="flex items-start gap-2">
        {editing ? (
          <div className="flex-1 flex items-start gap-1.5">
            <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(currentOrgName ?? ''); setEditing(false); } }}
              placeholder="Organization name…"
              className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400" />
            <button onClick={save} disabled={saving}
              className="p-1.5 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40 mt-0.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={() => { setDraft(currentOrgName ?? ''); setEditing(false); }}
              className="p-1.5 rounded-lg text-bark-300 hover:bg-cream-100 mt-0.5"><X className="w-4 h-4" /></button>
          </div>
        ) : (
          <div className="flex-1 flex items-start justify-between gap-2">
            <span className={cn('text-sm', !currentOrgName ? 'text-bark-200 italic' : 'text-bark-600 dark:text-cream-300')}>
              {currentOrgName || 'No organization'}
            </span>
            <button onClick={() => setEditing(true)}
              className="sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded text-bark-300 hover:text-bark-500 hover:bg-cream-100 dark:hover:bg-bark-600 transition-all shrink-0">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </dd>
      {!currentOrgName && (
        <p className="text-xs text-bark-200 mt-1">
          Set org name, then run <code className="bg-cream-100 dark:bg-bark-700 px-1 rounded">npm run backfill:providers</code> to create a Provider record.
        </p>
      )}
    </div>
  );
}

// ── Neighborhood autocomplete input ──────────────────────────────────────────

function NeighborhoodField({ campId, value, communitySlug }: { campId: string; value: string | null; communitySlug: string }) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const listId = `nbhd-${campId}`;

  useEffect(() => {
    fetch(`/api/admin/neighborhoods?community=${communitySlug}`)
      .then(r => r.json()).then(setOptions).catch(() => {});
  }, [communitySlug]);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/admin/camps/${campId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ neighborhood: draft || null }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      // If the typed value isn't in the list, add it to the community reference
      if (draft && !options.includes(draft)) {
        fetch('/api/admin/neighborhoods', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ communitySlug, name: draft }),
        }).catch(() => {});
        setOptions(prev => [...prev, draft].sort());
      }
      setCurrent(draft || null);
      setEditing(false);
    }
  }

  return (
    <div className="group">
      <dt className="text-xs text-bark-300 dark:text-bark-300 font-semibold uppercase tracking-wide mb-0.5">Neighborhood</dt>
      <dd className="flex items-start gap-2">
        {editing ? (
          <div className="flex-1 flex items-start gap-1.5">
            <datalist id={listId}>
              {options.map(n => <option key={n} value={n} />)}
            </datalist>
            <input
              autoFocus list={listId} value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setDraft(current ?? ''); setEditing(false); } }}
              placeholder="Start typing or select…"
              className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400"
            />
            <button onClick={save} disabled={saving}
              className="p-1.5 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40 mt-0.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={() => { setDraft(current ?? ''); setEditing(false); }}
              className="p-1.5 rounded-lg text-bark-300 hover:bg-cream-100 mt-0.5"><X className="w-4 h-4" /></button>
          </div>
        ) : (
          <div className="flex-1 flex items-start justify-between gap-2">
            <span className={cn('text-sm', !current ? 'text-bark-200 italic' : 'text-bark-600 dark:text-cream-300')}>
              {current || 'Not set'}
            </span>
            <button onClick={() => { setDraft(current ?? ''); setEditing(true); }}
              className="sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded text-bark-300 hover:text-bark-500 hover:bg-cream-100 dark:hover:bg-bark-600 transition-all shrink-0">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}

// ── Age group editor ──────────────────────────────────────────────────────────

function AgeGroupsEditor({ campId, initial }: { campId: string; initial: AgeGroup[] }) {
  const [groups, setGroups] = useState<AgeGroup[]>(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Omit<AgeGroup, 'id'>[]>([]);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(groups.map(g => ({ label: g.label, minAge: g.minAge, maxAge: g.maxAge, minGrade: g.minGrade, maxGrade: g.maxGrade })));
    setEditing(true);
  }

  function updateRow(i: number, field: keyof Omit<AgeGroup, 'id'>, val: string) {
    setDraft(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const numVal = val === '' ? null : Number(val);
      return { ...r, [field]: field === 'label' ? val : (isNaN(numVal as number) ? null : numVal) };
    }));
  }

  function addRow() {
    setDraft(prev => [...prev, { label: '', minAge: null, maxAge: null, minGrade: null, maxGrade: null }]);
  }

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/admin/camps/${campId}/age-groups`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ageGroups: draft.filter(r => r.label.trim()) }),
    });
    if (res.ok) {
      const saved = await res.json();
      setGroups(saved);
      setEditing(false);
    }
    setSaving(false);
  }

  if (!editing) {
    return (
      <div className="glass-panel p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide">Age Groups</h2>
          <button onClick={startEdit}
            className="flex items-center gap-1 text-xs text-bark-300 hover:text-bark-500 dark:hover:text-cream-300 transition-colors">
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="text-sm text-bark-200 italic">Not set</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groups.map(ag => (
              <span key={ag.id} className="text-xs px-2.5 py-1 bg-cream-100 dark:bg-bark-700 border border-cream-300 dark:border-bark-500 rounded-full text-bark-500 dark:text-cream-300">
                {ag.label}
                {(ag.minAge != null || ag.maxAge != null) && (
                  <span className="text-bark-300 ml-1">
                    {ag.minAge != null && ag.maxAge != null ? `${ag.minAge}–${ag.maxAge} yrs`
                      : ag.minAge != null ? `${ag.minAge}+ yrs`
                      : `up to ${ag.maxAge} yrs`}
                  </span>
                )}
                {(ag.minGrade != null || ag.maxGrade != null) && (
                  <span className="text-bark-300 ml-1">
                    {ag.minGrade != null && ag.maxGrade != null ? `Gr ${ag.minGrade}–${ag.maxGrade}`
                      : ag.minGrade != null ? `Gr ${ag.minGrade}+`
                      : `up to Gr ${ag.maxGrade}`}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-bark-200 mt-2">
          minAge/maxAge values power age filters — keep them accurate. Label is display-only.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide">Age Groups</h2>
        <p className="text-xs text-bark-300">Editing — changes replace all existing groups</p>
      </div>

      <div className="space-y-2 mb-3">
        <div className="grid grid-cols-[1fr_60px_60px_60px_60px_28px] gap-1.5 text-xs text-bark-300 font-semibold uppercase tracking-wide px-1">
          <span>Label</span><span>Min Age</span><span>Max Age</span><span>Min Gr</span><span>Max Gr</span><span />
        </div>
        {draft.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_60px_60px_60px_60px_28px] gap-1.5 items-center">
            <input value={row.label} onChange={e => updateRow(i, 'label', e.target.value)}
              placeholder="e.g. K–2nd, Ages 6–8"
              className="text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2 py-1 focus:outline-none focus:border-pine-400" />
            {(['minAge','maxAge','minGrade','maxGrade'] as const).map(f => (
              <input key={f} type="number" min={0} max={99}
                value={row[f] ?? ''} onChange={e => updateRow(i, f, e.target.value)}
                className="text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2 py-1 focus:outline-none focus:border-pine-400 text-center" />
            ))}
            <button onClick={() => setDraft(prev => prev.filter((_, idx) => idx !== i))}
              className="p-1 text-bark-200 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>

      <button onClick={addRow}
        className="flex items-center gap-1 text-xs text-pine-500 hover:text-pine-700 mb-4">
        <Plus className="w-3.5 h-3.5" /> Add row
      </button>

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl bg-pine-600 text-white hover:bg-pine-700 disabled:opacity-50 transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Save age groups
        </button>
        <button onClick={() => setEditing(false)}
          className="text-sm px-3 py-1.5 rounded-xl text-bark-400 hover:bg-cream-100 dark:hover:bg-bark-600 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Editable field (generic) ──────────────────────────────────────────────────

function EditableField({
  campId, field, label, value, type = 'text',
}: {
  campId: string; field: string; label: string;
  value: string | null | boolean; type?: 'text' | 'textarea' | 'select' | 'boolean' | 'date';
}) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [draft, setDraft] = useState(String(value ?? ''));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const r = await fetch(`/api/admin/camps/${campId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: type === 'boolean' ? draft === 'true' : draft || null }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) { setCurrent(type === 'boolean' ? draft === 'true' : draft || null); setEditing(false); }
  }

  function cancel() { setDraft(String(current ?? '')); setEditing(false); }

  const rawDisplay = type === 'boolean'
    ? (current === true || current === 'true' ? 'Yes' : current === false || current === 'false' ? 'No' : '—')
    : (current as string) || null;
  const displayValue = rawDisplay && ENUM_OPTIONS[field] ? labelFor(field, rawDisplay) : rawDisplay;

  return (
    <div className="group">
      <dt className="text-xs text-bark-300 dark:text-bark-300 font-semibold uppercase tracking-wide mb-0.5">{label}</dt>
      <dd className="flex items-start gap-2">
        {editing ? (
          <div className="flex-1 flex items-start gap-1.5">
            {type === 'textarea' ? (
              <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={4}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400 resize-none" />
            ) : (type === 'select' || ENUM_OPTIONS[field]) ? (
              <select autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400">
                <option value="">— unset —</option>
                {(ENUM_OPTIONS[field] ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : type === 'boolean' ? (
              <select autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400">
                <option value="">— unset —</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input autoFocus type={type === 'date' ? 'date' : 'text'} value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400" />
            )}
            <button onClick={save} disabled={saving}
              className="p-1.5 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40 transition-colors mt-0.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={cancel}
              className="p-1.5 rounded-lg text-bark-300 hover:bg-cream-100 transition-colors mt-0.5">
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex-1 flex items-start justify-between gap-2">
            <span className={cn('text-sm', !displayValue ? 'text-bark-200 italic' : 'text-bark-600 dark:text-cream-300')}>
              {displayValue || 'Not set'}
              {field === 'websiteUrl' && displayValue && (
                <a href={displayValue as string} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 ml-1.5 text-pine-500 hover:text-pine-600">
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </span>
            <button onClick={() => { setDraft(String(current ?? '')); setEditing(true); }}
              className="sm:opacity-0 sm:group-hover:opacity-100 p-1 rounded text-bark-300 hover:text-bark-500 hover:bg-cream-100 dark:hover:bg-bark-600 transition-all shrink-0"
              title={`Edit ${label}`}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </dd>
    </div>
  );
}

// ── Crawl button ──────────────────────────────────────────────────────────────

function CrawlButton({ campId, websiteUrl }: { campId: string; websiteUrl: string | null }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  if (!websiteUrl) return null;

  async function crawl() {
    setStatus('loading');
    setMsg('');
    const res = await fetch(`/api/admin/camps/${campId}/crawl`, { method: 'POST' }).catch(() => null);
    if (res?.ok) {
      setStatus('done');
      setMsg('Crawling… check back in ~30s for a new proposal.');
    } else {
      setStatus('error');
      setMsg('Failed to start crawl.');
    }
    setTimeout(() => { setStatus('idle'); setMsg(''); }, 10000);
  }

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-bark-400 dark:text-bark-300">{msg}</span>}
      <button
        onClick={crawl}
        disabled={status === 'loading'}
        className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-cream-300 dark:border-bark-500 text-bark-400 hover:text-pine-600 hover:border-pine-300 dark:hover:border-pine-500 dark:hover:text-pine-400 transition-colors disabled:opacity-50"
        title="Crawl this camp's website and generate a change proposal"
      >
        {status === 'loading'
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RefreshCw className="w-3.5 h-3.5" />}
        {status === 'loading' ? 'Crawling…' : 'Crawl'}
      </button>
    </div>
  );
}

// ── Mark Verified button ──────────────────────────────────────────────────────

function MarkVerifiedButton({ campId, initial }: { campId: string; initial: string | null }) {
  const [confidence, setConfidence] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function markVerified() {
    setSaving(true);
    const res = await fetch(`/api/admin/camps/${campId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_verified' }),
    });
    if (res.ok) setConfidence('VERIFIED');
    setSaving(false);
  }

  const isVerified = confidence === 'VERIFIED';
  return (
    <button
      onClick={isVerified ? undefined : markVerified}
      disabled={saving || isVerified}
      className={cn(
        'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors',
        isVerified
          ? 'border-pine-300 bg-pine-50 dark:bg-pine-900/20 text-pine-600 dark:text-pine-300 cursor-default'
          : 'border-cream-300 dark:border-bark-500 text-bark-400 hover:border-pine-300 hover:text-pine-600 hover:bg-pine-50 dark:hover:bg-pine-900/20'
      )}
      title={isVerified ? 'All key fields confirmed accurate' : 'Mark this record as fully verified (use when all key fields are confirmed from source)'}
    >
      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
      {isVerified ? 'Verified' : 'Mark as Verified'}
    </button>
  );
}

// ── Site hints ────────────────────────────────────────────────────────────────

function SiteHintsSection({ domain, initialHints }: { domain: string; initialHints: SiteHint[] }) {
  const [hints, setHints] = useState<SiteHint[]>(initialHints);
  const [newHint, setNewHint] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  async function addHint() {
    if (!newHint.trim()) return;
    setAdding(true);
    const res = await fetch('/api/admin/site-hints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, hint: newHint }),
    });
    if (res.ok) { const h = await res.json(); setHints(p => [...p, h]); setNewHint(''); setShowAdd(false); }
    setAdding(false);
  }

  async function toggleActive(hint: SiteHint) {
    const res = await fetch(`/api/admin/site-hints/${hint.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !hint.active }),
    });
    if (res.ok) setHints(p => p.map(h => h.id === hint.id ? { ...h, active: !h.active } : h));
  }

  async function deleteHint(id: string) {
    const res = await fetch(`/api/admin/site-hints/${id}`, { method: 'DELETE' });
    if (res.ok) setHints(p => p.filter(h => h.id !== id));
  }

  return (
    <div className="glass-panel p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide">Crawl Hints</h2>
          <p className="text-xs text-bark-300 mt-0.5">
            Injected into the LLM prompt when crawling <span className="font-mono">{domain}</span>
          </p>
        </div>
        <button onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-cream-300 dark:border-bark-500 text-bark-400 hover:text-pine-600 hover:border-pine-300 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add hint
        </button>
      </div>

      {hints.length === 0 && !showAdd && (
        <p className="text-xs text-bark-300 italic">No hints yet. Add one to guide future extractions for this site.</p>
      )}
      <div className="space-y-2">
        {hints.map(h => (
          <div key={h.id} className={cn(
            'flex items-start gap-2.5 rounded-xl px-3 py-2.5 border text-sm transition-opacity',
            h.active ? 'bg-pine-50/30 dark:bg-pine-900/20 border-pine-200/60 dark:border-pine-700/40'
                     : 'bg-cream-100/40 dark:bg-bark-700/30 border-cream-300/40 opacity-50'
          )}>
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm leading-relaxed', h.active ? 'text-bark-600 dark:text-cream-300' : 'text-bark-300 line-through')}>{h.hint}</p>
              <p className="text-xs text-bark-300 mt-0.5">
                {h.source === 'from_review' ? '↳ from review' : 'manual'} · {h.createdBy} · {new Date(h.createdAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => toggleActive(h)} title={h.active ? 'Disable' : 'Enable'}
                className="p-1 text-bark-300 hover:text-pine-500 transition-colors">
                {h.active ? <ToggleRight className="w-4 h-4 text-pine-500" /> : <ToggleLeft className="w-4 h-4" />}
              </button>
              <button onClick={() => deleteHint(h.id)} className="p-1 text-bark-300 hover:text-red-400 transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {showAdd && (
        <div className="mt-3 flex items-end gap-2">
          <textarea autoFocus value={newHint} onChange={e => setNewHint(e.target.value)} rows={2}
            placeholder={`e.g. "Session Full means FULL status, not CLOSED"`}
            className="flex-1 text-sm border border-pine-300 dark:border-pine-600 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-3 py-2 focus:outline-none focus:border-pine-500 resize-none"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addHint(); } if (e.key === 'Escape') setShowAdd(false); }} />
          <div className="flex flex-col gap-1">
            <button onClick={addHint} disabled={adding || !newHint.trim()}
              className="p-2 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={() => setShowAdd(false)} className="p-2 rounded-lg text-bark-300 hover:bg-cream-100 dark:hover:bg-bark-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main editor ───────────────────────────────────────────────────────────────

export function CampEditor({
  camp, pendingProposals = [], siteHints = [], domain = '', provider = null,
}: {
  camp: Camp; pendingProposals?: PendingProposal[];
  siteHints?: SiteHint[]; domain?: string; provider?: Provider | null;
}) {
  return (
    <div className="space-y-5">
      {/* Pending proposals banner */}
      {pendingProposals.length > 0 && (
        <div className="rounded-2xl border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 dark:border-amber-700/40 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                {pendingProposals.length} pending proposal{pendingProposals.length !== 1 ? 's' : ''}
              </p>
              <div className="mt-2 space-y-1.5">
                {pendingProposals.map(p => {
                  const pending = (p.fieldCount ?? 0) - (p.appliedFields?.length ?? 0);
                  return (
                    <Link key={p.id} href={`/admin/review/${p.id}`}
                      className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 hover:text-pine-600 dark:hover:text-pine-300 transition-colors group">
                      <ClipboardList className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {pending} field change{pending !== 1 ? 's' : ''} to review
                        {p.appliedFields?.length > 0 && <span className="text-amber-500 ml-1">· {p.appliedFields.length} already applied</span>}
                      </span>
                      <span className="text-amber-400">· {Math.round(p.overallConfidence * 100)}% · {new Date(p.createdAt).toLocaleDateString()}</span>
                      <span className="sm:opacity-0 sm:group-hover:opacity-100 text-pine-500 ml-auto">Review →</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Field coverage meter */}
      <CoverageMeter campId={camp.id} camp={camp} fieldSources={camp.fieldSources} />

      {/* Core info */}
      <div className="glass-panel p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide">Core Info</h2>
          <div className="flex items-center gap-2">
            <CrawlButton campId={camp.id} websiteUrl={camp.websiteUrl} />
            <MarkVerifiedButton campId={camp.id} initial={camp.dataConfidence} />
          </div>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <EditableField campId={camp.id} field="name" label="Name" value={camp.name} />
          <ProviderField campId={camp.id} providerId={camp.providerId} organizationName={camp.organizationName} provider={provider} />
          <EditableField campId={camp.id} field="websiteUrl" label="Website URL" value={camp.websiteUrl} />
          <EditableField campId={camp.id} field="campType" label="Camp Type" value={camp.campType} type="select" />
          <EditableField campId={camp.id} field="category" label="Category" value={camp.category} type="select" />
          <EditableField campId={camp.id} field="registrationStatus" label="Registration Status" value={camp.registrationStatus} type="select" />
          <EditableField campId={camp.id} field="registrationOpenDate" label="Registration Open Date" value={camp.registrationOpenDate} type="date" />
          <EditableField campId={camp.id} field="dataConfidence" label="Data Confidence" value={camp.dataConfidence} type="select" />
          <EditableField campId={camp.id} field="lunchIncluded" label="Lunch Included" value={camp.lunchIncluded} type="boolean" />
        </dl>
      </div>

      {/* Description */}
      <div className="glass-panel p-5">
        <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-4">Description & Details</h2>
        <dl className="space-y-4">
          <EditableField campId={camp.id} field="description" label="Description (public)" value={camp.description} type="textarea" />
          <EditableField campId={camp.id} field="interestingDetails" label="Interesting Details (public callout)" value={camp.interestingDetails} type="textarea" />
          <EditableField campId={camp.id} field="notes" label="Internal Notes (admin only — not shown publicly)" value={camp.notes} type="textarea" />
        </dl>
      </div>

      {/* Location */}
      <div className="glass-panel p-5">
        <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-4">Location</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          <EditableField campId={camp.id} field="city" label="City" value={camp.city} />
          <NeighborhoodField campId={camp.id} value={camp.neighborhood} communitySlug={camp.communitySlug} />
          <div className="sm:col-span-2">
            <EditableField campId={camp.id} field="address" label="Street Address" value={camp.address} />
            <p className="text-xs text-bark-200 mt-1">Street address only (e.g. "4001 E Iliff Ave") — not the neighborhood name</p>
          </div>
        </dl>
      </div>

      {/* Age groups — editable */}
      <AgeGroupsEditor campId={camp.id} initial={camp.ageGroups} />

      {camp.schedules.length > 0 && (
        <div className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-3">
            Schedules ({camp.schedules.length} session{camp.schedules.length !== 1 ? 's' : ''})
          </h2>
          <div className="space-y-1.5">
            {camp.schedules.map(s => (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                <span className="text-bark-500 dark:text-cream-400 font-medium w-36 shrink-0">{s.label || 'Session'}</span>
                <span className="text-bark-400 dark:text-bark-300 text-xs">
                  {new Date(s.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' → '}
                  {new Date(s.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
                {s.startTime && <span className="text-bark-300 text-xs">{s.startTime}–{s.endTime}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {camp.pricing.length > 0 && (
        <div className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-3">Pricing</h2>
          <div className="space-y-1.5">
            {camp.pricing.map(p => (
              <div key={p.id} className="flex items-center gap-3 text-sm">
                <span className="text-bark-500 dark:text-cream-400 font-medium w-36 shrink-0">{p.label || 'Standard'}</span>
                <span className="text-bark-600 dark:text-cream-200 font-semibold">${p.amount}</span>
                <span className="text-bark-300 text-xs">{p.unit?.replace('_', ' ').toLowerCase()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Site hints — managed at provider level if linked */}
      {domain && provider ? (
        <div className="glass-panel p-5">
          <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-2">Crawl Hints</h2>
          <p className="text-sm text-bark-400 dark:text-bark-300">
            Hints for <span className="font-mono text-xs">{domain}</span> are managed at the provider level.{' '}
            <Link href={`/admin/providers/${provider.id}`} className="text-pine-600 hover:text-pine-700 dark:text-pine-400">
              Manage via {provider.name} →
            </Link>
          </p>
        </div>
      ) : domain ? (
        <SiteHintsSection domain={domain} initialHints={siteHints} />
      ) : null}

      {/* Metadata */}
      <div className="glass-panel p-5">
        <h2 className="font-display font-bold text-bark-600 dark:text-cream-200 text-sm uppercase tracking-wide mb-3">Metadata</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-y-3 text-xs">
          {([
            ['ID', camp.id],
            ['Slug', camp.slug],
            ['Community', camp.communitySlug],
            ['Created', new Date(camp.createdAt).toLocaleDateString()],
            ['Updated', new Date(camp.updatedAt).toLocaleDateString()],
            ['Last Verified', camp.lastVerifiedAt ? new Date(camp.lastVerifiedAt).toLocaleDateString() : 'Never'],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k}>
              <dt className="text-bark-300 font-semibold uppercase tracking-wide">{k}</dt>
              <dd className="text-bark-500 dark:text-cream-400 mt-0.5 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
