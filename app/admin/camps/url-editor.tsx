'use client';

import { useState } from 'react';
import { Link2, Check, X, Loader2 } from 'lucide-react';

export function UrlEditor({ campId }: { campId: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    if (!value.startsWith('http')) return;
    setSaving(true);
    const r = await fetch(`/api/admin/camps/${campId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ websiteUrl: value.trim() }),
    }).catch(() => null);
    setSaving(false);
    if (r?.ok) {
      setSaved(true);
      // Reload page after short delay so the row updates
      setTimeout(() => window.location.reload(), 800);
    }
  }

  if (saved) {
    return (
      <span className="flex items-center gap-1 text-xs text-pine-600 font-medium">
        <Check className="w-3.5 h-3.5" /> Saved
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-red-500 hover:bg-red-100 transition-colors font-medium"
      >
        <Link2 className="w-3 h-3" /> Add URL
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 min-w-0">
      <input
        autoFocus
        type="url"
        placeholder="https://..."
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        className="text-xs border border-cream-300 rounded px-1.5 py-1 w-44 focus:outline-none focus:border-pine-400"
      />
      <button onClick={save} disabled={saving || !value.startsWith('http')}
        className="p-1 rounded text-pine-600 hover:bg-pine-50 disabled:opacity-40 transition-colors">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
      </button>
      <button onClick={() => setEditing(false)}
        className="p-1 rounded text-bark-300 hover:bg-cream-100 transition-colors">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
