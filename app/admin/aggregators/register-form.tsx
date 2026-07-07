'use client';

/**
 * app/admin/aggregators/register-form.tsx — aggregator registration form
 * (campfit#93 R1/AC1, Wave 3 Task 3.2).
 *
 * A collapsible inline form mounted directly on `/admin/aggregators`
 * (`page.tsx`) rather than a separate `/admin/aggregators/new` route — this
 * task's file list has no `new/` subdirectory, unlike
 * `app/admin/providers/new/provider-new-form.tsx`'s dedicated page, so the
 * "+ Register aggregator" affordance toggles this form open in place
 * (mirrors `first-crawl-offer.tsx`'s own idle→running→done state-machine
 * shape for the toggle, and `provider-new-form.tsx`'s controlled-input/
 * saving/error field conventions for the form itself).
 *
 * Calls the Wave 3 `POST /api/admin/aggregators` route per the plan's
 * declared contract (`{name, url, communitySlug, maxPages, maxDepth}` →
 * `201` with the created row, `400` on an invalid URL) — that route is
 * owned by a parallel worker and may not exist yet at the time this file is
 * authored; this component is coded directly against the plan's contract
 * (`aggregator-discovery--plan.md`, Wave 3 Task 3.2's Changes/Acceptance)
 * and will need no changes once the route lands unless its shape diverges
 * from that contract (reconciliation note: verify the success/`400` body
 * shape matches once the route ships).
 *
 * Validation + payload-shaping logic lives in `./aggregators-view.ts` (pure
 * functions, no React) so it has a real unit-test surface — this
 * component's own interactivity is the standing campfit#96 accepted gap (no
 * jsdom/testing-library harness in this repo).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronUp, Loader2 } from 'lucide-react';
import { isValidHttpUrl } from '@/lib/admin/onboarding-validation';
import {
  buildRegisterPayload,
  canSubmitRegisterForm,
  emptyRegisterFormState,
  type RegisterAggregatorFormState,
} from './aggregators-view';

export function RegisterAggregatorForm({ defaultCommunitySlug }: { defaultCommunitySlug: string }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [form, setForm] = useState<RegisterAggregatorFormState>(emptyRegisterFormState(defaultCommunitySlug));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const urlValid = isValidHttpUrl(form.url.trim() || null);
  const canSubmit = canSubmitRegisterForm(form, (value) => isValidHttpUrl(value));

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/aggregators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRegisterPayload(form, defaultCommunitySlug)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? 'Failed to register aggregator');
      }
      setForm(emptyRegisterFormState(defaultCommunitySlug));
      setExpanded(false);
      if (data?.id) {
        router.push(`/admin/aggregators/${data.id}`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register aggregator');
    } finally {
      setSaving(false);
    }
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-pine-600 hover:bg-pine-700 text-cream-100 text-sm font-semibold rounded-xl transition-colors"
      >
        <span className="text-lg leading-none">+</span>
        Register aggregator
      </button>
    );
  }

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-bold text-bark-700">Register a new aggregator</h2>
        <button onClick={() => setExpanded(false)} className="text-bark-300 hover:text-bark-500">
          <ChevronUp className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" required>
          <input
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="Aggregator site name"
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
        <Field label="URL" required className="sm:col-span-2">
          <input
            value={form.url}
            onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
            placeholder="https://..."
          />
          {!urlValid && <p className="mt-1 text-xs text-red-600">Must be a valid http(s) URL</p>}
        </Field>
        <Field label="Max pages">
          <input
            type="number"
            min={1}
            value={form.maxPages}
            onChange={(event) => setForm((current) => ({ ...current, maxPages: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Max depth">
          <input
            type="number"
            min={1}
            value={form.maxDepth}
            onChange={(event) => setForm((current) => ({ ...current, maxDepth: event.target.value }))}
            className="w-full rounded-lg border border-cream-300 bg-cream-50 px-3 py-2 text-sm"
          />
        </Field>
      </div>

      <p className="mt-4 text-xs text-bark-400">
        Registering does not crawl anything. Discovery stays blocked until an admin records a ToS review decision
        on the aggregator&apos;s detail page.
      </p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={saving || !canSubmit}
          className="inline-flex items-center gap-2 rounded-xl bg-pine-600 px-4 py-2 text-sm font-semibold text-cream-50 transition-colors hover:bg-pine-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Register aggregator
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
