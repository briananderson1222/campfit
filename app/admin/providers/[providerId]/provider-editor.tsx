'use client';

import { useState } from 'react';
import {
  Check, X, Pencil, Loader2, ExternalLink,
  Plus, Trash2, ToggleLeft, ToggleRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Provider {
  id: string; name: string; slug: string;
  websiteUrl: string | null; domain: string | null; logoUrl: string | null;
  address: string | null; city: string | null; neighborhood: string | null;
  contactEmail: string | null; contactPhone: string | null;
  notes: string | null; crawlRootUrl: string | null; communitySlug: string;
}

interface SiteHint {
  id: string; hint: string; active: boolean; createdAt: string;
}

// ── Inline editable field ─────────────────────────────────────────────────────

function EditableField({
  providerId, field, label, value, type = 'text', helper,
}: {
  providerId: string; field: string; label: string;
  value: string | null; type?: 'text' | 'textarea' | 'url'; helper?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(value);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/admin/providers/${providerId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: draft.trim() || null }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) { setCurrent(draft.trim() || null); setEditing(false); }
  }

  function cancel() { setDraft(current ?? ''); setEditing(false); }

  return (
    <div className="group flex gap-3 py-2.5 border-b border-cream-200/50 dark:border-bark-600/30 last:border-0">
      <dt className="text-xs text-bark-300 uppercase tracking-wide w-36 shrink-0 pt-1">{label}</dt>
      <dd className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-start gap-1.5">
            {type === 'textarea' ? (
              <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)} rows={3}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400 resize-none" />
            ) : (
              <input autoFocus type={type} value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
                className="flex-1 text-sm border border-cream-300 dark:border-bark-500 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-pine-400" />
            )}
            <button onClick={save} disabled={saving}
              className="p-1.5 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40 mt-0.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={cancel}
              className="p-1.5 rounded-lg text-bark-300 hover:bg-cream-100 dark:hover:bg-bark-600 mt-0.5">
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <span className={cn('text-sm break-all', !current ? 'text-bark-200 italic' : 'text-bark-600 dark:text-cream-300')}>
              {current || '—'}
              {type === 'url' && current && (
                <a href={current} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 ml-1.5 text-pine-500 hover:text-pine-600">
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </span>
            <button onClick={() => { setDraft(current ?? ''); setEditing(true); }}
              className="opacity-0 group-hover:opacity-100 p-1 rounded text-bark-300 hover:text-bark-500 hover:bg-cream-100 dark:hover:bg-bark-600 transition-all shrink-0">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {helper && !editing && <p className="text-xs text-bark-200 mt-0.5">{helper}</p>}
      </dd>
    </div>
  );
}

// ── Site hints manager ────────────────────────────────────────────────────────

function SiteHintsSection({ domain, initialHints }: { domain: string | null; initialHints: SiteHint[] }) {
  const [hints, setHints] = useState<SiteHint[]>(initialHints);
  const [newHint, setNewHint] = useState('');
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  if (!domain) return (
    <p className="text-sm text-bark-300 italic">Set a website URL first — hints are keyed to the domain.</p>
  );

  async function addHint() {
    if (!newHint.trim()) return;
    setAdding(true);
    const res = await fetch('/api/admin/site-hints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, hint: newHint.trim() }),
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
    if (!confirm('Delete this crawl hint?')) return;
    const res = await fetch(`/api/admin/site-hints/${id}`, { method: 'DELETE' });
    if (res.ok) setHints(p => p.filter(h => h.id !== id));
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-bark-300">
        Injected into the LLM prompt for every camp crawled from <span className="font-mono">{domain}</span>
      </p>
      {hints.length === 0 && !showAdd && (
        <p className="text-sm text-bark-200 italic">No hints yet.</p>
      )}
      <div className="space-y-2">
        {hints.map(h => (
          <div key={h.id} className={cn(
            'flex items-start gap-2.5 rounded-xl px-3 py-2.5 border text-sm transition-opacity',
            h.active
              ? 'bg-pine-50/30 dark:bg-pine-900/20 border-pine-200/60 dark:border-pine-700/40'
              : 'bg-cream-100/40 dark:bg-bark-700/30 border-cream-300/40 opacity-50'
          )}>
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm leading-relaxed', h.active ? 'text-bark-600 dark:text-cream-300' : 'text-bark-300 line-through')}>
                {h.hint}
              </p>
              <p className="text-xs text-bark-300 mt-0.5">
                {new Date(h.createdAt).toLocaleDateString()}
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
      {showAdd ? (
        <div className="flex items-end gap-2 mt-2">
          <textarea autoFocus value={newHint} onChange={e => setNewHint(e.target.value)} rows={2}
            placeholder={`e.g. "Session Full means FULL status, not CLOSED"`}
            className="flex-1 text-sm border border-pine-300 dark:border-pine-600 dark:bg-bark-700 dark:text-cream-200 rounded-lg px-3 py-2 focus:outline-none focus:border-pine-500 resize-none"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addHint(); } if (e.key === 'Escape') setShowAdd(false); }} />
          <div className="flex flex-col gap-1">
            <button onClick={addHint} disabled={adding || !newHint.trim()}
              className="p-2 rounded-lg text-pine-600 hover:bg-pine-50 disabled:opacity-40">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button onClick={() => { setShowAdd(false); setNewHint(''); }}
              className="p-2 rounded-lg text-bark-300 hover:bg-cream-100 dark:hover:bg-bark-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-cream-300 dark:border-bark-500 text-bark-400 hover:text-pine-600 hover:border-pine-300 transition-colors mt-2">
          <Plus className="w-3.5 h-3.5" /> Add hint
        </button>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function ProviderEditor({ provider, siteHints }: { provider: Provider; siteHints: SiteHint[] }) {
  return (
    <div className="space-y-6">
      {/* Provider info — inline editable */}
      <div className="glass-panel p-6">
        <h2 className="font-display font-bold text-bark-700 dark:text-cream-200 mb-1">Provider Info</h2>
        <p className="text-xs text-bark-300 mb-4">Hover any field to edit inline.</p>
        <dl>
          <EditableField providerId={provider.id} field="name" label="Name" value={provider.name} />
          <EditableField providerId={provider.id} field="websiteUrl" label="Website" value={provider.websiteUrl} type="url" />
          <EditableField providerId={provider.id} field="crawlRootUrl" label="Crawl Root URL" value={provider.crawlRootUrl} type="url"
            helper="Entry point for discovery crawl — leave blank to use Website URL" />
          <EditableField providerId={provider.id} field="logoUrl" label="Logo URL" value={provider.logoUrl} type="url" />
          <EditableField providerId={provider.id} field="address" label="Address" value={provider.address} />
          <EditableField providerId={provider.id} field="city" label="City" value={provider.city} />
          <EditableField providerId={provider.id} field="neighborhood" label="Neighborhood" value={provider.neighborhood} />
          <EditableField providerId={provider.id} field="contactEmail" label="Contact Email" value={provider.contactEmail} />
          <EditableField providerId={provider.id} field="contactPhone" label="Contact Phone" value={provider.contactPhone} />
          <EditableField providerId={provider.id} field="notes" label="Internal Notes" value={provider.notes} type="textarea" />
        </dl>
      </div>

      {/* Crawl hints */}
      <div className="glass-panel p-6">
        <h2 className="font-display font-bold text-bark-700 dark:text-cream-200 mb-4">Crawl Hints</h2>
        <SiteHintsSection domain={provider.domain} initialHints={siteHints} />
      </div>
    </div>
  );
}
