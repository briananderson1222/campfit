'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';

export function NewProviderForm({ defaultCommunitySlug }: { defaultCommunitySlug: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    websiteUrl: '',
    crawlRootUrl: '',
    city: '',
    address: '',
    neighborhood: '',
    contactEmail: '',
    contactPhone: '',
    notes: '',
    communitySlug: defaultCommunitySlug,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          websiteUrl: form.websiteUrl.trim() || null,
          crawlRootUrl: form.crawlRootUrl.trim() || null,
          city: form.city.trim() || null,
          address: form.address.trim() || null,
          neighborhood: form.neighborhood.trim() || null,
          contactEmail: form.contactEmail.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          notes: form.notes.trim() || null,
          communitySlug: form.communitySlug.trim() || defaultCommunitySlug,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Failed to create provider');
      router.push(`/admin/providers/${data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create provider');
      setSaving(false);
    }
  }

  return (
    <div className="glass-panel p-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          <input
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="Provider name"
          />
        </Field>
        <Field label="Community">
          <input
            value={form.communitySlug}
            onChange={(event) => setForm((current) => ({ ...current, communitySlug: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="denver"
          />
        </Field>
        <Field label="Website URL">
          <input
            value={form.websiteUrl}
            onChange={(event) => setForm((current) => ({ ...current, websiteUrl: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="https://..."
          />
        </Field>
        <Field label="Crawl Root URL">
          <input
            value={form.crawlRootUrl}
            onChange={(event) => setForm((current) => ({ ...current, crawlRootUrl: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="Optional listing/root page"
          />
        </Field>
        <Field label="City">
          <input
            value={form.city}
            onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Neighborhood">
          <input
            value={form.neighborhood}
            onChange={(event) => setForm((current) => ({ ...current, neighborhood: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Address">
          <input
            value={form.address}
            onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Contact Email">
          <input
            value={form.contactEmail}
            onChange={(event) => setForm((current) => ({ ...current, contactEmail: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Contact Phone">
          <input
            value={form.contactPhone}
            onChange={(event) => setForm((current) => ({ ...current, contactPhone: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <textarea
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            rows={4}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm resize-none"
          />
        </Field>
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={saving || !form.name.trim()}
          className="inline-flex items-center gap-2 rounded-xl bg-pine-600 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Create provider
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  required = false,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-bark-300">
        {label}{required ? ' *' : ''}
      </label>
      {children}
    </div>
  );
}
