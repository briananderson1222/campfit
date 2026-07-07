'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { isValidHttpUrl } from '@/lib/admin/onboarding-validation';
import { CAMP_TYPE_LABELS, CATEGORY_LABELS } from '@/lib/types';
import type { CampType, CampCategory } from '@/lib/types';

type ProviderOption = { id: string; name: string };

export function NewCampForm({
  providers,
  defaultProviderId = '',
}: {
  providers: ProviderOption[];
  defaultProviderId?: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    providerId: defaultProviderId,
    campType: '' as CampType | '',
    category: '' as CampCategory | '',
    websiteUrl: '',
    city: '',
    neighborhood: '',
    address: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlValid = isValidHttpUrl(form.websiteUrl.trim() || null);
  const showUrlError = form.websiteUrl.trim().length > 0 && !urlValid;
  const canSubmit = Boolean(
    form.name.trim() && form.providerId && form.campType && form.category && urlValid,
  );

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/camps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          providerId: form.providerId,
          campType: form.campType,
          category: form.category,
          websiteUrl: form.websiteUrl.trim() || null,
          city: form.city.trim() || null,
          neighborhood: form.neighborhood.trim() || null,
          address: form.address.trim() || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? 'Failed to create camp');
      router.push(`/admin/camps/${data.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create camp');
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
            placeholder="Camp name"
          />
        </Field>
        <Field label="Provider" required>
          <select
            value={form.providerId}
            onChange={(event) => setForm((current) => ({ ...current, providerId: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          >
            <option value="">Select a provider…</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          {providers.length === 0 && (
            <p className="mt-1 text-xs text-red-600">No providers exist yet — create a provider first.</p>
          )}
        </Field>
        <Field label="Camp Type" required>
          <select
            value={form.campType}
            onChange={(event) => setForm((current) => ({ ...current, campType: event.target.value as CampType }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          >
            <option value="">Select a type…</option>
            {Object.entries(CAMP_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Category" required>
          <select
            value={form.category}
            onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as CampCategory }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          >
            <option value="">Select a category…</option>
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Website URL">
          <input
            value={form.websiteUrl}
            onChange={(event) => setForm((current) => ({ ...current, websiteUrl: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="https://..."
          />
          {showUrlError && (
            <p className="mt-1 text-xs text-red-600">Must be a valid http(s) URL</p>
          )}
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
      </div>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          className="inline-flex items-center gap-2 rounded-xl bg-pine-600 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Create camp
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
