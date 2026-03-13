'use client';

import { useState } from 'react';
import { Check, Loader2, Plus, Trash2 } from 'lucide-react';

type Contact = {
  id?: string;
  type: string;
  value: string;
  label?: string | null;
};

export function PersonEditor({
  person,
  contacts: initialContacts,
}: {
  person: { id: string; fullName: string; bio?: string | null };
  contacts: Contact[];
  campRoles: Array<Record<string, unknown>>;
  providerRoles: Array<Record<string, unknown>>;
}) {
  const [fullName, setFullName] = useState(person.fullName);
  const [bio, setBio] = useState(person.bio ?? '');
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    const res = await fetch(`/api/admin/people/${person.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName, bio, contacts }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setMessage(data?.error ?? 'Failed to save person');
      return;
    }
    setMessage('Saved');
  }

  return (
    <div className="glass-panel p-5 space-y-5">
      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-bark-300">Full Name</label>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="mt-1 w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wide text-bark-300">Bio</label>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm resize-none" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold text-bark-600">Contact Methods</h2>
          <button
            onClick={() => setContacts((prev) => [...prev, { type: 'EMAIL', value: '', label: '' }])}
            className="btn-secondary gap-1.5 text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Contact
          </button>
        </div>
        <div className="space-y-2">
          {contacts.map((contact, index) => (
            <div key={contact.id ?? index} className="grid grid-cols-1 sm:grid-cols-[120px_minmax(0,1fr)_160px_40px] gap-2">
              <input
                value={contact.type}
                onChange={(e) => setContacts((prev) => prev.map((item, i) => i === index ? { ...item, type: e.target.value } : item))}
                placeholder="Type"
                className="rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
              />
              <input
                value={contact.value}
                onChange={(e) => setContacts((prev) => prev.map((item, i) => i === index ? { ...item, value: e.target.value } : item))}
                placeholder="Value"
                className="rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
              />
              <input
                value={contact.label ?? ''}
                onChange={(e) => setContacts((prev) => prev.map((item, i) => i === index ? { ...item, label: e.target.value } : item))}
                placeholder="Label"
                className="rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
              />
              <button
                onClick={() => setContacts((prev) => prev.filter((_, i) => i !== index))}
                className="rounded-lg border border-cream-300 text-bark-400 hover:text-red-500"
              >
                <Trash2 className="mx-auto h-4 w-4" />
              </button>
            </div>
          ))}
          {contacts.length === 0 && <p className="text-sm text-bark-300">No contact methods yet.</p>}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-primary gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Save Person
        </button>
        {message && <p className="text-sm text-bark-400">{message}</p>}
      </div>
    </div>
  );
}
